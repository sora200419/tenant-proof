// This file is part of TenantProof.
// SPDX-License-Identifier: Apache-2.0
//
// Timeouts, backoff and sanitised errors for calls to the indexer, the proof
// server and the node. Browser-safe: no `node:*` imports and no `process`, so
// the UI can use it once it talks to a network.
//
// What the SDK already does underneath (midnight-js 5.0.0):
// - indexer reads: Apollo RetryLink, 5 attempts, 1-10 s jittered, no timeout;
// - proof server: fetch-retry 6.0.0 inside one 300 s timeout. It retries a
//   500/503 answer AND any rejected fetch (reset, hang-up, refused) up to 3
//   times by POSTing /prove again, whatever `retryOn` says. So a reset in the
//   middle of a proof can already start a second job on the proof server below
//   this layer; nothing here can stop that short of replacing the SDK's proof
//   provider. This layer adds no retry of its own for those cases.
// This layer sits outside those, with a longer and slower backoff, so an outage
// of a few minutes is ridden out instead of failing the run.

/** What went wrong, as far as retrying is concerned. */
export type ErrorKind =
  | 'timeout' // our per-attempt timeout, an aborted request, or HTTP 408
  | 'refused' // ECONNREFUSED: the request never reached the server
  | 'connection' // any other transport failure (reset, hang-up, DNS, ...)
  | 'http5xx'
  | 'http429'
  | 'http4xx'
  | 'other'; // anything else: circuit asserts, SDK bounds, bugs. Never retried.

/** Carried over from the original error: an HTTP status and its `code`. */
type Carried = { code?: string; status?: number };

/**
 * An error rebuilt from another one with every URL and secret removed. It
 * never has a `cause`. The original `code` is kept as `upstreamCode`; only a
 * Node system code (ECONNRESET, UND_ERR_SOCKET, ...) is kept as `code`. A
 * midnight-js code on `code` would make midnight-js-contracts treat this as
 * one of its own errors and pass it on unwrapped, with that code's category
 * (TRANSIENT for a proof-server timeout, which must not invite a retry).
 */
export class SanitizedError extends Error {
  readonly code?: string;
  readonly upstreamCode?: string;
  readonly status?: number;
  constructor(message: string, carried: Carried = {}) {
    super(message);
    this.name = 'SanitizedError';
    if (carried.code !== undefined) {
      this.upstreamCode = carried.code;
      if (SYSTEM_CODE_RE.test(carried.code)) this.code = carried.code;
    }
    if (carried.status !== undefined) this.status = carried.status;
  }
}

const SYSTEM_CODE_RE = /^(?:E[A-Z0-9_]+|UND_ERR_[A-Z_]+)$/;

/** Thrown by withRetry when every attempt failed with a retryable error. */
export class RetryExhaustedError extends SanitizedError {
  constructor(message: string, carried: Carried = {}) {
    super(message, carried);
    this.name = 'RetryExhaustedError';
  }
}

/** One attempt took longer than `attemptTimeoutMs`. */
export class AttemptTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label}: attempt timed out after ${ms} ms`);
    this.name = 'AttemptTimeoutError';
  }
}

// Plain and percent-encoded (`https%3A%2F%2F`) URLs.
const URL_RE = /\b[a-z][a-z0-9+.-]*(?::\/\/|%3A%2F%2F)[^\s"'`<>()[\]{}]+/gi;
// `project_id=`, `project_id: `, `"project_id":"`, and the encoded `project_id%3D`.
const PROJECT_ID_RE = /(project_id(?:["']?\s*[:=]\s*["']?|%3D|%3A))[^\s"'&,;}%]+/gi;
// No leading \b: an encoded `%3D` puts a letter right before the key.
const BLOCKFROST_ID_RE = /(?:mainnet|preprod|preview)[A-Za-z0-9]{32}(?![A-Za-z0-9])/g;
const MAX_LINE = 300;

/** Removes URLs (they can carry the Blockfrost project id in the query string), project ids and Blockfrost-style keys. */
export function redactText(text: string): string {
  return text
    .replace(URL_RE, '<url>')
    .replace(PROJECT_ID_RE, '$1<redacted>')
    .replace(BLOCKFROST_ID_RE, '<redacted>');
}

type ErrorLike = { name?: unknown; message?: unknown; cause?: unknown; code?: unknown; status?: unknown };

const isObject = (v: unknown): v is ErrorLike => typeof v === 'object' && v !== null;

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}...` : line;
}

function describe(value: unknown): string {
  if (isObject(value)) {
    const name = typeof value.name === 'string' && value.name ? value.name : 'Error';
    const message = typeof value.message === 'string' ? value.message : '';
    return redactText(message ? `${name}: ${firstLine(message)}` : name);
  }
  return redactText(firstLine(String(value)));
}

const MAX_CAUSES = 3;

/**
 * A new error safe to log: `label: Name: first line`, then up to three causes
 * as ` <- Name: first line`, all redacted. Keeps the original `status`
 * (number) and `code` (see SanitizedError); drops the stack, the `cause` and
 * every other property, which can carry request data.
 */
export function sanitizeError(err: unknown, label: string): SanitizedError {
  return build(SanitizedError, err, label);
}

function build<T extends SanitizedError>(
  Ctor: new (message: string, carried?: Carried) => T,
  err: unknown,
  label: string,
): T {
  let message = `${label}: ${describe(err)}`;
  let cause = isObject(err) ? err.cause : undefined;
  for (let i = 0; i < MAX_CAUSES && cause !== undefined && cause !== null; i++) {
    message += ` <- ${describe(cause)}`;
    cause = isObject(cause) ? cause.cause : undefined;
  }
  const code = isObject(err) && typeof err.code === 'string' ? err.code : undefined;
  const status = isObject(err) && typeof err.status === 'number' ? err.status : undefined;
  return new Ctor(message, {
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
  });
}

const CONNECTION_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const TIMEOUT_NAMES = new Set(['AttemptTimeoutError', 'AbortError', 'TimeoutError']);
const CONNECTION_MESSAGE_RE = /fetch failed|socket hang up|failed to fetch|network ?error|ECONNRESET/i;
const STATUS_MESSAGE_RE = /status code:? ?(\d{3})\b/i;
const MAX_CHAIN = 5;

function statusOf(e: ErrorLike): number | undefined {
  const candidates = [e.status, (e as { statusCode?: unknown }).statusCode, (e as { response?: { status?: unknown } }).response?.status];
  for (const c of candidates) if (typeof c === 'number' && c >= 100 && c <= 599) return c;
  const m = typeof e.message === 'string' ? STATUS_MESSAGE_RE.exec(e.message) : null;
  return m ? Number(m[1]) : undefined;
}

/**
 * Classifies an error by walking its cause chain. A timeout wins over
 * everything (a timed-out proof is never mistaken for a connection error),
 * then an HTTP status, then a refused connection, then other transport errors.
 * The SDK's WatchTimeoutError is the caller's own bound, so it is 'other'.
 */
export function classifyError(err: unknown): ErrorKind {
  const chain: ErrorLike[] = [];
  for (let e: unknown = err, i = 0; isObject(e) && i < MAX_CHAIN; e = e.cause, i++) chain.push(e);
  if (chain.length === 0) return 'other';
  if (chain.some((e) => e.name === 'WatchTimeoutError')) return 'other';
  if (chain.some((e) => typeof e.name === 'string' && TIMEOUT_NAMES.has(e.name))) return 'timeout';
  for (const e of chain) {
    const status = statusOf(e);
    if (status === undefined) continue;
    if (status === 408) return 'timeout';
    if (status === 429) return 'http429';
    if (status >= 500) return 'http5xx';
    if (status >= 400) return 'http4xx';
  }
  const codes = chain.map((e) => (typeof e.code === 'string' ? e.code : ''));
  const messages = chain.map((e) => (typeof e.message === 'string' ? e.message : ''));
  if (codes.includes('ECONNREFUSED') || messages.some((m) => m.includes('ECONNREFUSED'))) return 'refused';
  if (codes.some((c) => CONNECTION_CODES.has(c)) || messages.some((m) => CONNECTION_MESSAGE_RE.test(m))) {
    return 'connection';
  }
  return 'other';
}

export interface RetryOptions {
  /** Names the call in errors and log lines. Never put a URL here. */
  label: string;
  /** Total attempts, including the first. */
  attempts: number;
  /** Delay before the first retry; doubles each retry, capped at maxDelayMs. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Fails one attempt after this long (the call itself keeps running; its result is dropped). */
  attemptTimeoutMs?: number;
  /** Which kinds are retried. Everything else is rethrown unchanged. */
  retryOn: ReadonlySet<ErrorKind>;
  onRetry?: (info: { label: string; attempt: number; delayMs: number; reason: string }) => void;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The wait before retry number `retry` (1-based): half fixed, half random, so clients don't retry in step. */
export function backoffDelay(retry: number, baseDelayMs: number, maxDelayMs: number, random: () => number): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (retry - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

function withTimeout<T>(promise: Promise<T>, label: string, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AttemptTimeoutError(label, ms)), ms);
  });
  // If the timeout wins, the call's own later rejection has no listener left;
  // it is abandoned on purpose (its outcome is no longer wanted), so it is
  // marked handled here instead of surfacing as an unhandled rejection.
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs `fn`, retrying the error kinds in `retryOn` with exponential backoff
 * and jitter. Any other error is rethrown unchanged (4xx, circuit asserts,
 * unknown errors). When the attempts run out, throws a RetryExhaustedError
 * built by sanitizeError from the last failure.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      const call = fn();
      return await (opts.attemptTimeoutMs === undefined ? call : withTimeout(call, opts.label, opts.attemptTimeoutMs));
    } catch (err) {
      const kind = classifyError(err);
      if (!opts.retryOn.has(kind)) throw err;
      if (attempt >= opts.attempts) {
        throw build(RetryExhaustedError, err, `${opts.label} failed after ${attempt} attempts`);
      }
      const delayMs = backoffDelay(attempt, opts.baseDelayMs, opts.maxDelayMs, random);
      opts.onRetry?.({ label: opts.label, attempt, delayMs, reason: sanitizeError(err, kind).message });
      await sleep(delayMs);
    }
  }
}

// ---------------------------------------------------------------------------
// Provider wrappers

export const READ_RETRY_KINDS: ReadonlySet<ErrorKind> = new Set(['timeout', 'refused', 'connection', 'http5xx', 'http429']);
/**
 * Our layer retries proving only after a refused final connection or a transient status.
 * Not a guarantee that no job started: the SDK's client may have sent the proof before
 * (see the header).
 */
export const PROVE_RETRY_KINDS: ReadonlySet<ErrorKind> = new Set(['refused', 'http5xx', 'http429']);

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  attemptTimeoutMs?: number;
}

export interface WrapOptions {
  /** `query*` indexer reads. */
  read: RetryPolicy;
  /** `watchFor*` indexer waits (they wait for blocks, so no per-attempt timeout). */
  watch: Omit<RetryPolicy, 'attemptTimeoutMs'>;
  /** `proveTx`. Our own timeout is not used: the SDK's applies, and this layer does not retry it. */
  prove: Omit<RetryPolicy, 'attemptTimeoutMs'>;
  onRetry?: RetryOptions['onRetry'];
  sleep?: RetryOptions['sleep'];
  random?: RetryOptions['random'];
}

export const DEFAULT_WRAP_OPTIONS: WrapOptions = {
  read: { attempts: 4, baseDelayMs: 2_000, maxDelayMs: 30_000, attemptTimeoutMs: 90_000 },
  watch: { attempts: 4, baseDelayMs: 2_000, maxDelayMs: 30_000 },
  prove: { attempts: 3, baseDelayMs: 5_000, maxDelayMs: 30_000 },
};

type AnyFn = (...args: unknown[]) => unknown;

/**
 * A view of `target` whose methods named by `wrapFor` run through a wrapper.
 * Every method, wrapped or not, is called with the original target as `this`
 * (class instances with private fields keep working). The proxy's own target
 * is a fresh object inheriting from `target`, so frozen or non-configurable
 * properties of `target` never trip the Proxy invariants.
 */
function wrapMethods<T extends object>(
  target: T,
  wrapFor: (name: string) => ((call: () => unknown, name: string) => unknown) | undefined,
): T {
  const cache = new Map<PropertyKey, AnyFn>();
  return new Proxy(Object.create(target) as T, {
    get(_shadow, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      let fn = cache.get(prop);
      if (!fn) {
        const method = value as AnyFn;
        const wrapper = typeof prop === 'string' ? wrapFor(prop) : undefined;
        fn = wrapper
          ? (...args: unknown[]) => wrapper(() => Reflect.apply(method, target, args), String(prop))
          : (...args: unknown[]) => Reflect.apply(method, target, args);
        cache.set(prop, fn);
      }
      return fn;
    },
    has: (_shadow, prop) => Reflect.has(target, prop),
    ownKeys: () => Reflect.ownKeys(target),
    getOwnPropertyDescriptor: (_shadow, prop) => {
      const d = Reflect.getOwnPropertyDescriptor(target, prop);
      return d ? { ...d, configurable: true } : undefined;
    },
  });
}

/** Wraps an indexer public-data provider: `query*` and `watchFor*` retry transient failures; everything else passes through. */
export function wrapPublicDataProvider<T extends object>(provider: T, opts: WrapOptions = DEFAULT_WRAP_OPTIONS): T {
  const common = { retryOn: READ_RETRY_KINDS, onRetry: opts.onRetry, sleep: opts.sleep, random: opts.random };
  return wrapMethods(provider, (name) => {
    if (name.startsWith('query')) {
      return (call, n) => withRetry(call as () => Promise<unknown>, { ...common, ...opts.read, label: `indexer ${n}` });
    }
    if (name.startsWith('watchFor')) {
      return (call, n) => withRetry(call as () => Promise<unknown>, { ...common, ...opts.watch, label: `indexer ${n}` });
    }
    return undefined;
  });
}

/**
 * Wraps a proof provider's `proveTx`. Retries a refused connection and 5xx/429
 * answers only. This layer never retries a timeout, a reset or a hang-up: the
 * proving job may still be running on the proof server and a retry would stack
 * jobs. Note the SDK below already re-POSTs up to 3 times on any rejected
 * fetch (see the header), so a final "refused" may follow an earlier reset.
 */
export function wrapProofProvider<T extends object>(provider: T, opts: WrapOptions = DEFAULT_WRAP_OPTIONS): T {
  return wrapMethods(provider, (name) => {
    if (name !== 'proveTx') return undefined;
    return async (call) => {
      try {
        return await withRetry(call as () => Promise<unknown>, {
          ...opts.prove,
          label: 'proveTx',
          retryOn: PROVE_RETRY_KINDS,
          onRetry: opts.onRetry,
          sleep: opts.sleep,
          random: opts.random,
        });
      } catch (err) {
        if (err instanceof RetryExhaustedError) throw err;
        const kind = classifyError(err);
        if (kind === 'timeout') {
          throw sanitizeError(
            err,
            'proveTx timed out; the proving job may still be running on the proof server. Not retried, so jobs do not stack',
          );
        }
        if (kind === 'connection') {
          throw sanitizeError(
            err,
            'proveTx lost its connection; the proving job may still be running on the proof server. Not retried, so jobs do not stack',
          );
        }
        throw err;
      }
    };
  });
}

/**
 * Wraps a transaction-submit function. Never retried: a failed submit may
 * still have reached the node, and a second submit could double-spend or
 * double-apply. The error says so.
 */
export function wrapSubmit<A extends unknown[], R>(submit: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await submit(...args);
    } catch (err) {
      throw sanitizeError(
        err,
        'submitTx failed; outcome unknown: the transaction may still land. Read chain state (indexer, tx id) before submitting again',
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Console redaction

type ConsoleLike = Pick<Console, 'error' | 'warn' | 'log' | 'info' | 'debug'>;
const REDACTED = Symbol.for('tenant-proof.console-redacted');

/**
 * Makes `target` (the global console by default) redact every string and
 * error it is given. Third-party loggers that write through the console are
 * covered too, such as the Polkadot RPC client, which logs the node URL on
 * disconnect. Call it once at a process entry point; repeated calls do nothing.
 */
export function installConsoleRedaction(target: ConsoleLike = console): void {
  const marked = target as ConsoleLike & { [REDACTED]?: true };
  if (marked[REDACTED]) return;
  for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) =>
      original(
        ...args.map((a) =>
          typeof a === 'string' ? redactText(a) : a instanceof Error ? sanitizeError(a, 'logged error').message : a,
        ),
      );
  }
  Object.defineProperty(marked, REDACTED, { value: true });
}
