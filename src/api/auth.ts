/**
 * Honda Connect Europe ("My Honda+") authentication flow.
 *
 * Honda's login is a two-step, device-bound challenge/response:
 *   1. `initiate-login` — send encrypted email+password+device public key.
 *      Honda responds with a transaction id and a signature challenge
 *      *if* this device's public key is already registered on the
 *      account. If not, it responds with a `device-authenticator-not-registered`
 *      error instead.
 *   2. `complete-login` — sign the challenge with the device's private key
 *      and send it back (still inside the encrypted envelope) to receive
 *      access/refresh tokens.
 *
 * First-time device registration is a separate, human-in-the-loop flow:
 * Honda emails a "magic link" that must be requested via
 * `reset-device-authenticator` + `verify-link`, then resolved (GET, with
 * `dontRedirect=true`) once the user has it. This cannot be automated
 * without access to the user's inbox, so the plugin surfaces a clear,
 * one-time instruction (see HondaVerificationRequiredError) asking the
 * user to paste the link into their Homebridge config.
 */

import { HttpClient, HttpResponse } from './httpClient';
import { DeviceKey, encryptRequest } from './crypto';
import { logAuthFailureDiagnostics } from './diagnostics';
import { HondaClientLogger } from './logger';
import {
  HondaAccountLockedError,
  HondaAuthError,
  HondaVerificationRequiredError,
} from './errors';
import { InitiateLoginResponse, RawLoginTokens, RefreshTokenResponse } from './types';

const NOOP_LOGGER: HondaClientLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface AuthHeaders extends Record<string, string> {
  'user-agent': string;
  'accept-encoding': string;
  accept: string;
  'content-type': string;
  'x-app-device-os': string;
  'x-app-device-osversion': string;
  'x-app-device-model': string;
}

/**
 * The reference client (pymyhondaplus) builds its HTTP session with
 * Python's `requests` library, which — on top of whatever headers the
 * project explicitly sets — always adds an `Accept: * / *` header of its
 * own by default. Every real request that reference client has ever sent
 * Honda therefore carries that header, even though it's never listed in
 * its own DEFAULT_HEADERS dict. undici (used here) does not add a default
 * Accept header, so it was silently missing from every request this
 * plugin sent — confirmed by capturing the literal wire bytes of both
 * clients hitting a local echo server side by side. Honda's edge/gateway
 * rejects a request without it with a bare HTTP 400, before the app layer
 * even attempts to decrypt the payload.
 */
export function defaultAuthHeaders(deviceModel: string): AuthHeaders {
  return {
    'user-agent': 'okhttp/4.12.0',
    'accept-encoding': 'gzip',
    accept: '*/*',
    'content-type': 'application/json',
    'x-app-device-os': 'android',
    'x-app-device-osversion': '26',
    'x-app-device-model': deviceModel,
  };
}

export interface LoginResult {
  tokens: RawLoginTokens;
}

/**
 * Honda's `/auth/initiate-login` and `/auth/complete-login` endpoints
 * expect `locale` as a bare, lowercase ISO 639-1 language code — "en",
 * "it", "de" — never a full BCP-47 tag like "en-GB". Sending anything else
 * fails validation with HTTP 400 before Honda even attempts to decrypt the
 * payload. The reference client (pymyhondaplus) never sends anything but a
 * bare code here, matching its own documented `--locale de` / `--locale it`
 * CLI usage.
 *
 * The rest of this plugin's config format (and Honda's separate
 * `/tsp`/`/user` query-string `language`/`country` parameters) are
 * unaffected — this only normalizes the value going into the encrypted
 * auth payload, so a config value like "en-GB" keeps working unchanged.
 */
export function toHondaLocale(locale: string): string {
  const language = locale.split('-')[0]?.trim().toLowerCase();
  return language || 'en';
}

export class HondaAuth {
  constructor(
    private readonly http: HttpClient,
    private readonly deviceKey: DeviceKey,
    private readonly log: HondaClientLogger = NOOP_LOGGER,
  ) {}

  async initiateLogin(email: string, password: string, locale: string): Promise<InitiateLoginResponse> {
    const payload = encryptRequest({
      emailAddress: email,
      userPassword: password,
      devicePublicKey: this.deviceKey.publicKeyB64,
      keyIdentifier: this.deviceKey.keyIdentifier,
      locale: toHondaLocale(locale),
      fingerprintSupport: false,
      frontCameraSupport: false,
      faceSupport: false,
      pushToken: '',
      deviceId: 'homebridge',
      deviceName: 'Homebridge',
      deviceType: 'Homebridge',
      platformType: 'android',
      osVersion: '26',
      applicationId: 'com.honda_eu.connected.app',
      applicationVersion: '3.0.0',
    });

    const res = await this.http.request<InitiateLoginResponse & { errorCode?: string; error?: string }>(
      '/auth/initiate-login',
      { method: 'POST', json: payload },
    );

    if (res.statusCode === 200 || res.statusCode === 202) {
      return res.body;
    }

    this.throwAuthError('initiate-login', res, [email, password]);
  }

  async completeLogin(
    email: string,
    password: string,
    transactionId: string,
    signatureChallenge: string,
    locale: string,
  ): Promise<RawLoginTokens> {
    const signedChallenge = this.deviceKey.sign(signatureChallenge);

    const payload = encryptRequest({
      emailAddress: email,
      userPassword: password,
      keyIdentifier: this.deviceKey.keyIdentifier,
      identityProvider: 'isv-prod',
      locale: toHondaLocale(locale),
      transactionId,
      signedChallengeResponse: signedChallenge,
    });

    const res = await this.http.request<RawLoginTokens>('/auth/complete-login', {
      method: 'POST',
      json: payload,
    });

    if (res.statusCode === 200 || res.statusCode === 202) {
      return res.body;
    }

    this.throwAuthError('complete-login', res, [email, password]);
  }

  /**
   * Full login attempt for an already-registered device. Throws
   * HondaVerificationRequiredError if this device key has never been
   * registered on the account (first run) — the caller should then use
   * `requestDeviceVerificationEmail` + `completeDeviceVerification`.
   */
  async login(email: string, password: string, locale = 'en-GB'): Promise<RawLoginTokens> {
    const { transactionId, signatureChallenge } = await this.initiateLogin(email, password, locale);
    return this.completeLogin(email, password, transactionId, signatureChallenge, locale);
  }

  /** Kicks off Honda's email verification flow for a brand-new device. */
  async requestDeviceVerificationEmail(email: string, password: string): Promise<void> {
    const resetPayload = encryptRequest({
      emailAddress: email,
      userPassword: password,
      resetType: 'Add',
      devicePublicKey: this.deviceKey.publicKeyB64,
      keyIdentifier: this.deviceKey.keyIdentifier,
    });

    const resetRes = await this.http.request('/auth/reset-device-authenticator', {
      method: 'POST',
      json: resetPayload,
    });

    // "currently blocked" means a verification email was already requested
    // recently and is presumably still sitting in the user's inbox — not a
    // hard failure, so don't throw.
    if (
      resetRes.statusCode !== 200 &&
      resetRes.statusCode !== 202 &&
      !resetRes.raw.includes('currently blocked')
    ) {
      this.throwAuthError('reset-device-authenticator', resetRes, [email, password]);
    }
  }

  /**
   * Resolves a magic-link URL the user pasted from their verification
   * email, registering this device, then completes login.
   */
  async completeDeviceVerification(
    email: string,
    password: string,
    verificationLink: string,
    locale = 'en-GB',
  ): Promise<RawLoginTokens> {
    const { key, type } = parseVerificationLink(verificationLink);
    if (!key) {
      // Deliberately does not include verificationLink (or any substring of
      // it) in this message: a link that fails to parse as a URL may still
      // contain the one-time verification key as raw text, and this error
      // can surface all the way up to a Homebridge log line.
      throw new HondaAuthError(
        'Could not find a "key" parameter in the provided verification link. Make sure you pasted the complete ' +
        'URL from Honda\'s verification email (the whole address bar contents, starting with "https://"), not ' +
        'just part of it.',
      );
    }

    // The reference client percent-encodes the key with Python's
    // urllib.parse.quote(key, safe="+/="), i.e. it leaves '+', '/', '=' as
    // literal characters instead of escaping them. encodeURIComponent
    // would escape those, producing a different (though technically
    // equivalent once percent-decoded) query string — match the reference
    // byte-for-byte rather than relying on Honda's server decoding both
    // forms the same way.
    const url = `/auth/verify-link?type=${encodeURIComponent(type)}&key=${quotePreservingBase64Chars(key)}&dontRedirect=true`;
    const verifyRes = await this.http.request(url, { method: 'GET' });
    if (verifyRes.statusCode >= 400) {
      throw new HondaAuthError(
        `Verification link could not be confirmed with Honda (HTTP ${verifyRes.statusCode}). It may have expired — request a new one.`,
        verifyRes.statusCode,
        verifyRes.raw,
      );
    }

    return this.login(email, password, locale);
  }

  async refresh(refreshToken: string): Promise<RefreshTokenResponse> {
    const res = await this.http.request<RefreshTokenResponse>('/auth/isv-prod/refresh', {
      method: 'POST',
      json: { refreshToken },
    });

    if (res.statusCode === 200) {
      return res.body;
    }

    throw new HondaAuthError(
      `Failed to refresh Honda access token (HTTP ${res.statusCode}). You may need to log in again.`,
      res.statusCode,
      res.raw,
    );
  }

  /**
   * Classifies and throws for a failed auth HTTP call. Always logs a
   * sanitized diagnostic first (status, allow-listed response headers,
   * secret-scrubbed body) — this is what makes an otherwise-opaque "HTTP
   * 400" actionable without needing another live round-trip to find out
   * what Honda actually said.
   */
  private throwAuthError(
    step: string,
    response: Pick<HttpResponse<unknown>, 'statusCode' | 'headers' | 'raw'>,
    secrets: Array<string | undefined> = [],
  ): never {
    logAuthFailureDiagnostics(this.log, { step, response, secrets });

    const { statusCode, raw: body } = response;
    if (body.includes('locked-account')) {
      throw new HondaAccountLockedError();
    }
    if (body.includes('device-authenticator-not-registered')) {
      throw new HondaVerificationRequiredError();
    }
    throw new HondaAuthError(`Honda ${step} failed (HTTP ${statusCode})`, statusCode, body);
  }
}

// Characters Python's urllib.parse.quote() never escapes, with no `safe`
// argument at all: ASCII letters, digits, and "_.-~".
const PYTHON_QUOTE_ALWAYS_SAFE = /[A-Za-z0-9_.\-~]/;

/**
 * Percent-encodes `value` the way the reference client's
 * `urllib.parse.quote(value, safe="+/=")` does: only bytes outside
 * {A-Z a-z 0-9 _ . - ~ + / =} get escaped, everything else — including the
 * base64 alphabet's '+', '/', and padding '=' — is left as a literal
 * character in the URL.
 */
export function quotePreservingBase64Chars(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  let out = '';
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (byte < 128 && (PYTHON_QUOTE_ALWAYS_SAFE.test(ch) || ch === '+' || ch === '/' || ch === '=')) {
      out += ch;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

export function parseVerificationLink(link: string): { key: string; type: string } {
  try {
    const url = new URL(link);
    return {
      key: url.searchParams.get('key') ?? '',
      type: url.searchParams.get('type') ?? 'mfa',
    };
  } catch {
    return { key: '', type: 'mfa' };
  }
}
