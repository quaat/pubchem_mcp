import type { TtlCache } from '../infrastructure/cache.js';
import type { Config } from '../infrastructure/config.js';
import type { Logger } from '../infrastructure/logger.js';
import type { RateLimiter } from '../infrastructure/rateLimiter.js';
import { withRetry } from '../infrastructure/retry.js';
import {
  type ThrottleStateTracker,
  suggestedBackoffMs,
} from '../infrastructure/throttling.js';
import {
  PubChemError,
  PubChemNotFoundError,
  PubChemRateLimitError,
  PubChemResponseError,
  PubChemTransientError,
  PubChemUnsupportedOperationError,
  PubChemValidationError,
  classifyHttpStatus,
} from './pubchemErrors.js';
import { buildListKeyPollUrl } from './pubchemUrls.js';

export type ResponseFormat = 'json' | 'text' | 'binary';

export interface RequestOptions {
  /** Expected response format. Default: 'json'. */
  format?: ResponseFormat;
  /** AbortSignal that callers can use to cancel. */
  signal?: AbortSignal;
  /** Override cache behavior for this call. */
  cache?: {
    /** Skip cache read+write for this call. */
    bypass?: boolean;
    /** Override the cache-wide TTL for this entry. */
    ttlMs?: number;
  };
}

export interface PugRestClientDeps {
  config: Config;
  cache: TtlCache<CachedEntry>;
  logger: Logger;
  rateLimiter: RateLimiter;
  throttle: ThrottleStateTracker;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable random (for retry jitter, tests). */
  random?: () => number;
  /** Override the package version reported in User-Agent. */
  userAgentVersion?: string;
}

export interface CachedEntry {
  format: ResponseFormat;
  body: unknown;
}

const PACKAGE_NAME = 'pubchem-mcp';

interface AsyncWaitingResponse {
  Waiting?: { ListKey?: string };
}

interface ListResponse {
  IdentifierList?: { CID?: number[] };
}

interface FaultResponse {
  Fault?: { Code?: number | string; Message?: string };
}

function isFaultResponse(value: unknown): value is FaultResponse {
  return typeof value === 'object' && value !== null && 'Fault' in value;
}

export interface PollListKeyOptions {
  intervalMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
}

/** Internal request specification used by `requestPipelined`. */
interface RequestSpec {
  url: string;
  method: 'GET' | 'POST';
  format: ResponseFormat;
  /** Already-serialized request body, or undefined for GET. */
  body?: string;
  /** Additional headers (e.g. Content-Type for POST). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * PugRestClient — single point of network I/O for PUG-REST and PUG-View.
 *
 * Pipeline for every request (GET or POST):
 *   1. Cache check (GET only; POST never reads cache).
 *   2. Rate limiter acquire (token bucket per-second + sliding window per-minute).
 *   3. Throttle gate: if the most recent X-Throttling-Control was Red/Black, sleep first.
 *   4. fetch() with AbortController timeout and PubChem-friendly User-Agent.
 *   5. Parse X-Throttling-Control into the shared state tracker.
 *   6. Retry on 429/5xx + network errors using exponential backoff with jitter.
 *   7. Map HTTP errors to typed PubChemError classes.
 *
 * GET responses are cached (when not bypassed). POST responses are never cached.
 */
export class PugRestClient {
  protected readonly config: Config;
  protected readonly cache: TtlCache<CachedEntry>;
  protected readonly logger: Logger;
  protected readonly rateLimiter: RateLimiter;
  protected readonly throttle: ThrottleStateTracker;
  protected readonly fetchImpl: typeof fetch;
  protected readonly sleep: (ms: number) => Promise<void>;
  protected readonly random: () => number;
  protected readonly userAgent: string;

  constructor(deps: PugRestClientDeps) {
    this.config = deps.config;
    this.cache = deps.cache;
    this.logger = deps.logger;
    this.rateLimiter = deps.rateLimiter;
    this.throttle = deps.throttle;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = deps.random ?? Math.random;
    const version = deps.userAgentVersion ?? '0.0.0';
    const contact = this.config.contactUrl ? ` (+${this.config.contactUrl})` : '';
    this.userAgent = `${PACKAGE_NAME}/${version}${contact}`;
  }

  // -------- GET helpers --------------------------------------------------

  async getJson<T>(url: string, opts?: RequestOptions): Promise<T> {
    const result = await this.request(url, { ...opts, format: 'json' });
    return result as T;
  }

  async getText(url: string, opts?: RequestOptions): Promise<string> {
    const result = await this.request(url, { ...opts, format: 'text' });
    return result as string;
  }

  async request(url: string, opts: RequestOptions = {}): Promise<unknown> {
    const format = opts.format ?? 'json';
    const cacheKey = `GET:${format}:${url}`;
    if (!opts.cache?.bypass) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.format === format) {
        return cached.body;
      }
    }

    const body = await this.requestPipelined({
      url,
      method: 'GET',
      format,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    if (!opts.cache?.bypass) {
      this.cache.set(cacheKey, { format, body }, opts.cache?.ttlMs);
    }
    return body;
  }

  // -------- POST helpers -------------------------------------------------

  /**
   * POST a form-urlencoded body to PubChem.
   *
   * PubChem documents POST/form input for `InChI` and `SDF` payloads (and for
   * very large structure queries that would exceed URL length limits).
   * Responses are NEVER cached because the request body is part of the
   * identity of the response and we do not currently hash it.
   */
  async postFormJson<T>(
    url: string,
    form: Record<string, string>,
    opts?: Omit<RequestOptions, 'cache'> & { signal?: AbortSignal },
  ): Promise<T> {
    const body = new URLSearchParams(form).toString();
    const result = await this.requestPipelined({
      url,
      method: 'POST',
      format: opts?.format ?? 'json',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    return result as T;
  }

  // -------- ListKey polling ---------------------------------------------

  /**
   * Poll an asynchronous ListKey response until results arrive or we time out.
   * Returns the array of CIDs.
   */
  async pollListKey(listKey: string, opts: PollListKeyOptions = {}): Promise<number[]> {
    const intervalMs = opts.intervalMs ?? 2_000;
    const maxAttempts = opts.maxAttempts ?? 30;
    const url = buildListKeyPollUrl(
      { baseUrl: this.config.baseUrl, viewBaseUrl: this.config.viewBaseUrl },
      listKey,
    );

    for (let i = 0; i < maxAttempts; i++) {
      const body = (await this.request(url, {
        format: 'json',
        cache: { bypass: true },
        ...(opts.signal ? { signal: opts.signal } : {}),
      })) as AsyncWaitingResponse & ListResponse;
      if (body.IdentifierList?.CID) {
        return body.IdentifierList.CID;
      }
      if (!body.Waiting?.ListKey) {
        throw new PubChemResponseError(
          'Unexpected response shape while polling list key',
          { endpoint: 'compound/listkey' },
        );
      }
      await this.sleep(intervalMs);
    }
    throw new PubChemTransientError('List key polling timed out', {
      endpoint: 'compound/listkey',
    });
  }

  // -------- Internal: shared request pipeline ---------------------------

  private async requestPipelined(spec: RequestSpec): Promise<unknown> {
    return withRetry(() => this.executeOnce(spec), {
      maxAttempts: Math.max(1, this.config.maxRetries),
      baseDelayMs: 500,
      maxDelayMs: 16_000,
      jitter: 0.2,
      sleep: this.sleep,
      random: this.random,
      shouldRetry: (err) => {
        if (err instanceof PubChemError) return err.retryable;
        // Network errors (TypeError from fetch, AbortError for timeout) are retryable.
        if (err instanceof Error) {
          if (err.name === 'AbortError') return true;
          if (err.name === 'TypeError') return true;
          if ((err as { code?: string }).code === 'ECONNRESET') return true;
        }
        return false;
      },
      onRetry: (err, attempt, delayMs) => {
        this.logger.debug(
          {
            attempt,
            delayMs,
            method: spec.method,
            endpoint: sanitizeEndpoint(spec.url, this.config),
          },
          `retrying after error: ${(err as Error).message}`,
        );
      },
    });
  }

  private async executeOnce(spec: RequestSpec): Promise<unknown> {
    await this.rateLimiter.acquire();
    const backoff = suggestedBackoffMs(this.throttle.current());
    if (backoff > 0) await this.sleep(backoff);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const onAbort = () => controller.abort();
    if (spec.signal) {
      if (spec.signal.aborted) controller.abort();
      else spec.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const headers: Record<string, string> = {
        'User-Agent': this.userAgent,
        Accept: spec.format === 'json' ? 'application/json' : '*/*',
        ...(spec.headers ?? {}),
      };
      const init: RequestInit = {
        method: spec.method,
        headers,
        signal: controller.signal,
      };
      if (spec.body !== undefined) init.body = spec.body;

      const response = await this.fetchImpl(spec.url, init);

      this.throttle.update(response.headers.get('x-throttling-control'));

      if (!response.ok) {
        await this.consumeAndThrow(response, spec.url);
      }

      const contentType = response.headers.get('content-type') ?? '';
      // Handle 202 with an async ListKey payload — surface to caller.
      if (response.status === 202 && contentType.includes('json')) {
        return await response.json();
      }

      if (spec.format === 'json') {
        const text = await response.text();
        if (!text) {
          throw new PubChemResponseError('Empty JSON response', {
            endpoint: sanitizeEndpoint(spec.url, this.config),
            status: response.status,
          });
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          throw new PubChemResponseError(
            `Invalid JSON response: ${(err as Error).message}`,
            {
              endpoint: sanitizeEndpoint(spec.url, this.config),
              status: response.status,
            },
          );
        }
        if (isFaultResponse(parsed) && parsed.Fault) {
          // PubChem returned a 2xx body containing a Fault wrapper.
          const codeRaw = parsed.Fault.Code;
          const code = typeof codeRaw === 'number' ? codeRaw : Number(codeRaw);
          const message = parsed.Fault.Message ?? 'PubChem fault';
          throw mapFault(message, code, sanitizeEndpoint(spec.url, this.config));
        }
        return parsed;
      }

      if (spec.format === 'text') {
        return await response.text();
      }

      const buf = await response.arrayBuffer();
      return Buffer.from(buf);
    } finally {
      clearTimeout(timeoutHandle);
      if (spec.signal) spec.signal.removeEventListener('abort', onAbort);
    }
  }

  private async consumeAndThrow(response: Response, url: string): Promise<never> {
    const endpoint = sanitizeEndpoint(url, this.config);
    const status = response.status;
    let message = response.statusText || `HTTP ${status}`;
    try {
      const text = await response.text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as FaultResponse;
          if (parsed?.Fault?.Message) message = parsed.Fault.Message;
        } catch {
          // Use first line of plain-text body for a hint, capped to keep responses small.
          message = text.split('\n')[0]?.slice(0, 200) || message;
        }
      }
    } catch {
      // ignore body read errors
    }

    const ErrCls = classifyHttpStatus(status);
    if (!ErrCls) {
      throw new PubChemResponseError(`Unexpected response (${status})`, { endpoint, status });
    }
    if (ErrCls === PubChemNotFoundError) {
      throw new PubChemNotFoundError(message, { endpoint, status });
    }
    if (ErrCls === PubChemValidationError) {
      throw new PubChemValidationError(message, { endpoint, status });
    }
    if (ErrCls === PubChemRateLimitError) {
      throw new PubChemRateLimitError(message, { endpoint, status });
    }
    if (ErrCls === PubChemTransientError) {
      throw new PubChemTransientError(message, { endpoint, status });
    }
    if (ErrCls === PubChemUnsupportedOperationError) {
      throw new PubChemUnsupportedOperationError(message, { endpoint, status });
    }
    throw new PubChemResponseError(message, { endpoint, status });
  }
}

function mapFault(message: string, code: number, endpoint: string): PubChemError {
  if (code === 404) return new PubChemNotFoundError(message, { endpoint, status: 404 });
  if (code === 400) return new PubChemValidationError(message, { endpoint, status: 400 });
  if (code === 405 || code === 501) {
    return new PubChemUnsupportedOperationError(message, { endpoint, status: code });
  }
  if (code === 429) return new PubChemRateLimitError(message, { endpoint, status: 429 });
  if (code >= 500 && code < 600) {
    return new PubChemTransientError(message, { endpoint, status: code });
  }
  return new PubChemResponseError(message, { endpoint, status: code });
}

/**
 * Strip query strings and reduce to the path segment after the configured base
 * URL, so error messages don't leak full URLs (which could include user-controlled
 * SMILES strings).
 */
export function sanitizeEndpoint(url: string, config: Pick<Config, 'baseUrl' | 'viewBaseUrl'>): string {
  try {
    const parsed = new URL(url);
    // Check the longer base URL first so e.g. `pug_view` wins over `pug`.
    const bases = [config.baseUrl, config.viewBaseUrl].sort((a, b) => b.length - a.length);
    const matched = bases.find((b) => url.startsWith(b));
    const base = matched ?? `${parsed.protocol}//${parsed.host}`;
    const baseUrl = new URL(base);
    let path = parsed.pathname;
    if (path.startsWith(baseUrl.pathname)) {
      path = path.slice(baseUrl.pathname.length).replace(/^\/+/, '');
    } else {
      path = path.replace(/^\/+/, '');
    }
    // Strip user-controlled segments: keep up to first 3 path segments.
    const segments = path.split('/').filter(Boolean).slice(0, 3);
    return segments.join('/');
  } catch {
    return 'unknown';
  }
}
