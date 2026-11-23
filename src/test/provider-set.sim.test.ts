// This file is part of TenantProof.
// SPDX-License-Identifier: Apache-2.0
//
// assembleProviders (src/provider-set.ts) is what both buildProviders (Node)
// and the browser use; this checks it actually runs the parts through the
// src/retry.ts wrappers. Fake providers, fake sleep, fixed data.
import { describe, expect, it } from 'vitest';
import { assembleProviders, type ProviderParts } from '../provider-set.js';
import { DEFAULT_WRAP_OPTIONS, type WrapOptions } from '../retry.js';
import { LedgerTransaction } from '@midnight-ntwrk/midnight-js-types';
import { Intent, Transaction } from '@midnight-ntwrk/midnight-js-protocol/v9';

/** A real finalized ledger-v9 transaction (one empty intent, mock proofs), so the midnight provider accepts it. */
const finalizedTx = () =>
  LedgerTransaction.seal(
    'v9',
    'Finalized',
    Transaction.fromParts('preview', undefined, undefined, Intent.new(new Date(Date.UTC(2030, 0, 1)))).mockProve(),
  );

const noSleep: WrapOptions = { ...DEFAULT_WRAP_OPTIONS, sleep: async () => undefined, random: () => 0 };

const http = (status: number) => Object.assign(new Error(`Response not successful: Received status code ${status}`), { status });

function parts(over: Partial<ProviderParts> = {}): ProviderParts {
  return {
    privateStateProvider: {} as never,
    publicDataProvider: { queryBlock: async () => null } as never,
    zkConfigProvider: {} as never,
    proofProvider: { supportedEras: ['v9'], proveTx: async () => 'proven' } as never,
    walletProvider: { supportedEras: ['v9'] } as never,
    submit: async () => 'tx-id',
    networkId: 'preview',
    ttlSeconds: 3600,
    wrapOptions: noSleep,
    ...over,
  };
}

describe('assembleProviders', () => {
  it('retries an indexer read answered 503 and logs one sanitised line per retry', async () => {
    let calls = 0;
    const warnings: string[] = [];
    const p = assembleProviders(
      parts({
        publicDataProvider: {
          queryBlock: async () => {
            calls++;
            if (calls < 3) throw http(503);
            return { height: 7 };
          },
        } as never,
        logger: { warn: (m) => warnings.push(m) },
      }),
    );
    await expect(p.publicDataProvider.queryBlock()).resolves.toEqual({ height: 7 });
    expect(calls).toBe(3);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^http5xx: Error: Response not successful.*; retry 1 in \d+ ms$/);
  });

  it('retries proving after a 503 answer but not after its own timeout', async () => {
    let calls = 0;
    const flaky = assembleProviders(
      parts({
        proofProvider: {
          supportedEras: ['v9'],
          proveTx: async () => {
            calls++;
            if (calls === 1) throw http(503);
            return 'proven';
          },
        } as never,
      }),
    );
    await expect(flaky.proofProvider.proveTx({} as never)).resolves.toBe('proven');
    expect(calls).toBe(2);

    let timeouts = 0;
    const slow = assembleProviders(
      parts({
        proofProvider: {
          supportedEras: ['v9'],
          proveTx: async () => {
            timeouts++;
            throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
          },
        } as never,
      }),
    );
    await expect(slow.proofProvider.proveTx({} as never)).rejects.toThrow(/may still be running on the proof server/);
    expect(timeouts).toBe(1);
  });

  it('submits once, never retries, and says the outcome is unknown without the URL', async () => {
    let calls = 0;
    const p = assembleProviders(
      parts({
        submit: async () => {
          calls++;
          throw Object.assign(new Error('fetch failed at https://rpc.example/?project_id=abc'), { code: 'ECONNRESET' });
        },
      }),
    );
    const err = await p.midnightProvider.submitTx(finalizedTx()).catch((e: unknown) => e);
    expect(calls).toBe(1);
    expect((err as Error).message).toMatch(/outcome unknown/);
    expect((err as Error).message).not.toMatch(/https?:|project_id=abc/);
  });

  it('passes the network id and TTL through', () => {
    const p = assembleProviders(parts({ networkId: 'preview', ttlSeconds: 1234 }));
    expect(p.config).toEqual({ networkId: 'preview', ttlSeconds: 1234 });
  });
});
