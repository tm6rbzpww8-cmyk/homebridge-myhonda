import { HondaAuth, quotePreservingBase64Chars } from '../../src/api/auth';
import { DeviceKey } from '../../src/api/crypto';
import { HttpClient, HttpResponse } from '../../src/api/httpClient';
import { HondaAccountLockedError, HondaAuthError, HondaVerificationRequiredError } from '../../src/api/errors';

function fakeHttpClient(responses: Record<string, HttpResponse<any>>): HttpClient {
  const calls: { path: string; options: any }[] = [];
  const client = {
    request: jest.fn(async (path: string, options: any = {}) => {
      calls.push({ path, options });
      const key = `${options.method ?? 'GET'} ${path.split('?')[0]}`;
      const response = responses[key];
      if (!response) {
        throw new Error(`No fake response configured for ${key}`);
      }
      return response;
    }),
  } as unknown as HttpClient;
  (client as any).calls = calls;
  return client;
}

describe('HondaAuth.login', () => {
  it('performs initiate-login then complete-login and returns tokens', async () => {
    const http = fakeHttpClient({
      'POST /auth/initiate-login': {
        statusCode: 200,
        raw: '{}',
        body: { transactionId: 'txn-1', signatureChallenge: 'challenge-1' },
      },
      'POST /auth/complete-login': {
        statusCode: 200,
        raw: '{}',
        body: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 },
      },
    });
    const auth = new HondaAuth(http, DeviceKey.generate());

    const tokens = await auth.login('user@example.com', 'hunter2', 'en-GB');

    expect(tokens).toEqual({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
    const calls = (http as any).calls as { path: string }[];
    expect(calls[0].path).toBe('/auth/initiate-login');
    expect(calls[1].path).toBe('/auth/complete-login');
  });

  it('throws HondaVerificationRequiredError when the device is not registered', async () => {
    const http = fakeHttpClient({
      'POST /auth/initiate-login': {
        statusCode: 400,
        raw: '{"errorCode":"device-authenticator-not-registered"}',
        body: {},
      },
    });
    const auth = new HondaAuth(http, DeviceKey.generate());

    await expect(auth.login('user@example.com', 'hunter2')).rejects.toBeInstanceOf(HondaVerificationRequiredError);
  });

  it('throws HondaAccountLockedError when Honda reports a locked account', async () => {
    const http = fakeHttpClient({
      'POST /auth/initiate-login': {
        statusCode: 423,
        raw: '{"errorCode":"locked-account"}',
        body: {},
      },
    });
    const auth = new HondaAuth(http, DeviceKey.generate());

    await expect(auth.login('user@example.com', 'hunter2')).rejects.toBeInstanceOf(HondaAccountLockedError);
  });

  it('throws a generic HondaAuthError for other failures', async () => {
    const http = fakeHttpClient({
      'POST /auth/initiate-login': { statusCode: 500, raw: 'server error', body: {} },
    });
    const auth = new HondaAuth(http, DeviceKey.generate());

    await expect(auth.login('user@example.com', 'hunter2')).rejects.toBeInstanceOf(HondaAuthError);
  });
});

describe('HondaAuth.completeDeviceVerification', () => {
  it('resolves the verification link then logs in', async () => {
    const http = fakeHttpClient({
      'GET /auth/verify-link': { statusCode: 200, raw: '{}', body: {} },
      'POST /auth/initiate-login': {
        statusCode: 200,
        raw: '{}',
        body: { transactionId: 't', signatureChallenge: 'c' },
      },
      'POST /auth/complete-login': {
        statusCode: 200,
        raw: '{}',
        body: { access_token: 'a', refresh_token: 'r', expires_in: 3600 },
      },
    });
    const auth = new HondaAuth(http, DeviceKey.generate());

    const tokens = await auth.completeDeviceVerification(
      'user@example.com',
      'hunter2',
      'https://mobile-api.connected.honda-eu.com/auth/verify-link?type=mfa&key=abc123',
    );

    expect(tokens.access_token).toBe('a');
  });

  it('rejects an unparsable verification link before making any request', async () => {
    const http = fakeHttpClient({});
    const auth = new HondaAuth(http, DeviceKey.generate());

    await expect(auth.completeDeviceVerification('u@example.com', 'p', 'not-a-url')).rejects.toBeInstanceOf(HondaAuthError);
  });

  it('sends the verification key with +, /, = left unescaped, matching the reference client', async () => {
    // The reference (pymyhondaplus) builds this URL with
    // urllib.parse.quote(key, safe="+/="), so a base64-shaped key must
    // reach Honda's server with '+', '/', '=' as literal characters, not
    // percent-encoded — see src/api/auth.ts quotePreservingBase64Chars().
    const http = fakeHttpClient({
      'GET /auth/verify-link': { statusCode: 200, raw: '{}', body: {} },
      'POST /auth/initiate-login': {
        statusCode: 200,
        raw: '{}',
        body: { transactionId: 't', signatureChallenge: 'c' },
      },
      'POST /auth/complete-login': {
        statusCode: 200,
        raw: '{}',
        body: { access_token: 'a', refresh_token: 'r', expires_in: 3600 },
      },
    });
    const auth = new HondaAuth(http, DeviceKey.generate());

    await auth.completeDeviceVerification(
      'user@example.com',
      'hunter2',
      'https://mobile-api.connected.honda-eu.com/auth/verify-link?type=mfa&key=ab%2Bc%2Fd%3D%3D',
    );

    const calls = (http as any).calls as { path: string; options: any }[];
    const verifyCall = calls.find((c) => c.path.startsWith('/auth/verify-link'));
    expect(verifyCall?.path).toBe('/auth/verify-link?type=mfa&key=ab+c/d==&dontRedirect=true');
  });
});

describe('quotePreservingBase64Chars', () => {
  it('leaves the base64 alphabet (+, /, =) unescaped', () => {
    expect(quotePreservingBase64Chars('ab+c/d==')).toBe('ab+c/d==');
  });

  it('leaves letters, digits, and _.-~ unescaped', () => {
    expect(quotePreservingBase64Chars('abc123_.-~XYZ')).toBe('abc123_.-~XYZ');
  });

  it('percent-encodes characters outside the safe set, e.g. space and &', () => {
    expect(quotePreservingBase64Chars('a b&c')).toBe('a%20b%26c');
  });
});

describe('HondaAuth.refresh', () => {
  it('returns fresh tokens on success', async () => {
    const http = fakeHttpClient({
      'POST /auth/isv-prod/refresh': {
        statusCode: 200,
        raw: '{}',
        body: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3599 },
      },
    });
    const auth = new HondaAuth(http, DeviceKey.generate());

    const result = await auth.refresh('old-refresh');
    expect(result.access_token).toBe('new-access');
  });

  it('throws HondaAuthError when the refresh token is rejected', async () => {
    const http = fakeHttpClient({
      'POST /auth/isv-prod/refresh': { statusCode: 401, raw: 'invalid_grant', body: {} },
    });
    const auth = new HondaAuth(http, DeviceKey.generate());

    await expect(auth.refresh('bad-refresh')).rejects.toBeInstanceOf(HondaAuthError);
  });
});
