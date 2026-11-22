// This file is part of example-tenant-proof.
// Copyright (C) Midnight Foundation
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0 (the "License");
// You may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Returns the providers in an object which can be created for each user's individual tests
import { createLedger9WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { type MidnightWalletProvider } from './wallet.js';
import { type NetworkConfig } from './config.js';
import { type ImpureCircuits } from '../contract/index.js';
import { assembleProviders, type RetryLogger, type TenantProofProviders } from './provider-set.js';

export { ledgerState, type RetryLogger, type TenantProofProviders } from './provider-set.js';

// The set of callable circuit ids, derived from the compiled contract's
// generated types. This tracks whatever circuits your .compact exports, so you
// never have to edit this file when you add, remove, or rename a circuit.
export type TenantProofCircuits = keyof ImpureCircuits<unknown>;

// How long a built transaction stays valid, in seconds (Midnight.js 5's
// `config.ttlSeconds`).
const TX_TTL_SECONDS = Number(process.env['MIDNIGHT_TX_TTL_SECONDS'] ?? 3600);

/**
 * Where a provider set keeps private state and the contracts' signing keys.
 * `dbName` is the LevelDB directory, `storeName` the store inside it, and
 * `password` encrypts both (at least 16 characters, with 3 of: upper case,
 * lower case, digits, symbols).
 */
export type PrivateStateStore = {
  dbName: string;
  storeName: string;
  password: string;
};

/**
 * The providers for one contract. Without `privateState` the store is a
 * throwaway one for tests: a fresh name each call, under ./midnight-level-db.
 * scripts/deploy.ts passes a persistent store instead.
 *
 * Retries, timeouts and sanitised errors come from assembleProviders
 * (src/provider-set.ts), which the browser uses too: indexer reads and waits
 * retry transient failures with backoff; our layer retries proving only after
 * a refused connection or a 5xx/429 answer (not its own timeout or a reset,
 * which may leave the job running; the SDK's client below still re-sends
 * after a reset, see src/retry.ts); our layer never retries a submit. `logger`
 * receives a sanitised line per retry.
 */
export function buildProviders(
  wallet: MidnightWalletProvider,
  zkConfigPath: string,
  config: NetworkConfig,
  privateState?: PrivateStateStore,
  logger?: RetryLogger,
): TenantProofProviders {
  const zkConfigProvider = new NodeZkConfigProvider<TenantProofCircuits>(zkConfigPath);
  return assembleProviders({
    privateStateProvider: levelPrivateStateProvider({
      ...(privateState ? { midnightDbName: privateState.dbName } : {}),
      // The random suffix keeps each provider set's private-state store separate
      // when a test builds several sets (wallets, contracts) in the same millisecond.
      privateStateStoreName:
        privateState?.storeName ?? `tenant-proof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      // this password has requirements (capital/special chars >= 3)
      privateStoragePasswordProvider: () => privateState?.password ?? 'TenantProof-Test-Password',
      accountId: wallet.getCoinPublicKey(),
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(config.proofServer, zkConfigProvider),
    // Midnight.js 5 providers are tagged with the ledger eras they serve. The
    // wallet is ledger 9 only; this lifts it into the tagged interface.
    walletProvider: createLedger9WalletProvider(wallet),
    submit: (tx) => wallet.submitTx(tx),
    networkId: config.networkId,
    ttlSeconds: TX_TTL_SECONDS,
    ...(logger ? { logger } : {}),
  });
}
