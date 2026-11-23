// Wallet mode: the TenantProof contract on a real network (Preview), through
// the user's Lace wallet and the proof server on the user's own machine.
//
// One instance serves ONE role (issuer, landlord or tenant). Its private state
// (that role's secret key and, for a tenant, the issuer credential) is kept in
// this browser's IndexedDB, in a store named for the role and scoped to the
// connected wallet's key, encrypted with a password the user types each
// session. Nothing of another role is loaded.
//
// Provider assembly (retries, timeouts, sanitised errors) is the same code the
// Node side uses: assembleProviders in src/provider-set.ts.
import { deployContract, submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import type { ProofProvider, WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import { ledger } from '../../../contract/managed/tenant-proof/contract/index.js';
import { BrowserTenantProofContract } from '../../../contract/browser';
import { createTenantProofPrivateState, type TenantProofPrivateState } from '../../../contract/witnesses';
import { applicationIdFor, issueAttestation, listingIdFromLabel, randomBytes32, tenantPublicKey } from '../../../src/attest';
import { assembleProviders, ledgerState, type TenantProofProviders } from '../../../src/provider-set';
import { LOCAL_PROOF_SERVER, assertLoopbackUrl, walletProviders, type WalletSession } from '../../../src/dapp-wallet';
import { snapshotFromLedger, toHex, type LedgerSnapshot } from './client';

export type Role = 'issuer' | 'landlord' | 'tenant';

/** Where one transaction is. `proving` runs on this computer; `wallet` waits for the user in Lace. */
export type TxStage =
  | { stage: 'proving' }
  | { stage: 'wallet' }
  | { stage: 'submitted'; txId: string }
  | { stage: 'confirmed'; txId: string; txHash: string; blockHeight: number };

export type TxResult = { txId: string; txHash: string; blockHeight: number };

/** Where the UI fetches proving keys and ZKIR (served by the dev server only; see vite.config.ts). */
export const ZK_ARTIFACTS_PATH = '/zk/';

/** Which proof server the page talks to. In dev it goes through the dev server's proxy to LOCAL_PROOF_SERVER. */
export const proofServerUrl = (origin: string): string =>
  // The dev proxy forwards to 127.0.0.1 of the machine running the dev server, so
  // it is the user's own proof server only if the page is also opened on that
  // machine: refuse any other origin (for example the dev server run with --host).
  import.meta.env.DEV ? `${assertLoopbackUrl(origin)}/proof-server` : assertLoopbackUrl(LOCAL_PROOF_SERVER);

const TX_TTL_SECONDS = 3600;
const NETWORK_ID = 'preview';

const storeName = (role: Role) => `tenant-proof-${role}`;
/** Private-state ids inside a role's store. A tenant can hold several identities, each its own id. */
export const privateStateIdFor = (role: Role, tenantName?: string) =>
  role === 'tenant' ? `tenant:${tenantName ?? 'default'}` : role;

export class TenantProofNetwork {
  private onStage: (s: TxStage) => void = () => undefined;
  private readonly providers: TenantProofProviders;

  private constructor(
    readonly role: Role,
    readonly session: WalletSession,
    password: string,
    origin: string,
  ) {
    // The provider calls `this.fetchFunc(...)`; the browser's fetch refuses a
    // `this` other than window ("Illegal invocation"), so pass a bound one.
    // Integrity stays at the default 'require': every file is checked against
    // compiler/contract-manifest.json.
    const zkConfigProvider = new FetchZkConfigProvider<string>(`${origin}${ZK_ARTIFACTS_PATH}`, {
      fetchFunc: (input, init) => window.fetch(input, init),
    });
    const { walletProvider, submit } = walletProviders(session);
    const baseProof = httpClientProofProvider({ url: proofServerUrl(origin), zkConfigProvider });
    // Report the stage each provider reaches, so the UI can tell CPU time from waiting on Lace.
    const proofProvider: ProofProvider = {
      supportedEras: baseProof.supportedEras,
      proveTx: (tx, cfg) => {
        this.onStage({ stage: 'proving' });
        return baseProof.proveTx(tx, cfg);
      },
    };
    const stagedWallet: WalletProvider = {
      supportedEras: walletProvider.supportedEras,
      balanceTx: (tx, ttl) => {
        this.onStage({ stage: 'wallet' });
        return walletProvider.balanceTx(tx, ttl);
      },
      getCoinPublicKey: () => walletProvider.getCoinPublicKey(),
      getEncryptionPublicKey: () => walletProvider.getEncryptionPublicKey(),
    };
    this.providers = assembleProviders({
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: storeName(role),
        signingKeyStoreName: `${storeName(role)}-signing-keys`,
        privateStoragePasswordProvider: () => password,
        accountId: session.coinPublicKey,
      }),
      publicDataProvider: indexerPublicDataProvider({
        queryURL: session.indexerUri,
        subscriptionURL: session.indexerWsUri,
      }),
      zkConfigProvider,
      proofProvider,
      walletProvider: stagedWallet,
      submit: async (tx) => {
        const txId = await submit(tx);
        this.onStage({ stage: 'submitted', txId });
        return txId;
      },
      networkId: NETWORK_ID,
      ttlSeconds: TX_TTL_SECONDS,
      logger: { warn: (m) => console.warn(m) },
    });
  }

  static open(role: Role, session: WalletSession, password: string, origin = window.location.origin) {
    if (session.networkId !== NETWORK_ID) throw new Error(`Wallet mode runs on ${NETWORK_ID} only`);
    return new TenantProofNetwork(role, session, password, origin);
  }

  private privateStates(address: string) {
    return this.providers.privateStateProvider.forContract(address);
  }

  /** The private state for `id` on this contract, created with a fresh secret key the first time. */
  async ensurePrivateState(address: string, id: string): Promise<TenantProofPrivateState> {
    const states = this.privateStates(address);
    const existing = (await states.get(id)) as TenantProofPrivateState | null;
    if (existing) return existing;
    const fresh = createTenantProofPrivateState(randomBytes32());
    await states.set(id, fresh);
    return fresh;
  }

  async setTenantCredential(address: string, id: string, income: bigint, salt: Uint8Array): Promise<void> {
    const current = await this.ensurePrivateState(address, id);
    await this.privateStates(address).set(id, createTenantProofPrivateState(current.secretKey, income, salt));
  }

  async snapshot(address: string): Promise<LedgerSnapshot> {
    const read = await this.providers.publicDataProvider.queryContractState(address);
    return snapshotFromLedger(ledger(ledgerState(read)));
  }

  private async call(
    address: string,
    privateStateId: string,
    circuitId: 'attest' | 'createListing' | 'apply',
    args: unknown[],
    onStage: (s: TxStage) => void,
  ): Promise<TxResult> {
    this.onStage = onStage;
    try {
      const res = await submitCallTx(this.providers as never, {
        compiledContract: BrowserTenantProofContract,
        contractAddress: address,
        privateStateId,
        circuitId,
        args,
      } as never);
      const pub = (res as { public: TxResult }).public;
      const result = { txId: pub.txId, txHash: pub.txHash, blockHeight: pub.blockHeight };
      onStage({ stage: 'confirmed', ...result });
      return result;
    } finally {
      this.onStage = () => undefined;
    }
  }

  /** Issuer: deploys a new contract. A fresh issuer secret is kept in this browser only. */
  async deploy(onStage: (s: TxStage) => void): Promise<TxResult & { address: string }> {
    if (this.role !== 'issuer') throw new Error('Only the issuer role deploys');
    this.onStage = onStage;
    try {
      const deployed = await deployContract(this.providers as never, {
        compiledContract: BrowserTenantProofContract,
        privateStateId: privateStateIdFor('issuer'),
        initialPrivateState: createTenantProofPrivateState(randomBytes32()),
      } as never);
      const pub = (deployed as { deployTxData: { public: TxResult & { contractAddress: string } } }).deployTxData.public;
      const result = { txId: pub.txId, txHash: pub.txHash, blockHeight: pub.blockHeight, address: pub.contractAddress };
      onStage({ stage: 'confirmed', txId: result.txId, txHash: result.txHash, blockHeight: result.blockHeight });
      return result;
    } finally {
      this.onStage = () => undefined;
    }
  }

  /** Issuer: publishes the commitment for a tenant. Returns the credential to hand to the tenant off-chain. */
  async attest(
    address: string,
    tenantPkHex: string,
    income: bigint,
    onStage: (s: TxStage) => void,
    /** Called with the credential BEFORE the transaction is built: if the page dies after the commitment lands, the salt is not lost. */
    onCredential: (c: { leafHex: string; saltHex: string }) => void,
  ) {
    const att = issueAttestation(income, hexBytes(tenantPkHex));
    onCredential({ leafHex: toHex(att.leaf), saltHex: toHex(att.salt) });
    const tx = await this.call(address, privateStateIdFor('issuer'), 'attest', [att.leaf], onStage);
    return { tx, leafHex: toHex(att.leaf), saltHex: toHex(att.salt) };
  }

  async createListing(address: string, label: string, rent: bigint, onStage: (s: TxStage) => void) {
    await this.ensurePrivateState(address, privateStateIdFor('landlord'));
    return this.call(address, privateStateIdFor('landlord'), 'createListing', [listingIdFromLabel(label.trim()), rent], onStage);
  }

  async apply(address: string, tenantId: string, label: string, onStage: (s: TxStage) => void) {
    const id = listingIdFromLabel(label.trim());
    const state = await this.ensurePrivateState(address, tenantId);
    const tx = await this.call(address, tenantId, 'apply', [id], onStage);
    return { tx, applicationIdHex: toHex(applicationIdFor(id, state.secretKey)) };
  }

  /** The tenant's public key for this identity: what the tenant gives the issuer (never the secret). */
  async tenantPublicKeyHex(address: string, tenantId: string): Promise<string> {
    return toHex(tenantPublicKey((await this.ensurePrivateState(address, tenantId)).secretKey));
  }
}

function hexBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error('Tenant public key must be 32 bytes of hex');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
