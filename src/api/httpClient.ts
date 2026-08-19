/**
 * Thin HTTP wrapper around undici for talking to Honda's mobile API.
 *
 * Centralizes: base URL, default headers, JSON parsing, timeouts, and
 * translation of transport-level failures into HondaApiError/RateLimit
 * errors so callers never touch undici types directly.
 */

import { request } from 'undici';
import { HondaApiError, HondaRateLimitError } from './errors';

export const API_BASE = 'https://mobile-api.connected.honda-eu.com';

export interface HttpResponse<T> {
  statusCode: number;
  body: T;
  raw: string;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  json?: unknown;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class HttpClient {
  constructor(private readonly defaultHeaders: Record<string, string>) {}

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    const { method = 'GET', headers = {}, json, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;

    let res;
    try {
      res = await request(url, {
        method,
        headers: { ...this.defaultHeaders, ...headers },
        body: json !== undefined ? JSON.stringify(json) : undefined,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
    } catch (err) {
      throw new HondaApiError(
        `Network error calling Honda API (${method} ${path}): ${(err as Error).message}`,
      );
    }

    const raw = await res.body.text();

    if (res.statusCode === 429) {
      const retryAfterHeader = res.headers['retry-after'];
      const retryAfterMs = retryAfterHeader
        ? Number(Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader) * 1000
        : undefined;
      throw new HondaRateLimitError(
        `Honda API rate limit hit (${method} ${path})`,
        Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
      );
    }

    let parsed: T = undefined as unknown as T;
    if (raw) {
      try {
        parsed = JSON.parse(raw) as T;
      } catch {
        // Some endpoints (204s, plain acks) return no/invalid JSON; leave parsed undefined.
      }
    }

    return { statusCode: res.statusCode, body: parsed, raw };
  }
}
