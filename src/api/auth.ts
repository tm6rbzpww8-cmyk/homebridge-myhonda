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

import { HttpClient } from './httpClient';
import { DeviceKey, encryptRequest } from './crypto';
import {
  HondaAccountLockedError,
  HondaAuthError,
  HondaVerificationRequiredError,
} from './errors';
import { InitiateLoginResponse, RawLoginTokens, RefreshTokenResponse } from './types';

export interface AuthHeaders extends Record<string, string> {
  'user-agent': string;
  'accept-encoding': string;
  'content-type': string;
  'x-app-device-os': string;
  'x-app-device-osversion': string;
  'x-app-device-model': string;
}

export function defaultAuthHeaders(deviceModel: string): AuthHeaders {
  return {
    'user-agent': 'okhttp/4.12.0',
    'accept-encoding': 'gzip',
    'content-type': 'application/json',
    'x-app-device-os': 'android',
    'x-app-device-osversion': '26',
    'x-app-device-model': deviceModel,
  };
}

export interface LoginResult {
  tokens: RawLoginTokens;
}

export class HondaAuth {
  constructor(
    private readonly http: HttpClient,
    private readonly deviceKey: DeviceKey,
  ) {}

  async initiateLogin(email: string, password: string, locale: string): Promise<InitiateLoginResponse> {
    const payload = encryptRequest({
      emailAddress: email,
      userPassword: password,
      devicePublicKey: this.deviceKey.publicKeyB64,
      keyIdentifier: this.deviceKey.keyIdentifier,
      locale,
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

    this.throwAuthError('initiate-login', res.statusCode, res.raw);
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
      locale,
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

    this.throwAuthError('complete-login', res.statusCode, res.raw);
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
      this.throwAuthError('reset-device-authenticator', resetRes.statusCode, resetRes.raw);
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
      throw new HondaAuthError(`Could not parse a verification key out of the provided link: ${verificationLink}`);
    }

    const url = `/auth/verify-link?type=${encodeURIComponent(type)}&key=${encodeURIComponent(key)}&dontRedirect=true`;
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

  private throwAuthError(step: string, statusCode: number, body: string): never {
    if (body.includes('locked-account')) {
      throw new HondaAccountLockedError();
    }
    if (body.includes('device-authenticator-not-registered')) {
      throw new HondaVerificationRequiredError();
    }
    throw new HondaAuthError(`Honda ${step} failed (HTTP ${statusCode})`, statusCode, body);
  }
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
