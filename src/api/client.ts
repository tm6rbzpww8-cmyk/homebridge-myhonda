/**
 * High-level Honda Connect Europe ("My Honda+") API client.
 *
 * Owns: token lifecycle (login/refresh/persistence), authenticated
 * requests, dashboard fetch + parsing, and remote command dispatch
 * (including polling Honda's async-command-status endpoint until the
 * vehicle's TCU responds or the request times out).
 *
 * This is the only module in the plugin that knows about Honda's HTTP
 * endpoints — the HomeKit accessory layer talks exclusively to this class.
 */

import { HttpClient, API_BASE } from './httpClient';
import { DeviceKey } from './crypto';
import { HondaAuth, defaultAuthHeaders } from './auth';
import { StoredTokens, TokenStore } from './tokenStore';
import { EvStatus, parseEvStatus } from './dashboard';
import { CapabilityName, parseVehicle, Vehicle } from './vehicle';
import { redactVinInPath } from './redact';
import { HondaClientLogger } from './logger';
import {
  AsyncCommandAccepted,
  AsyncCommandStatusResponse,
  RawDashboardResponse,
  RawLoginTokens,
  RawUserInfoResponse,
} from './types';
import {
  HondaApiError,
  HondaAuthError,
  HondaCapabilityError,
  HondaVehicleUnreachableError,
} from './errors';

export type { HondaClientLogger } from './logger';

export interface HondaClientConfig {
  email: string;
  password: string;
  locale?: string;
  deviceModel?: string;
  requestTimeoutMs?: number;
  storagePath: string;
  log: HondaClientLogger;
}

export type CommandOutcome = 'success' | 'failed' | 'timedOut';

export interface CommandResult {
  outcome: CommandOutcome;
  reason?: string;
}

const DEFAULT_LOCALE = 'en-GB';
const DEFAULT_DEVICE_MODEL = 'Homebridge';
const COMMAND_POLL_INTERVAL_MS = 2000;
const COMMAND_POLL_TIMEOUT_MS = 90_000;

function accountKey(email: string): string {
  // Filesystem-safe, stable per-account key. Not a security boundary —
  // just avoids collisions between multiple Honda accounts on one instance.
  return email.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
}

export class HondaApiClient {
  private readonly http: HttpClient;
  private readonly auth: HondaAuth;
  private readonly tokenStore: TokenStore;
  private readonly deviceKey: DeviceKey;
  private readonly log: HondaClientLogger;
  private readonly locale: string;

  private accessToken = '';
  private refreshToken = '';
  private expiresAt = 0;
  private personalId = '';
  private userId = '';

  constructor(private readonly config: HondaClientConfig) {
    this.log = config.log;
    this.locale = config.locale ?? DEFAULT_LOCALE;
    this.tokenStore = new TokenStore(config.storagePath, accountKey(config.email));

    const existingKeyPem = this.tokenStore.loadDeviceKeyPem();
    if (existingKeyPem) {
      this.deviceKey = DeviceKey.fromPem(existingKeyPem);
    } else {
      this.deviceKey = DeviceKey.generate();
      this.tokenStore.saveDeviceKeyPem(this.deviceKey.toPem());
    }

    this.http = new HttpClient(defaultAuthHeaders(config.deviceModel ?? DEFAULT_DEVICE_MODEL));
    this.auth = new HondaAuth(this.http, this.deviceKey, this.log);

    const stored = this.tokenStore.loadTokens();
    if (stored) {
      this.applyStoredTokens(stored);
    }
  }

  get isAuthenticated(): boolean {
    return this.accessToken !== '' && this.refreshToken !== '';
  }

  /** Attempts to restore a session from persisted tokens, refreshing if the access token has expired. */
  async restoreSession(): Promise<boolean> {
    if (!this.isAuthenticated) {
      return false;
    }
    try {
      await this.ensureFreshToken();
      return true;
    } catch (err) {
      this.log.warn('Stored Honda session could not be restored: %s', (err as Error).message);
      return false;
    }
  }

  /** First-time or re-login using email/password. Throws HondaVerificationRequiredError if this device isn't registered yet. */
  async login(): Promise<void> {
    const tokens = await this.auth.login(this.config.email, this.config.password, this.locale);
    this.storeTokens(tokens);
  }

  /** Sends Honda's email verification link for a brand-new device. */
  async requestDeviceVerificationEmail(): Promise<void> {
    await this.auth.requestDeviceVerificationEmail(this.config.email, this.config.password);
  }

  /** Completes device registration using a verification link the user pasted from their email, then logs in. */
  async completeDeviceVerification(verificationLink: string): Promise<void> {
    const tokens = await this.auth.completeDeviceVerification(
      this.config.email,
      this.config.password,
      verificationLink,
      this.locale,
    );
    this.storeTokens(tokens);
  }

  async getVehicles(): Promise<Vehicle[]> {
    const info = await this.authedRequest<RawUserInfoResponse>('GET', this.userInfoPath());
    // Honda's get-login-info response carries the account-scoped personalId
    // used as the x-app-personal-id header on subsequent /tsp requests (it
    // is never present in the login/refresh token response). Capture it
    // here, the first authenticated call made after signing in.
    if (info.personalId && info.personalId !== this.personalId) {
      this.personalId = info.personalId;
      this.persistTokens();
    }
    return (info.vehiclesInfo ?? [])
      .map(parseVehicle)
      .filter((v): v is Vehicle => v !== undefined);
  }

  async getDashboard(vin: string): Promise<EvStatus> {
    const raw = await this.authedRequest<RawDashboardResponse>(
      'GET',
      `/tsp/dashboard-latest?vin=${encodeURIComponent(vin)}&languageCode=${this.languageCode()}`,
    );
    return parseEvStatus(raw);
  }

  /** Wakes the vehicle's TCU and requests fresh EV/charge/climate data (not GPS — see refreshLocation). */
  async refreshDashboard(vin: string): Promise<CommandResult> {
    const commandId = await this.postAsyncCommand(`/tsp/dashboard?vin=${encodeURIComponent(vin)}`);
    return this.waitForCommand(commandId);
  }

  async refreshLocation(vin: string): Promise<CommandResult> {
    const commandId = await this.postAsyncCommand(`/tsp/car-location?vin=${encodeURIComponent(vin)}`);
    return this.waitForCommand(commandId);
  }

  async lockDoors(vin: string, vehicle: Vehicle): Promise<CommandResult> {
    this.requireCapability(vehicle, 'remoteLock');
    const commandId = await this.postAsyncCommand(
      `/tsp/remote-lock?vin=${encodeURIComponent(vin)}`,
      { command: 'allLock' },
    );
    return this.waitForCommand(commandId);
  }

  async unlockDoors(vin: string, vehicle: Vehicle): Promise<CommandResult> {
    this.requireCapability(vehicle, 'remoteLock');
    const commandId = await this.postAsyncCommand(
      `/tsp/remote-lock?vin=${encodeURIComponent(vin)}`,
      { command: 'doorUnlock' },
    );
    return this.waitForCommand(commandId);
  }

  async startClimate(vin: string, vehicle: Vehicle): Promise<CommandResult> {
    this.requireCapability(vehicle, 'remoteClimate');
    const commandId = await this.postAsyncCommand(
      `/tsp/remote-climate?vin=${encodeURIComponent(vin)}`,
      { command: 'start', temperatureMode: 'specific', temperature: 0, autoDefrosterSetting: 'autoOn' },
    );
    return this.waitForCommand(commandId);
  }

  async stopClimate(vin: string, vehicle: Vehicle): Promise<CommandResult> {
    this.requireCapability(vehicle, 'remoteClimate');
    const commandId = await this.postAsyncCommand(
      `/tsp/remote-climate?vin=${encodeURIComponent(vin)}`,
      { command: 'stop' },
    );
    return this.waitForCommand(commandId);
  }

  async startCharging(vin: string, vehicle: Vehicle): Promise<CommandResult> {
    this.requireCapability(vehicle, 'remoteCharge');
    const commandId = await this.postAsyncCommand(
      `/tsp/remote-charge?vin=${encodeURIComponent(vin)}`,
      { command: 'start' },
    );
    return this.waitForCommand(commandId);
  }

  async stopCharging(vin: string, vehicle: Vehicle): Promise<CommandResult> {
    this.requireCapability(vehicle, 'remoteCharge');
    const commandId = await this.postAsyncCommand(
      `/tsp/remote-charge?vin=${encodeURIComponent(vin)}`,
      { command: 'stop' },
    );
    return this.waitForCommand(commandId);
  }

  async honkAndFlash(vin: string, vehicle: Vehicle): Promise<CommandResult> {
    this.requireCapability(vehicle, 'remoteHorn');
    const commandId = await this.postAsyncCommand(
      `/tsp/remote-horn-light?vin=${encodeURIComponent(vin)}`,
      { command: 'horn' },
    );
    return this.waitForCommand(commandId);
  }

  private requireCapability(vehicle: Vehicle, capability: CapabilityName): void {
    if (!vehicle.capabilities.has(capability)) {
      throw new HondaCapabilityError(
        `Vehicle ${vehicle.vin} does not report "${capability}" as an active capability; refusing to send the command.`,
      );
    }
  }

  private languageCode(): string {
    return this.locale.split('-')[0] ?? 'en';
  }

  private userInfoPath(): string {
    const country = this.locale.split('-')[1] ?? 'GB';
    return `/user/get-login-info?userid=${encodeURIComponent(this.userId)}&agreementType=1&country=${country}&language=${this.languageCode()}`;
  }

  private async postAsyncCommand(path: string, body?: unknown): Promise<string> {
    const res = await this.authedRequestRaw<AsyncCommandAccepted>('POST', path, body);
    const uri = res.statusQueryGetUri ?? '';
    const idMatch = uri.match(/[?&]id=([^&]+)/);
    if (!idMatch) {
      throw new HondaApiError(`Honda did not return a command id for ${redactVinInPath(path)}`);
    }
    return decodeURIComponent(idMatch[1]);
  }

  private async waitForCommand(commandId: string): Promise<CommandResult> {
    const deadline = Date.now() + COMMAND_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const res = await this.authedRequestRaw<AsyncCommandStatusResponse>(
        'GET',
        `/euw/tsp/async-command-status?id=${encodeURIComponent(commandId)}`,
      );
      const output = res.output;
      if (output) {
        if (output.functionTimedOut) {
          return { outcome: 'timedOut', reason: output.StatusReason };
        }
        if (output.RequestStatus === 'success') {
          return { outcome: 'success' };
        }
        if (output.RequestStatus && output.RequestStatus !== 'pending') {
          return { outcome: 'failed', reason: output.StatusReason ?? output.RequestStatus };
        }
      }
      await sleep(COMMAND_POLL_INTERVAL_MS);
    }
    this.log.warn('Gave up waiting for Honda command %s to complete after %dms', commandId, COMMAND_POLL_TIMEOUT_MS);
    return { outcome: 'timedOut' };
  }

  /** Convenience wrapper: throws HondaVehicleUnreachableError on a timed-out remote command. */
  static assertCommandSucceeded(result: CommandResult): void {
    if (result.outcome === 'timedOut') {
      throw new HondaVehicleUnreachableError();
    }
    if (result.outcome === 'failed') {
      throw new HondaApiError(`Honda reported the command failed${result.reason ? `: ${result.reason}` : ''}`);
    }
  }

  private async authedRequest<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return this.authedRequestRaw<T>(method, path, body);
  }

  private async authedRequestRaw<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    await this.ensureFreshToken();

    const doRequest = () =>
      this.http.request<T>(path, {
        method,
        json: body,
        headers: this.authHeaders(),
      });

    let res = await doRequest();
    if (res.statusCode === 401) {
      this.log.debug('Honda API returned 401; refreshing token and retrying once');
      await this.refreshAccessToken();
      res = await doRequest();
      if (res.statusCode === 401) {
        throw new HondaAuthError('Honda API rejected the request even after refreshing the access token; a full re-login is required.');
      }
    }

    if (res.statusCode >= 400) {
      throw new HondaApiError(`Honda API request failed (${method} ${redactVinInPath(path)}, HTTP ${res.statusCode})`, res.statusCode, res.raw);
    }

    return res.body;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.accessToken}` };
    if (this.personalId) {
      headers['x-app-personal-id'] = this.personalId;
    }
    return headers;
  }

  private async ensureFreshToken(): Promise<void> {
    if (!this.accessToken) {
      throw new HondaAuthError('Not authenticated with Honda yet.');
    }
    // 60s safety buffer so a request doesn't race an about-to-expire token.
    if (Date.now() >= this.expiresAt - 60_000) {
      await this.refreshAccessToken();
    }
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      throw new HondaAuthError('No refresh token available; a full re-login is required.');
    }
    const result = await this.auth.refresh(this.refreshToken);
    this.accessToken = result.access_token;
    this.refreshToken = result.refresh_token ?? this.refreshToken;
    this.expiresAt = Date.now() + (result.expires_in ?? 3599) * 1000;
    this.persistTokens();
  }

  private storeTokens(tokens: RawLoginTokens): void {
    // Honda's login/complete-login response carries only access_token,
    // refresh_token, and expires_in — no personalId or userId field. userId
    // is derived from the access token's JWT "sub" claim (as the reference
    // client does); personalId is only ever obtained later, from the
    // get-login-info response (see getVehicles()).
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
    this.expiresAt = Date.now() + (tokens.expires_in ?? 3599) * 1000;
    this.userId = extractUserIdFromJwt(this.accessToken);
    this.persistTokens();
  }

  private applyStoredTokens(stored: StoredTokens): void {
    this.accessToken = stored.accessToken;
    this.refreshToken = stored.refreshToken;
    this.expiresAt = stored.expiresAt;
    this.personalId = stored.personalId;
    this.userId = stored.userId || extractUserIdFromJwt(stored.accessToken);
  }

  private persistTokens(): void {
    this.tokenStore.saveTokens({
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt,
      personalId: this.personalId,
      userId: this.userId,
    });
  }
}

function extractUserIdFromJwt(accessToken: string): string {
  const parts = accessToken.split('.');
  if (parts.length < 2) {
    return '';
  }
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const decoded = JSON.parse(payload) as { sub?: string };
    return decoded.sub ?? '';
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { API_BASE };
