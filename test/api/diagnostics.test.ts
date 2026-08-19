import { logAuthFailureDiagnostics } from '../../src/api/diagnostics';
import { HondaClientLogger } from '../../src/api/logger';

function fakeLogger(): HondaClientLogger {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('logAuthFailureDiagnostics', () => {
  it('logs status, allow-listed headers, and the response body', () => {
    const log = fakeLogger();

    logAuthFailureDiagnostics(log, {
      step: 'initiate-login',
      response: {
        statusCode: 400,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-123' },
        raw: '{"errorCode":"validation-error"}',
      },
      secrets: [],
    });

    expect(log.warn).toHaveBeenCalledTimes(1);
    const [, ...args] = (log.warn as jest.Mock).mock.calls[0];
    const [step, statusCode, headersJson, body] = args;
    expect(step).toBe('initiate-login');
    expect(statusCode).toBe(400);
    expect(JSON.parse(headersJson)).toEqual({ 'content-type': 'application/json', 'x-request-id': 'req-123' });
    expect(body).toBe('{"errorCode":"validation-error"}');
  });

  it('drops any response header not on the diagnostic allow-list', () => {
    const log = fakeLogger();

    logAuthFailureDiagnostics(log, {
      step: 'initiate-login',
      response: {
        statusCode: 400,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=super-secret-session-token',
          authorization: 'Bearer something',
        },
        raw: '{}',
      },
      secrets: [],
    });

    const [, , , headersJson] = (log.warn as jest.Mock).mock.calls[0];
    const headers = JSON.parse(headersJson);
    expect(headers).toEqual({ 'content-type': 'application/json' });
    expect(headers['set-cookie']).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it('scrubs every provided secret out of the logged body', () => {
    const log = fakeLogger();

    logAuthFailureDiagnostics(log, {
      step: 'initiate-login',
      response: {
        statusCode: 400,
        headers: {},
        raw: 'error for user@example.com with password hunter2secret',
      },
      secrets: ['user@example.com', 'hunter2secret'],
    });

    const [, , , , body] = (log.warn as jest.Mock).mock.calls[0];
    expect(body).not.toContain('user@example.com');
    expect(body).not.toContain('hunter2secret');
    expect(body).toBe('error for [REDACTED] with password [REDACTED]');
  });

  it('ignores undefined/short secrets rather than mangling the body', () => {
    const log = fakeLogger();

    logAuthFailureDiagnostics(log, {
      step: 'initiate-login',
      response: { statusCode: 400, headers: {}, raw: 'plain error text' },
      secrets: [undefined, '', 'a'],
    });

    const [, , , , body] = (log.warn as jest.Mock).mock.calls[0];
    expect(body).toBe('plain error text');
  });

  it('logs "(empty)" for an empty response body rather than an empty string', () => {
    const log = fakeLogger();

    logAuthFailureDiagnostics(log, {
      step: 'initiate-login',
      response: { statusCode: 400, headers: {}, raw: '' },
      secrets: [],
    });

    const [, , , , body] = (log.warn as jest.Mock).mock.calls[0];
    expect(body).toBe('(empty)');
  });
});
