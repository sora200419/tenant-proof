// This file is part of TenantProof.
// SPDX-License-Identifier: Apache-2.0
//
// Talks to a browser wallet (Lace) through the Midnight dApp connector API
// (@midnightntwrk/dapp-connector-api 4.x) and lifts it into the Midnight.js 5
// wallet and submit providers. Browser-safe: no node:* imports, no `process`.
//
// What the connector does and does not do (read in the installed 4.1.0 types):
// - wallets put an InitialAPI under `window.midnight[<uuid>]`; `connect(networkId)`
//   returns the ConnectedAPI;
// - transactions cross as hex strings (wallet-sdk-facade 2.0.0, which wallets
//   build on, adopts "a dApp connector's serialized transaction ... as hex");
// - `balanceUnsealedTransaction` takes a proven, not yet bound transaction
//   (Midnight.js's Unbound stage) and returns it balanced and sealed;
// - `submitTransaction` returns nothing, so the transaction id is read from the
//   transaction before it is sent;
// - the wallet can prove too (`getProvingProvider`), but this app never asks it
//   to: proofs are built by the user's own proof server (LOCAL_PROOF_SERVER),
//   and the wallet's `proverServerUri` setting is ignored.
import type { ConnectedAPI, InitialAPI } from '@midnightntwrk/dapp-connector-api';
import {
  MidnightBech32m,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from '@midnightntwrk/wallet-sdk-address-format';
import { createLedger9WalletProvider, type LedgerTransaction, type WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import { Transaction, type TransactionId } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { redactText, SanitizedError, sanitizeError, withTimeout } from './retry.js';

/** The connector API major version this app is written against. */
export const SUPPORTED_API_MAJOR = 4;

/**
 * The proof server the UI uses. It receives the private inputs of every proof
 * (a tenant's income and salt), so it must run on the user's own machine.
 */
export const LOCAL_PROOF_SERVER = 'http://127.0.0.1:6300';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Returns `url` if it points at this machine; throws otherwise. */
export function assertLoopbackUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Proof server address is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Proof server address must use http or https');
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      'Refusing a proof server that is not on this computer: it would receive your private inputs (income and salt)',
    );
  }
  return url;
}

/** Timeouts, in ms. Calls that wait for the user to approve something in the wallet get longer. */
export const WALLET_TIMEOUTS = {
  approval: 5 * 60_000,
  read: 30_000,
  submit: 2 * 60_000,
};

export type WalletTimeouts = typeof WALLET_TIMEOUTS;

export type WalletChoice = { key: string; name: string; rdns: string; apiVersion: string; api: InitialAPI };
export type IncompatibleWallet = { key: string; name: string; apiVersion: string };

function majorOf(version: string): number | undefined {
  const m = /^(\d+)\./.exec(version);
  return m ? Number(m[1]) : undefined;
}

/**
 * The wallets injected under `window.midnight`, split by whether they speak
 * connector API 4.x. Names are wallet-supplied text: show them as text only.
 */
export function listWallets(midnight: Record<string, InitialAPI> | undefined): {
  compatible: WalletChoice[];
  incompatible: IncompatibleWallet[];
} {
  const compatible: WalletChoice[] = [];
  const incompatible: IncompatibleWallet[] = [];
  for (const [key, api] of Object.entries(midnight ?? {})) {
    if (typeof api !== 'object' || api === null || typeof api.connect !== 'function') continue;
    const name = typeof api.name === 'string' ? api.name : 'Unnamed wallet';
    const apiVersion = typeof api.apiVersion === 'string' ? api.apiVersion : 'unknown';
    if (majorOf(apiVersion) === SUPPORTED_API_MAJOR) {
      compatible.push({ key, name, rdns: typeof api.rdns === 'string' ? api.rdns : '', apiVersion, api });
    } else {
      incompatible.push({ key, name, apiVersion });
    }
  }
  return { compatible, incompatible };
}

/** A connected wallet on the expected network, with what the providers need from it. */
export type WalletSession = {
  connected: ConnectedAPI;
  networkId: string;
  indexerUri: string;
  indexerWsUri: string;
  /** Hex, as Midnight.js expects. */
  coinPublicKey: string;
  encryptionPublicKey: string;
  timeouts: WalletTimeouts;
};

/** Methods this app calls, hinted to the wallet so it can ask for permission up front. */
const USED_METHODS = [
  'getShieldedAddresses',
  'getConfiguration',
  'getConnectionStatus',
  'balanceUnsealedTransaction',
  'submitTransaction',
] as const;

/**
 * Connects to `initial` on `networkId` and checks the wallet really is on that
 * network. Mainnet is refused before the wallet is asked anything.
 */
export async function connectWallet(
  initial: InitialAPI,
  networkId: string,
  timeouts: WalletTimeouts = WALLET_TIMEOUTS,
): Promise<WalletSession> {
  if (networkId === 'mainnet') throw new Error('Mainnet is out of scope for this app; use Preview');
  const step = async <T>(label: string, ms: number, call: () => Promise<T>): Promise<T> => {
    try {
      return await withTimeout(call(), label, ms);
    } catch (err) {
      throw describeWalletError(err, label);
    }
  };
  const connected = await step('connect to the wallet', timeouts.approval, () => initial.connect(networkId));
  // The API type has `hintUsage`, but a wallet may not implement it (the Lace
  // 4.1.0-canary seen on 2026-11-22 does not): it is only a hint for up-front
  // permissions, so skip it when absent; the wallet asks when a method is used.
  if (typeof connected.hintUsage === 'function') {
    await step('ask the wallet for permissions', timeouts.approval, () => connected.hintUsage([...USED_METHODS]));
  }
  const status = await step('read the wallet connection status', timeouts.read, () => connected.getConnectionStatus());
  if (status.status !== 'connected') throw new Error('The wallet reports it is disconnected; connect again');
  if (status.networkId !== networkId) {
    throw new Error(`The wallet is on network "${status.networkId}", not "${networkId}". Switch Lace to ${networkId}`);
  }
  const config = await step('read the wallet configuration', timeouts.read, () => connected.getConfiguration());
  if (config.networkId !== networkId) {
    throw new Error(`The wallet is configured for "${config.networkId}", not "${networkId}". Switch Lace to ${networkId}`);
  }
  const addresses = await step('read the wallet keys', timeouts.read, () => connected.getShieldedAddresses());
  let coinPublicKey: string;
  let encryptionPublicKey: string;
  try {
    coinPublicKey = ShieldedCoinPublicKey.codec
      .decode(networkId, MidnightBech32m.parse(addresses.shieldedCoinPublicKey))
      .toHexString();
    encryptionPublicKey = ShieldedEncryptionPublicKey.codec
      .decode(networkId, MidnightBech32m.parse(addresses.shieldedEncryptionPublicKey))
      .toHexString();
  } catch (err) {
    throw sanitizeError(err, `The wallet's shielded keys are not valid ${networkId} keys`);
  }
  return {
    connected,
    networkId,
    indexerUri: config.indexerUri,
    indexerWsUri: config.indexerWsUri,
    coinPublicKey,
    encryptionPublicKey,
    timeouts,
  };
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error('The wallet returned a transaction that is not hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * The wallet provider and submit function Midnight.js needs, backed by the
 * connected wallet. The wallet balances (pays fees in DUST) and seals; the
 * wallet's own TTL applies (the connector takes none). `submit` is not retried
 * here or by assembleProviders: a failed submit may still land.
 */
export function walletProviders(session: WalletSession): {
  walletProvider: WalletProvider;
  submit: (tx: LedgerTransaction<'Finalized', 'v9'>) => Promise<TransactionId>;
} {
  const { connected, timeouts } = session;
  const walletProvider = createLedger9WalletProvider({
    balanceTx: async (tx) => {
      const label = 'balance the transaction in the wallet (approve it in Lace)';
      try {
        const { tx: balanced } = await withTimeout(
          connected.balanceUnsealedTransaction(bytesToHex(tx.serialize())),
          label,
          timeouts.approval,
        );
        return hexToBytes(balanced);
      } catch (err) {
        throw describeWalletError(err, label);
      }
    },
    getCoinPublicKey: () => session.coinPublicKey,
    getEncryptionPublicKey: () => session.encryptionPublicKey,
  });
  const submit = async (tx: LedgerTransaction<'Finalized', 'v9'>): Promise<TransactionId> => {
    const id = tx.deserialize({ v9: Transaction }).identifiers()[0];
    if (id === undefined) throw new Error('The balanced transaction has no identifier; it was not submitted');
    const label = 'submit the transaction through the wallet';
    try {
      await withTimeout(connected.submitTransaction(bytesToHex(tx.serialize())), label, timeouts.submit);
    } catch (err) {
      throw describeWalletError(err, `${label} (transaction ${id})`);
    }
    return id;
  };
  return { walletProvider, submit };
}

type ConnectorError = { type: 'DAppConnectorAPIError'; code: string; reason?: unknown };

const isConnectorError = (err: unknown): err is ConnectorError =>
  typeof err === 'object' &&
  err !== null &&
  (err as { type?: unknown }).type === 'DAppConnectorAPIError' &&
  typeof (err as { code?: unknown }).code === 'string';

const CONNECTOR_MESSAGES: Record<string, string> = {
  Rejected: 'you declined the request in the wallet',
  PermissionRejected: 'the wallet did not grant this app permission',
  InsufficientFunds: 'the wallet has too little DUST to pay the fee; get tNIGHT from the Preview faucet and wait for DUST',
  Disconnected: 'the wallet connection was lost; connect again',
  InvalidRequest: 'the wallet refused the request as invalid',
  InternalError: 'the wallet failed internally',
};

/**
 * An error the UI can show and log: which step failed and why, with no URL,
 * stack or wallet-supplied object attached. A connector error's code is kept
 * as `upstreamCode` (for example `Rejected`).
 */
export function describeWalletError(err: unknown, step: string): Error {
  if (isConnectorError(err)) {
    // The wallet's own `reason` text is not shown: it is wallet-supplied and unbounded.
    const known = CONNECTOR_MESSAGES[err.code];
    return new SanitizedError(redactText(`Could not ${step}: ${known ?? `wallet error ${err.code}`}`), { code: err.code });
  }
  return sanitizeError(err, `Could not ${step}`);
}
