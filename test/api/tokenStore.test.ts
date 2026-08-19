import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TokenStore } from '../../src/api/tokenStore';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myhonda-tokenstore-'));
}

describe('TokenStore', () => {
  it('returns undefined when nothing has been saved yet', () => {
    const store = new TokenStore(tempDir(), 'user_example_com');
    expect(store.loadTokens()).toBeUndefined();
    expect(store.loadDeviceKeyPem()).toBeUndefined();
  });

  it('round-trips tokens through save/load', () => {
    const store = new TokenStore(tempDir(), 'user_example_com');
    const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: 12345, personalId: 'p', userId: 'u' };
    store.saveTokens(tokens);
    expect(store.loadTokens()).toEqual(tokens);
  });

  it('round-trips a device key PEM through save/load', () => {
    const store = new TokenStore(tempDir(), 'user_example_com');
    store.saveDeviceKeyPem('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n');
    expect(store.loadDeviceKeyPem()).toContain('BEGIN PRIVATE KEY');
  });

  it('writes token and key files with owner-only permissions', () => {
    const dir = tempDir();
    const store = new TokenStore(dir, 'user_example_com');
    store.saveTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: 1, personalId: '', userId: '' });
    store.saveDeviceKeyPem('pem');

    const tokensFile = path.join(dir, 'myhonda', 'user_example_com.tokens.json');
    const keyFile = path.join(dir, 'myhonda', 'user_example_com.devicekey.pem');
    expect(fs.statSync(tokensFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  it('clears saved tokens', () => {
    const store = new TokenStore(tempDir(), 'user_example_com');
    store.saveTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: 1, personalId: '', userId: '' });
    store.clearTokens();
    expect(store.loadTokens()).toBeUndefined();
  });

  it('keeps separate accounts in separate files', () => {
    const dir = tempDir();
    const storeA = new TokenStore(dir, 'account_a');
    const storeB = new TokenStore(dir, 'account_b');
    storeA.saveTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: 1, personalId: '', userId: '' });
    expect(storeB.loadTokens()).toBeUndefined();
  });
});
