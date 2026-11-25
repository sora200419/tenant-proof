// This file is part of TenantProof.
// SPDX-License-Identifier: Apache-2.0
//
// In-memory tests for src/retry.ts: no network. Errors are built in the shapes
// the midnight-js 5.0.0 providers throw (see the comments on each helper).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_ERROR_CODES } from '@midnight-ntwrk/midnight-js-types';
import { hasErrorCode } from '@midnight-ntwrk/midnight-js-utils';
import {
  AttemptTimeoutError,
  RetryExhaustedError,
  backoffDelay,
  classifyError,
  installConsoleRedaction,
  READ_RETRY_KINDS,
  redactText,
  sanitizeError,
  withRetry,
  wrapProofProvider,
  wrapPublicDataProvider,
  wrapSubmit,
  type WrapOptions,
} from '../retry.js';

const PROJECT_ID = 'preprodAbCdEfGhIjKlMnOpQrStUvWxYz012345';
const SECRET_URL = `https://cardano-preprod.blockfrost.io/api/v0?project_id=${PROJECT_ID}`;

const named = (name: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { name }, extra);

/** node-fetch FetchError for a refused / reset connection. */
const fetchError = (code: string, message = `request failed, reason: connect ${code}`) =>
  named('FetchError', message, { code, type: 'system' });
/** Apollo ServerError under IndexerQueryError, as the indexer provider throws on a non-2xx answer. */
const indexerHttp = (status: number) =>
  named('IndexerQueryError', `Response not successful: Received status code ${status}`, {
    cause: named('ServerError', `Response not successful: Received status code ${status}`, { statusCode: status }),
  });
const UNAVAILABLE = PROVIDER_ERROR_CODES.PROOF_SERVER_UNAVAILABLE;
const REFUSED = PROVIDER_ERROR_CODES.PROOF_SERVER_REFUSED;
/** ProofServerError for a transport failure: the cause is the fetch error. */
const proofTransport = (cause: Error) =>
  named('ProofServerError', 'Proof Server request failed: url="http://127.0.0.1:6300/prove"', {
    cause,
    code: UNAVAILABLE,
  });
/** ProofServerError for an HTTP answer. */
const proofHttp = (status: number) =>
  named('ProofServerError', `Failed Proof Server response: url="http://127.0.0.1:6300/prove", code="${status}"`, {
    status,
    code: status >= 500 || status === 429 ? UNAVAILABLE : REFUSED,
  });
/** The error a failed circuit assert produces when a call runs the circuit. */
const circuitAssert = () => new Error("failed assert: Income is below the listing's required multiple of the rent");

/** Runs fn after `failures` errors; records calls and sleeps. */
function flaky<T>(errors: Error[], value: T) {
  let calls = 0;
  const fn = async () => {
    const e = errors[calls++];
    if (e) throw e;
    return value;
  };
  return { fn, calls: () => calls };
}

const sleeps: number[] = [];
const fastOpts = {
  label: 'test read',
  attempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
  retryOn: READ_RETRY_KINDS,
  sleep: async (ms: number) => {
    sleeps.push(ms);
  },
  random: () => 0.5,
};

afterEach(() => {
  sleeps.length = 0;
  vi.useRealTimers();
});

describe('classifyError', () => {
  it('reads the HTTP status from the cause chain', () => {
    expect(classifyError(indexerHttp(503))).toBe('http5xx');
    expect(classifyError(indexerHttp(429))).toBe('http429');
    expect(classifyError(indexerHttp(404))).toBe('http4xx');
    expect(classifyError(proofHttp(500))).toBe('http5xx');
    expect(classifyError(proofHttp(400))).toBe('http4xx');
    expect(classifyError(named('X', 'gateway', { status: 408 }))).toBe('timeout');
  });

  it('tells a refused connection from other transport failures', () => {
    expect(classifyError(proofTransport(fetchError('ECONNREFUSED')))).toBe('refused');
    expect(classifyError(proofTransport(fetchError('ECONNRESET')))).toBe('connection');
    expect(classifyError(proofTransport(named('FetchError', 'request failed, reason: socket hang up')))).toBe('connection');
    expect(classifyError(new TypeError('fetch failed'))).toBe('connection');
  });

  it('puts a timeout before everything else', () => {
    expect(classifyError(proofTransport(named('AbortError', 'The user aborted a request.')))).toBe('timeout');
    expect(classifyError(new AttemptTimeoutError('x', 5))).toBe('timeout');
  });

  it("treats the SDK's WatchTimeoutError and circuit asserts as other", () => {
    expect(classifyError(named('WatchTimeoutError', 'watchForTxData gave up after 1000 ms'))).toBe('other');
    expect(classifyError(circuitAssert())).toBe('other');
    expect(classifyError('a string')).toBe('other');
  });
});

describe('withRetry', () => {
  it('retries 503, 429 and refused connections with doubling, capped delays', async () => {
    const { fn, calls } = flaky([indexerHttp(503), indexerHttp(429), fetchError('ECONNREFUSED')], 'ok');
    await expect(withRetry(fn, fastOpts)).resolves.toBe('ok');
    expect(calls()).toBe(4);
    // random() = 0.5 -> ceiling * 0.75; ceilings 1000, 2000, 4000
    expect(sleeps).toEqual([750, 1500, 3000]);
  });

  it('keeps every delay between half and all of its capped ceiling', () => {
    for (let retry = 1; retry <= 8; retry++) {
      const ceiling = Math.min(8_000, 1_000 * 2 ** (retry - 1));
      expect(backoffDelay(retry, 1_000, 8_000, () => 0)).toBe(ceiling / 2);
      expect(backoffDelay(retry, 1_000, 8_000, () => 1)).toBe(ceiling);
    }
  });

  it('does not retry a 4xx and rethrows the same error object', async () => {
    const original = indexerHttp(400);
    const { fn, calls } = flaky([original], 'never');
    await expect(withRetry(fn, fastOpts)).rejects.toBe(original);
    expect(calls()).toBe(1);
    const notFound = indexerHttp(404);
    await expect(withRetry(flaky([notFound], 'x').fn, fastOpts)).rejects.toBe(notFound);
  });

  it('rethrows a circuit assert unchanged after one call', async () => {
    const original = circuitAssert();
    const { fn, calls } = flaky([original], 'never');
    await expect(withRetry(fn, fastOpts)).rejects.toBe(original);
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("does not retry the SDK's WatchTimeoutError", async () => {
    const original = named('WatchTimeoutError', 'watchForTxData gave up after 1000 ms');
    const { fn, calls } = flaky([original], 'never');
    await expect(withRetry(fn, fastOpts)).rejects.toBe(original);
    expect(calls()).toBe(1);
  });

  it('throws a sanitised RetryExhaustedError when attempts run out', async () => {
    const failing = named('IndexerQueryError', `failed at ${SECRET_URL}`, { cause: named('ServerError', 'x', { statusCode: 503 }) });
    const { fn, calls } = flaky([failing, failing, failing, failing], 'never');
    const err = await withRetry(fn, fastOpts).catch((e: unknown) => e);
    expect(calls()).toBe(4);
    expect(err).toBeInstanceOf(RetryExhaustedError);
    const message = (err as Error).message;
    expect(message).toContain('test read failed after 4 attempts');
    expect(message).not.toContain(PROJECT_ID);
    expect(message).not.toContain('blockfrost');
    expect((err as Error).cause).toBeUndefined();
  });

  it('fails a hung attempt after attemptTimeoutMs and retries it (fake clock)', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fn = () => {
      calls++;
      return calls === 1 ? new Promise<string>(() => undefined) : Promise.resolve('ok');
    };
    const p = withRetry(fn, { ...fastOpts, sleep: undefined, attemptTimeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1); // attempt 1 times out
    await vi.advanceTimersByTimeAsync(750); // backoff before attempt 2
    await expect(p).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('reports each retry with a sanitised reason', async () => {
    const seen: string[] = [];
    const { fn } = flaky([named('X', `boom ${SECRET_URL}`, { status: 502 })], 'ok');
    await withRetry(fn, { ...fastOpts, onRetry: (i) => seen.push(i.reason) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain(PROJECT_ID);
    expect(seen[0]).toContain('<url>');
  });
});

describe('sanitizeError / redactText', () => {
  it('removes URLs and every form of project_id', () => {
    expect(redactText(`GET ${SECRET_URL} failed`)).toBe('GET <url> failed');
    expect(redactText(`{"project_id":"${PROJECT_ID}"}`)).toBe('{"project_id":"<redacted>"}');
    expect(redactText(`project_id: ${PROJECT_ID}`)).toBe('project_id: <redacted>');
    expect(redactText(`key ${PROJECT_ID} used`)).toBe('key <redacted> used');
    expect(redactText('disconnected from wss://rpc.preview.midnight.network/ws: 1006')).toBe('disconnected from <url> 1006');
    expect(redactText(`at ${SECRET_URL}&x=1, then`)).toBe('at <url> then');
  });

  it('removes percent-encoded URLs, project ids and keys', () => {
    const encoded = `https%3A%2F%2Fx.io%3Fproject_id%3D${PROJECT_ID}`;
    expect(redactText(`url=${encoded} done`)).toBe('url=<url> done');
    expect(redactText(`q=project_id%3D${PROJECT_ID}%26a%3D1`)).toBe('q=project_id%3D<redacted>%26a%3D1');
    expect(redactText(`x%3D${PROJECT_ID}%26`)).toBe('x%3D<redacted>%26');
  });

  it('keeps label, name and first line of each cause; keeps status and the upstream code; drops cause', () => {
    const err = named('ProofServerError', `Failed Proof Server response: url="${SECRET_URL}"\nsecond line`, {
      status: 503,
      code: UNAVAILABLE,
      headers: { project_id: PROJECT_ID },
      cause: named('FetchError', `GET ${SECRET_URL}`, { cause: new Error('innermost') }),
    });
    const s = sanitizeError(err, 'proving');
    expect(s.message).toBe(
      'proving: ProofServerError: Failed Proof Server response: url="<url>" <- FetchError: GET <url> <- Error: innermost',
    );
    // A midnight-js code stays off `code`, so midnight-js-contracts does not
    // take this for one of its own errors (and its TRANSIENT category).
    expect(s.code).toBeUndefined();
    expect(s.upstreamCode).toBe(UNAVAILABLE);
    expect(hasErrorCode(err)).toBe(true);
    expect(hasErrorCode(s)).toBe(false);
    expect(s.status).toBe(503);
    expect(s.cause).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain(PROJECT_ID);
    expect(s.stack ?? '').not.toContain(PROJECT_ID);
  });
});

const wrapOpts = (onRetry?: WrapOptions['onRetry']): WrapOptions => ({
  read: { attempts: 3, baseDelayMs: 10, maxDelayMs: 10, attemptTimeoutMs: 1_000 },
  watch: { attempts: 3, baseDelayMs: 10, maxDelayMs: 10 },
  prove: { attempts: 3, baseDelayMs: 10, maxDelayMs: 10 },
  sleep: async () => undefined,
  random: () => 0,
  onRetry,
});

/** A class with a private field, like IndexerPublicDataProvider: methods must run with the real instance as `this`. */
class FakeIndexer {
  #errors: Error[];
  calls: string[] = [];
  readonly pollInterval = 1000;
  constructor(errors: Error[]) {
    this.#errors = errors;
  }
  async queryContractState(address: string) {
    this.calls.push(`query ${address}`);
    const e = this.#errors.shift();
    if (e) throw e;
    return { address };
  }
  async watchForTxData(txId: string) {
    this.calls.push(`watch ${txId}`);
    const e = this.#errors.shift();
    if (e) throw e;
    return { txId };
  }
  contractStateObservable(address: string) {
    this.calls.push(`observe ${address}`);
    return { subscribeTo: address, poll: this.pollInterval };
  }
  dispose() {
    this.calls.push('dispose');
  }
}

describe('wrapPublicDataProvider', () => {
  it('retries query* and watchFor* on 503 with the real instance as this', async () => {
    const raw = new FakeIndexer([indexerHttp(503)]);
    const wrapped = wrapPublicDataProvider(raw, wrapOpts());
    await expect(wrapped.queryContractState('a1')).resolves.toEqual({ address: 'a1' });
    expect(raw.calls).toEqual(['query a1', 'query a1']);
    const raw2 = new FakeIndexer([fetchError('ECONNRESET')]);
    await expect(wrapPublicDataProvider(raw2, wrapOpts()).watchForTxData('t1')).resolves.toEqual({ txId: 't1' });
    expect(raw2.calls).toEqual(['watch t1', 'watch t1']);
  });

  it('passes observables, plain methods and fields through, bound to the target', () => {
    const raw = new FakeIndexer([]);
    const wrapped = wrapPublicDataProvider(raw, wrapOpts());
    expect(wrapped.contractStateObservable('a2')).toEqual({ subscribeTo: 'a2', poll: 1000 });
    const { dispose } = wrapped; // detached call still reaches the target
    dispose();
    expect(wrapped.pollInterval).toBe(1000);
    expect(wrapped).toBeInstanceOf(FakeIndexer);
    expect('queryContractState' in wrapped).toBe(true);
    expect(raw.calls).toEqual(['observe a2', 'dispose']);
  });

  it('works over a frozen object', async () => {
    const frozen = Object.freeze({ queryBlock: async () => 7, label: 'f' });
    const wrapped = wrapPublicDataProvider(frozen, wrapOpts());
    await expect(wrapped.queryBlock()).resolves.toBe(7);
    expect(wrapped.label).toBe('f');
    expect(Object.keys(wrapped)).toEqual(['queryBlock', 'label']);
  });

  it('does not retry a 4xx read', async () => {
    const original = indexerHttp(400);
    const raw = new FakeIndexer([original]);
    await expect(wrapPublicDataProvider(raw, wrapOpts()).queryContractState('a3')).rejects.toBe(original);
    expect(raw.calls).toEqual(['query a3']);
  });
});

/** Like createProofProviderFromHandlers: a frozen-ish literal with supportedEras and proveTx. */
function fakeProver(errors: Error[]) {
  const calls: unknown[] = [];
  const provider = Object.freeze({
    supportedEras: Object.freeze(['v9']),
    proveTx: async (tx: string) => {
      calls.push(tx);
      const e = errors.shift();
      if (e) throw e;
      return `proven ${tx}`;
    },
  });
  return { provider, calls };
}

describe('wrapProofProvider', () => {
  it('gives up after its attempts with an error midnight-js does not take for its own', async () => {
    const { provider, calls } = fakeProver([proofHttp(503), proofHttp(503), proofHttp(503)]);
    const err = await wrapProofProvider(provider, wrapOpts()).proveTx('tx5').catch((e: unknown) => e);
    expect(calls).toEqual(['tx5', 'tx5', 'tx5']);
    expect(err).toBeInstanceOf(RetryExhaustedError);
    expect(hasErrorCode(err)).toBe(false);
    expect((err as RetryExhaustedError).upstreamCode).toBe(UNAVAILABLE);
  });

  it('retries a refused connection and 5xx/429 answers', async () => {
    const { provider, calls } = fakeProver([proofTransport(fetchError('ECONNREFUSED')), proofHttp(503)]);
    const wrapped = wrapProofProvider(provider, wrapOpts());
    await expect(wrapped.proveTx('tx1')).resolves.toBe('proven tx1');
    expect(calls).toEqual(['tx1', 'tx1', 'tx1']);
    expect(wrapped.supportedEras).toEqual(['v9']);
  });

  it('never retries its own timeout: one call, error says the job may still be running', async () => {
    const { provider, calls } = fakeProver([proofTransport(named('AbortError', 'The user aborted a request.'))]);
    const err = await wrapProofProvider(provider, wrapOpts()).proveTx('tx2').catch((e: unknown) => e);
    expect(calls).toEqual(['tx2']);
    expect((err as Error).message).toMatch(/^proveTx timed out; the proving job may still be running/);
    expect((err as Error).message).not.toContain('127.0.0.1');
    expect((err as Error).cause).toBeUndefined();
    // Not a TRANSIENT midnight-js error: nothing downstream should retry it.
    expect(hasErrorCode(err)).toBe(false);
  });

  it('never retries a reset or hang-up mid-proof', async () => {
    for (const cause of [fetchError('ECONNRESET'), named('FetchError', 'request failed, reason: socket hang up')]) {
      const { provider, calls } = fakeProver([proofTransport(cause)]);
      const err = await wrapProofProvider(provider, wrapOpts()).proveTx('tx3').catch((e: unknown) => e);
      expect(calls).toEqual(['tx3']);
      expect((err as Error).message).toMatch(/^proveTx lost its connection; the proving job may still be running/);
      expect(hasErrorCode(err)).toBe(false);
    }
  });

  it('rethrows a 4xx and a circuit assert unchanged', async () => {
    for (const original of [proofHttp(400), circuitAssert()]) {
      const { provider, calls } = fakeProver([original]);
      await expect(wrapProofProvider(provider, wrapOpts()).proveTx('tx4')).rejects.toBe(original);
      expect(calls).toEqual(['tx4']);
    }
  });
});

describe('wrapSubmit', () => {
  it('calls once and says the outcome is unknown, without URLs or cause', async () => {
    let calls = 0;
    const submit = wrapSubmit(async (_tx: string) => {
      calls++;
      throw named('SubmissionError', `node at ${SECRET_URL} closed the socket`, {
        code: 'ECONNRESET',
        cause: new Error('x'),
      });
    });
    const err = await submit('tx').catch((e: unknown) => e);
    expect(calls).toBe(1);
    const message = (err as Error).message;
    expect(message).toMatch(/^submitTx failed; outcome unknown: the transaction may still land\. Read chain state/);
    expect(message).not.toContain(PROJECT_ID);
    expect((err as Error).cause).toBeUndefined();
    expect((err as { code?: string }).code).toBe('ECONNRESET');
  });

  it('returns the result on success', async () => {
    await expect(wrapSubmit(async (tx: string) => `id-${tx}`)('a')).resolves.toBe('id-a');
  });
});

describe('installConsoleRedaction', () => {
  it('redacts strings and errors written through the console, once', () => {
    const out: unknown[][] = [];
    const fake = {
      error: (...a: unknown[]) => out.push(a),
      warn: (...a: unknown[]) => out.push(a),
      log: (...a: unknown[]) => out.push(a),
      info: (...a: unknown[]) => out.push(a),
      debug: (...a: unknown[]) => out.push(a),
    };
    installConsoleRedaction(fake);
    installConsoleRedaction(fake); // idempotent: no double wrapping
    // The Polkadot logger's shape: date, padded type, then the message.
    fake.error('2026-11-20 06:30:00', '        API-WS:', `disconnected from wss://node.example/ws?project_id=${PROJECT_ID}: 1006:: Abnormal Closure`);
    fake.warn(named('RpcError', `call to ${SECRET_URL} failed`));
    fake.log({ kept: 1 });
    expect(out[0]).toEqual(['2026-11-20 06:30:00', '        API-WS:', 'disconnected from <url> 1006:: Abnormal Closure']);
    expect(String(out[1]?.[0])).toBe('logged error: RpcError: call to <url> failed');
    expect(out[2]).toEqual([{ kept: 1 }]);
    expect(JSON.stringify(out)).not.toContain(PROJECT_ID);
  });
});
