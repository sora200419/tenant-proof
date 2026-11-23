// This file is part of TenantProof.
// SPDX-License-Identifier: Apache-2.0
//
// Puts one contract's provider set together and runs its network calls through
// src/retry.ts. Shared by the Node side (buildProviders in src/providers.ts)
// and the browser (frontend/src/lib/network-client.ts), so both get the same
// retries, timeouts and sanitised errors. Browser-safe: no node:* imports and
// no `process`.
import {
  createLedger9MidnightProvider,
  type ContractStateRead,
  type LedgerTransaction,
  type MidnightProviders,
  type PrivateStateProvider,
  type ProofProvider,
  type PublicDataProvider,
  type WalletProvider,
  type ZKConfigProvider,
} from '@midnight-ntwrk/midnight-js-types';
import { ContractState } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import { type TransactionId } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { DEFAULT_WRAP_OPTIONS, wrapProofProvider, wrapPublicDataProvider, wrapSubmit, type WrapOptions } from './retry.js';

/** Where retry warnings go: a pino logger or anything with `warn(string)`. */
export type RetryLogger = { warn: (message: string) => void };

export type TenantProofProviders = MidnightProviders<any>;

export type ProviderParts = {
  privateStateProvider: PrivateStateProvider<any, any>;
  publicDataProvider: PublicDataProvider;
  zkConfigProvider: ZKConfigProvider<any>;
  proofProvider: ProofProvider;
  walletProvider: WalletProvider;
  /** Sends a balanced, signed transaction to the network. Never retried. */
  submit: (tx: LedgerTransaction<'Finalized', 'v9'>) => Promise<TransactionId>;
  networkId: string;
  /** How long a built transaction stays valid (Midnight.js 5's `config.ttlSeconds`). */
  ttlSeconds: number;
  logger?: RetryLogger;
  /** Tests only: replaces the retry policy (fake sleep, fewer attempts). */
  wrapOptions?: WrapOptions;
};

/**
 * The provider set for one contract. Indexer reads and waits retry transient
 * failures with backoff; our layer retries proving only after a refused
 * connection or a 5xx/429 answer (see src/retry.ts for what the SDK's client
 * does underneath); a submit is never retried. `logger` gets one sanitised
 * line per retry.
 */
export function assembleProviders(parts: ProviderParts): TenantProofProviders {
  const base = parts.wrapOptions ?? DEFAULT_WRAP_OPTIONS;
  const opts: WrapOptions = {
    ...base,
    onRetry:
      base.onRetry ??
      (({ attempt, delayMs, reason }) => parts.logger?.warn(`${reason}; retry ${attempt} in ${delayMs} ms`)),
  };
  return {
    privateStateProvider: parts.privateStateProvider,
    publicDataProvider: wrapPublicDataProvider(parts.publicDataProvider, opts),
    zkConfigProvider: parts.zkConfigProvider,
    proofProvider: wrapProofProvider(parts.proofProvider, opts),
    walletProvider: parts.walletProvider,
    midnightProvider: createLedger9MidnightProvider(wrapSubmit(parts.submit)),
    config: { networkId: parts.networkId, ttlSeconds: parts.ttlSeconds },
  };
}

/**
 * The public ledger state of a contract read with queryContractState, for the
 * compiled `ledger()` to decode. Midnight.js 5 hands back the serialized state
 * tagged with the ledger era that wrote it; every contract here is deployed on
 * ledger 9, so only a ledger 9 decoder is given.
 */
export function ledgerState(read: ContractStateRead | null) {
  if (read === null) throw new Error('contract state not found');
  if (read.contractState.era !== 'v9') throw new Error('expected a ledger 9 contract state');
  return read.contractState.deserialize({ v9: ContractState }).data;
}
