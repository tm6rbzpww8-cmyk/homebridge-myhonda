import { HondaAuth, defaultAuthHeaders, quotePreservingBase64Chars, toHondaLocale } from '../../src/api/auth';
import { HttpClient, HttpResponse } from '../../src/api/httpClient';
import { HondaAccountLockedError, HondaAuthError, HondaVerificationRequiredError } from '../../src/api/errors';
import { HondaClientLogger } from '../../src/api/logger';

function fakeLogger(): HondaClientLogger {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

// Spy on encryptRequest so tests can inspect the *plaintext* payload
// HondaAuth builds before it's encrypted, while still exercising the real
// AES/RSA envelope (and the real DeviceKey) for everything else — the
// crypto layer itself is already covered by crypto.test.ts.
jest.mock('../../src/api/crypto', () => {
  const actual = jest.requireActual('../../src/api/crypto');
  return { ...actual, encryptRequest: jest.fn(actual.encryptRequest) };
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cryptoModule = require('../../src/api/crypto') as typeof import('../../src/api/crypto');
const { DeviceKey } = cryptoModule;

function lastEncryptedPayload(): Record<string, unknown> {
  const mock = cryptoModule.encryptRequest as jest.Mock;
  return mock.mock.calls[mock.mock.calls.length - 1][0];
}

type FakeResponse = Omit<HttpResponse<any>, 'headers'> & { headers?: Record<string, string> };

function fakeHttpClient(responses: Record<string, FakeResponse>): HttpClient {
  const calls: { path: string; options: any }[] = [];
  const client = {
    request: jest.fn(async (path: string, options: any = {}) => {
      calls.push({ path, options });
      const key = `${options.method ?? 'GET'} ${path.split('?')[0]}`;
      const response = responses[key];
      if (!response) {
        throw new Error(`No fake response configured for ${key}`);
      }
      return { headers: {}, ...response };
    }),
  } as unknown as HttpClient;
  (client as any).calls = calls;
  return client;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('toHondaLocale', () => {
  it('reduces a full BCP-47 tag to its bare lowercase language code', () => {
    expect(toHondaLocale('en-GB')).toBe('en');
    expect(toHondaLocale('de-DE')).toBe('de');
    expect(toHondaLocale('fr-FR')).toBe('fr');
  });

  it('leaves an already-bare code unchanged (lowercased)', () => {
    expect(toHondaLocale('it')).toBe('it');
    expect(toHondaLocale('IT')).toBe('it');
  });

  it('falls back to "en" for an empty value', () => {
    expect(toHondaLocale('')).toBe('en');
  });
});

describe('defaultAuthHeaders (regression for Honda HTTP 400 persisting after the locale fix)', () => {
  // Captured by comparing the literal wire bytes of this plugin's requests
  // against pymyhondaplus's (Python `requests`) hitting a local echo
  // server side by side: `requests.Session()` always adds an `Accept: * /
  // *` header on top of whatever the project's own DEFAULT_HEADERS dict
  // specifies, so every real request the reference client has ever sent
  // Honda carries it — even though it's absent from that dict. undici
  // (used here) adds no such default, so it was silently missing from
  // every request this plugin sent, which is why the HTTP 400 persisted
  // even after the locale was fixed.
  it('includes an Accept header matching what the reference client always sends', () => {
    const headers = defaultAuthHeaders('Homebridge');
    expect(headers.accept).toBe('*/*');
  });

  it('still includes every other header the reference client sends', () => {
    const headers = defaultAuthHeaders('Homebridge');
    expect(headers).toMatchObject({
      'user-agent': 'okhttp/4.12.0',
      'accept-encoding': 'gzip',
      'content-type': 'application/json',
      'x-app-device-os': 'android',
      'x-app-device-osversion': '26',
      'x-app-device-model': 'Homebridge',
    });
  });
});

describe('HondaAuth auth-failure diagnostics', () => {
  it('logs a sanitized diagnostic (never the email/password) when initiate-login returns HTTP 400', async () => {
    const http = fakeHttpClient({
      'POST /auth/initiate-login': {
        statusCode: 400,
        raw: '{"errorCode":"validation-error","message":"invalid request"}',
        body: {},
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-abc-123' },
      },
    });
    const log = fakeLogger();
    const auth = new HondaAuth(http, DeviceKey.generate(), log);

    await expect(auth.login('user@example.com', 'super-secret-password', 'en-GB')).rejects.toBeInstanceOf(HondaAuthError);

    expect(log.warn).toHaveBeenCalledTimes(1);
    const loggedArgs = (log.warn as jest.Mock).mock.calls[0];
    const loggedText = loggedArgs.join(' ');
    expect(loggedText).toContain('initiate-login');
    expect(loggedText).toContain('400');
    expect(loggedText).toContain('req-abc-123');
    expect(loggedText).not.toContain('user@example.com');
    expect(loggedText).not.toContain('super-secret-password');
  });

  it('does not log a diagnostic on a successful login', async () => {
    const http = fakeHttpClient({
      'POST /auth/initiate-login': { statusCode: 200, raw: '{}', body: { transactionId: 't', signatureChallenge: 'c' } },
      'POST /auth/complete-login': { statusCode: 200, raw: '{}', body: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } },
    });
    const log = fakeLogger();
    const auth = new HondaAuth(http, DeviceKey.generate(), log);

    await auth.login('user@example.com', 'hunter2', 'en-GB');

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('works without a logger (defaults to a no-op) — HondaAuth remains usable in existing call sites', async () => {
    const http = fakeHttpClient({
      'POST /auth/initiate-login': { statusCode: 400, raw: '{}', body: {} },
    });
    const auth = new HondaAuth(http, DeviceKey.generate());

    await expect(auth.login('user@example.com', 'hunter2', 'en-GB')).rejects.toBeInstanceOf(HondaAuthError);
  });
});

describe('HondaAuth locale normalization (regression for Honda HTTP 400 on initiate-login)', () => {
  // Honda's /auth/initiate-login and /auth/complete-login reject a full
  // locale tag like "en-GB" with HTTP 400 — they only accept a bare
  // 2-letter code. This reproduces the exact config value (a full BCP-47
  // tag, as the plugin's own config.schema.json documents and defaults
  // to) that previously reached Honda unnormalized.
  const successResponses = {
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
  };

  it('sends a bare 2-letter locale to initiate-login even when given "en-GB"', async () => {
    const http = fakeHttpClient(successResponses);
    const auth = new HondaAuth(http, DeviceKey.generate());

    await auth.initiateLogin('user@example.com', 'hunter2', 'en-GB');

    expect(lastEncryptedPayload().locale).toBe('en');
  });

  it('sends a bare 2-letter locale to complete-login even when given "en-GB"', async () => {
    const http = fakeHttpClient(successResponses);
    const auth = new HondaAuth(http, DeviceKey.generate());

    await auth.completeLogin('user@example.com', 'hunter2', 'txn-1', 'challenge-1', 'en-GB');

    expect(lastEncryptedPayload().locale).toBe('en');
  });

  it('normalizes the locale through the full login() flow for every step', async () => {
    const http = fakeHttpClient(successResponses);
    const auth = new HondaAuth(http, DeviceKey.generate());

    await auth.login('user@example.com', 'hunter2', 'de-DE');

    const mock = cryptoModule.encryptRequest as jest.Mock;
    const locales = mock.mock.calls.map(([payload]) => (payload as Record<string, unknown>).locale);
    expect(locales).toEqual(['de', 'de']);
  });
});

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

  it('reproduces the reported live scenario: HTTP 400 from initiate-login surfaces as a clear HondaAuthError', async () => {
    // This is the exact failure mode observed against a real Honda account
    // before the locale fix above: initiate-login rejected the request
    // with a plain HTTP 400 and a body carrying neither the
    // "locked-account" nor "device-authenticator-not-registered" markers
    // (Honda's generic bad-request response), which must not be
    // misclassified as either of those specific error types or crash the
    // plugin — it should surface as a plain, informative HondaAuthError.
    const http = fakeHttpClient({
      'POST /auth/initiate-login': {
        statusCode: 400,
        raw: '{"errorCode":"validation-error","message":"invalid request"}',
        body: {},
      },
    });
    const auth = new HondaAuth(http, DeviceKey.generate());

    let caught: Error | undefined;
    try {
      await auth.login('user@example.com', 'hunter2', 'en-GB');
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(HondaAuthError);
    expect(caught).not.toBeInstanceOf(HondaAccountLockedError);
    expect(caught).not.toBeInstanceOf(HondaVerificationRequiredError);
    expect(caught?.message).toContain('initiate-login');
    expect(caught?.message).toContain('400');
    expect((caught as HondaAuthError).statusCode).toBe(400);
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

  it('never includes the raw verification link (or its secret key) in the error for an unparsable link', async () => {
    const http = fakeHttpClient({});
    const auth = new HondaAuth(http, DeviceKey.generate());
    const secretLookingLink = 'https://mobile-api.connected.honda-eu.com/auth/verify-link?type=mfa&notkey=ab+c/d==secretvalue';

    let caught: Error | undefined;
    try {
      await auth.completeDeviceVerification('u@example.com', 'p', secretLookingLink);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(HondaAuthError);
    expect(caught?.message).not.toContain(secretLookingLink);
    expect(caught?.message).not.toContain('ab+c/d==secretvalue');
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
