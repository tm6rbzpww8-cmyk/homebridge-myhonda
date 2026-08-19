/**
 * Persists Honda auth tokens and the device RSA keypair to disk between
 * Homebridge restarts, so the user only has to complete the (interactive,
 * email-verification-gated) login once.
 *
 * Files are written with 0600 permissions into Homebridge's persist
 * directory. This is not encryption at rest (Homebridge itself has no
 * standard secret-storage API), but it does keep the credentials out of
 * the plugin config file (which users routinely paste into support
 * threads, screenshots, etc.) and restricts filesystem access to the
 * owning user, matching the approach taken by comparable Homebridge
 * plugins for other cloud-connected accessories.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  personalId: string;
  userId: string;
}

export interface StoredDeviceKey {
  privateKeyPem: string;
}

export class TokenStore {
  private readonly tokensFile: string;
  private readonly deviceKeyFile: string;

  constructor(storagePath: string, accountKey: string) {
    const dir = path.join(storagePath, 'myhonda');
    this.tokensFile = path.join(dir, `${accountKey}.tokens.json`);
    this.deviceKeyFile = path.join(dir, `${accountKey}.devicekey.pem`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  loadTokens(): StoredTokens | undefined {
    return this.readJsonSecure<StoredTokens>(this.tokensFile);
  }

  saveTokens(tokens: StoredTokens): void {
    this.writeSecure(this.tokensFile, JSON.stringify(tokens));
  }

  clearTokens(): void {
    this.removeIfExists(this.tokensFile);
  }

  loadDeviceKeyPem(): string | undefined {
    if (!fs.existsSync(this.deviceKeyFile)) {
      return undefined;
    }
    return fs.readFileSync(this.deviceKeyFile, 'utf8');
  }

  saveDeviceKeyPem(pem: string): void {
    this.writeSecure(this.deviceKeyFile, pem);
  }

  private readJsonSecure<T>(file: string): T | undefined {
    if (!fs.existsSync(file)) {
      return undefined;
    }
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  private writeSecure(file: string, contents: string): void {
    fs.writeFileSync(file, contents, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }

  private removeIfExists(file: string): void {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}
