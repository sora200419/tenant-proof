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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  deployContract,
  submitCallTx,
  type DeployedContract,
} from '@midnight-ntwrk/midnight-js-contracts';
import type { ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import { type EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import { MidnightWalletProvider, resolveWallet, syncWallet, waitForNightThenDust } from '../wallet.js';
import pino from 'pino';

import { getConfig } from '../config.js';
import { buildProviders, ledgerState, type TenantProofCircuits, type TenantProofProviders } from '../providers.js';
import { createTenantProofPrivateState, type TenantProofPrivateState } from '../../contract/witnesses.js';
import { applicationIdFor, issueAttestation, listingIdFromLabel, randomBytes32, tenantPublicKey } from '../attest.js';
import {
  CompiledTenantProofContract,
  Contract,
  ledger,
  zkConfigPath,
  // @generated-stub begin contract-imports sha=e3b0c44298fc
  // @generated-stub end contract-imports
} from '../../contract/index.js';
// Shielded-coin helpers, imported here when a circuit takes a coin or a
// second contract mints them. See ./coins.ts.
// @generated-stub begin coin-imports sha=e3b0c44298fc
// @generated-stub end coin-imports

// Required for GraphQL subscriptions in Node.js
// @ts-expect-error WebSocket global assignment for apollo
globalThis.WebSocket = WebSocket;

const PRIVATE_STATE_ID = 'AliceTenantProofState';

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport: { target: 'pino-pretty' },
});

const network = process.env['MIDNIGHT_NETWORK'] ?? 'local';

describe(`Tenant Proof Contract (${network})`, () => {
  let wallet: MidnightWalletProvider;
  let providers: TenantProofProviders;
  let contractAddress: ContractAddress;
  // @generated-stub begin contract-providers sha=e3b0c44298fc
  // @generated-stub end contract-providers

  const config = getConfig();
  const isRemote = network !== 'local';
  // A wallet syncs from genesis the first time (saved state makes later runs
  // fast): the timeout covers that first sync.
  const syncTimeoutMs = Number(
    process.env['MIDNIGHT_SYNC_TIMEOUT_MS'] ?? (isRemote ? 120 * 60_000 : 10 * 60_000),
  );

  // Reads the contract's public ledger state.
  // @generated-stub begin ledger-fields sha=09a93f9179d3
  // Public ledger fields:
  //   issuerPk: Bytes<32>
  //   attestations: HistoricMerkleTree
  //   attestationCount: Counter
  //   listings: Map<Bytes<32>, Uint<0..4294967295>>
  //   applications: Map<Bytes<32>, Bytes<32>>
  // @generated-stub end ledger-fields
  async function queryLedger() {
    const state = await providers.publicDataProvider.queryContractState(contractAddress);
    expect(state).not.toBeNull();
    return ledger(ledgerState(state));
  }

  beforeAll(async () => {
    setNetworkId(config.networkId);

    const envConfig: EnvironmentConfiguration = {
      walletNetworkId: config.networkId,
      networkId: config.networkId,
      indexer: config.indexer,
      indexerWS: config.indexerWS,
      node: config.node,
      nodeWS: config.nodeWS,
      faucet: config.faucet,
      proofServer: config.proofServer,
    };

    // Locally this is the genesis-funded Alice seed. On a remote network it is
    // the shared Alice wallet from the repo-root .env.<network>, which syncs
    // from genesis (over an hour on preprod). Pass a role name
    // (e.g. resolveWallet(network, 'BOB')) if your suite needs more than one.
    const setup = resolveWallet(network);
    wallet = await MidnightWalletProvider.build(logger, envConfig, setup.secret);
    await wallet.start();
    await syncWallet(logger, wallet.wallet, syncTimeoutMs);

    if (isRemote) {
      // Synced is not funded: a wallet with no DUST fails its first submit.
      await waitForNightThenDust(
        logger,
        wallet.wallet,
        wallet.unshieldedKeystore,
        envConfig,
        config.faucet,
        { label: setup.role },
      );
    }

    providers = buildProviders(wallet, zkConfigPath, config);
    // @generated-stub begin contract-providers-init sha=e3b0c44298fc
    // @generated-stub end contract-providers-init
    logger.info(`Providers initialized on '${network}'. Ready to test!`);
  });

  afterAll(async () => {
    if (wallet) {
      logger.info('Stopping wallet...');
      await wallet.stop();
    }
  });

  // ---------------------------------------------------------------------------
  // Everything above is generated boilerplate. Your tests begin here.
  // ---------------------------------------------------------------------------

  // Other contracts first: a test-only token usually feeds this contract's
  // constructor (its token color, say).
  // @generated-stub begin contract-deploys sha=e3b0c44298fc
  // @generated-stub end contract-deploys

  // One wallet pays the fees; the three roles differ only in private state.
  const ISSUER_SK = randomBytes32();
  const LANDLORD_ID = 'LandlordTenantProofState';
  const TENANT_ID = 'TenantTenantProofState';
  const POOR_TENANT_ID = 'PoorTenantProofState';
  const ROOM = listingIdFromLabel(`room-${Date.now()}`);
  const RENT = 1500n;

  const call = (privateStateId: string, circuitId: TenantProofCircuits, args: unknown[]) =>
    submitCallTx(providers, {
      compiledContract: CompiledTenantProofContract,
      contractAddress,
      privateStateId,
      circuitId,
      args,
    } as never);

  const setPrivateState = (id: string, state: TenantProofPrivateState) =>
    providers.privateStateProvider.forContract(contractAddress).set(id, state);

  /** Issuer attests a new tenant off-chain + on-chain; returns the tenant's private state. */
  const attestTenant = async (income: bigint): Promise<TenantProofPrivateState> => {
    const sk = randomBytes32();
    const att = issueAttestation(income, tenantPublicKey(sk));
    await call(PRIVATE_STATE_ID, 'attest', [att.leaf]);
    return createTenantProofPrivateState(sk, att.income, att.salt);
  };

  it('deploys the contract with the deployer as issuer', async () => {
    const deployed: DeployedContract<Contract> = await deployContract(providers, {
      compiledContract: CompiledTenantProofContract,
      privateStateId: PRIVATE_STATE_ID,
      // @generated-stub begin private-state sha=edited
      initialPrivateState: createTenantProofPrivateState(ISSUER_SK),
      // @generated-stub end private-state
      // @generated-stub begin constructor-args sha=e3b0c44298fc
      // @generated-stub end constructor-args
    });

    contractAddress = deployed.deployTxData.public.contractAddress;
    logger.info(`Contract deployed at: ${contractAddress}`);
    expect(contractAddress.length).toBeGreaterThan(0);
    expect((await queryLedger()).issuerPk).toEqual(tenantPublicKey(ISSUER_SK));
  });

  it('landlord lists a room', async () => {
    await setPrivateState(LANDLORD_ID, createTenantProofPrivateState(randomBytes32()));
    await call(LANDLORD_ID, 'createListing', [ROOM, RENT]);
    expect((await queryLedger()).listings.lookup(ROOM)).toBe(RENT);
  });

  it('a tenant earning 3x the rent proves eligibility without revealing income', async () => {
    const tenant = await attestTenant(5200n);
    await setPrivateState(TENANT_ID, tenant);
    await call(TENANT_ID, 'apply', [ROOM]);
    const l = await queryLedger();
    expect(l.applications.member(applicationIdFor(ROOM, tenant.secretKey))).toBe(true);
    expect(l.attestationCount).toBe(1n);
  });

  it('a tenant earning less than 3x the rent is rejected before anything is submitted', async () => {
    const poor = await attestTenant(4000n);
    await setPrivateState(POOR_TENANT_ID, poor);
    await expect(call(POOR_TENANT_ID, 'apply', [ROOM])).rejects.toThrow('Income is below 3x the rent');
    expect((await queryLedger()).applications.size()).toBe(1n);
  });
});
