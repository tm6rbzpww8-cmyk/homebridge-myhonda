/**
 * Sanitized diagnostic logging for Honda auth failures.
 *
 * Honda's `/auth/*` endpoints give almost no detail in their normal error
 * text (see HondaAuth.throwAuthError's classification), which made
 * previous failures (e.g. the wrong `locale` format) hard to diagnose
 * without seeing exactly what Honda sent back. This captures the HTTP
 * status, a small allow-listed set of response headers useful for
 * debugging/support, and the complete response body — with any of the
 * caller's own secret values scrubbed out first, on the off chance Honda's
 * error response ever echoed something back.
 *
 * Deliberately conservative on what it exposes:
 *  - Headers are allow-listed (not blocklisted) — only entries that are
 *    genuinely useful for diagnosing an HTTP-level failure (content type,
 *    request/trace ids, rate-limit hints, CDN/edge routing) are included.
 *    Anything that could carry session/auth state (e.g. `set-cookie`) is
 *    never in the allow-list, so it can never leak by omission.
 *  - The response body is Honda describing a request it (in the failure
 *    cases this covers) never successfully decrypted, so it cannot
 *    legitimately contain our plaintext credentials — but every secret
 *    value passed in is still scrubbed from it before logging, as a
 *    zero-cost defensive backstop.
 */

import { HondaClientLogger } from './logger';
import { HttpResponse } from './httpClient';

const DIAGNOSTIC_HEADER_ALLOWLIST = [
  'content-type',
  'content-length',
  'date',
  'server',
  'via',
  'retry-after',
  'x-request-id',
  'x-correlation-id',
  'x-amzn-requestid',
  'x-amzn-trace-id',
  'x-amz-cf-id',
  'x-cache',
  'cf-ray',
];

function pickDiagnosticHeaders(headers: Record<string, string>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of DIAGNOSTIC_HEADER_ALLOWLIST) {
    const value = headers[name];
    if (value !== undefined) {
      picked[name] = value;
    }
  }
  return picked;
}

function scrubSecrets(text: string, secrets: Array<string | undefined>): string {
  let scrubbed = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 3) {
      scrubbed = scrubbed.split(secret).join('[REDACTED]');
    }
  }
  return scrubbed;
}

export interface AuthFailureDiagnosticsOptions {
  /** The auth step that failed, e.g. "initiate-login". */
  step: string;
  response: Pick<HttpResponse<unknown>, 'statusCode' | 'headers' | 'raw'>;
  /** Values (e.g. email, password) to scrub from the logged body if they somehow appear in it. */
  secrets: Array<string | undefined>;
}

/**
 * Logs a sanitized diagnostic for a failed Honda auth HTTP call. Intended
 * to help diagnose failures like HTTP 400s from initiate-login where the
 * cause isn't captured by the specific error classifications in
 * HondaAuth.throwAuthError.
 */
export function logAuthFailureDiagnostics(log: HondaClientLogger, options: AuthFailureDiagnosticsOptions): void {
  const { step, response, secrets } = options;
  const headers = pickDiagnosticHeaders(response.headers);
  const body = scrubSecrets(response.raw, secrets);

  log.warn(
    'Honda %s diagnostic — HTTP %d, headers=%s, body=%s',
    step,
    response.statusCode,
    JSON.stringify(headers),
    body || '(empty)',
  );
}
