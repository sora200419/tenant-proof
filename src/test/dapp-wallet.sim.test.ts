// This file is part of TenantProof.
// SPDX-License-Identifier: Apache-2.0
//
// The dApp-connector adapter (src/dapp-wallet.ts) against a fake ConnectedAPI.
// Transactions are real ledger-v9 transactions (an intent with no actions,
// proven with nothing to prove), so the hex round trip and the stage checks
// Midnight.js applies are the real ones. Fixed data only.
import { describe, expect, it, vi } from 'vitest';
import type { ConnectedAPI, InitialAPI } from '@midnightntwrk/dapp-connector-api';
import {
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from '@midnightntwrk/wallet-sdk-address-format';
import { LedgerTransaction } from '@midnight-ntwrk/midnight-js-types';
import { CostModel, Intent, Transaction } from '@midnight-ntwrk/midnight-js-protocol/v9';
import {
  LOCAL_PROOF_SERVER,
  assertLoopbackUrl,
  bytesToHex,
  connectWallet,
  describeWalletError,
  hexToBytes,
  listWallets,
  walletProviders,
  type WalletTimeouts,
} from '../dapp-wallet.js';

const NETWORK = 'preview';
const FIXED_TTL = new Date(Date.UTC(2030, 0, 1));
const FAST: WalletTimeouts = { approval: 50, read: 50, submit: 50 };

const COIN_PK_HEX = '11'.repeat(32);
const ENC_PK_HEX = '22'.repeat(32);
const bech = (network: string) => ({
  shieldedAddress: 'unused',
  shieldedCoinPublicKey: ShieldedCoinPublicKey.codec
    .encode(network, ShieldedCoinPublicKey.fromHexString(COIN_PK_HEX))
    .asString(),
  shieldedEncryptionPublicKey: ShieldedEncryptionPublicKey.codec
    .encode(network, ShieldedEncryptionPublicKey.fromHexString(ENC_PK_HEX))
    .asString(),
});

const connectorError = (code: string) =>
  Object.assign(new Error(`wallet says ${code} at https://lace.example/secret?project_id=abc`), {
    type: 'DAppConnectorAPIError' as const,
    code,
    reason: 'wallet-supplied text',
  });

/** A proven, unbound ledger-v9 transaction: one intent, no actions, so proving needs no keys. */
async function unboundTx(): Promise<LedgerTransaction<'Unbound', 'v9'>> {
  const unproven = Transaction.fromParts(NETWORK, undefined, undefined, Intent.new(FIXED_TTL));
  const noProving = {
    check: async () => [],
    prove: async () => {
      throw new Error('nothing should be proven');
    },
    lookupKey: async () => undefined,
  };
  const proven = await unproven.prove(noProving, CostModel.initialCostModel());
  return LedgerTransaction.seal('v9', 'Unbound', proven);
}

/** What a wallet does in balanceUnsealedTransaction, minus the fees: decode the hex, bind, encode. */
const fakeBalance = (hex: string) =>
  bytesToHex(Transaction.deserialize('signature', 'proof', 'pre-binding', hexToBytes(hex)).bind().serialize());

type Fake = ConnectedAPI & { calls: string[] };

function fakeConnected(over: Partial<ConnectedAPI> = {}, network = NETWORK): Fake {
  const calls: string[] = [];
  const track =
    <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) =>
    (...a: A) => {
      calls.push(name);
      return fn(...a);
    };
  const base = {
    hintUsage: track('hintUsage', async () => undefined),
    getConnectionStatus: track('getConnectionStatus', async () => ({ status: 'connected' as const, networkId: network })),
    getConfiguration: track('getConfiguration', async () => ({
      indexerUri: 'https://indexer.example/api/v4/graphql',
      indexerWsUri: 'wss://indexer.example/api/v4/graphql/ws',
      substrateNodeUri: 'https://node.example',
      networkId: network,
      proverServerUri: 'https://remote-prover.example',
    })),
    getShieldedAddresses: track('getShieldedAddresses', async () => bech(network)),
    balanceUnsealedTransaction: track('balanceUnsealedTransaction', async (tx: string) => ({ tx: fakeBalance(tx) })),
    submitTransaction: track('submitTransaction', async () => undefined),
  };
  return Object.assign({ calls }, base, over) as unknown as Fake;
}

function fakeInitial(connected: ConnectedAPI, apiVersion = '4.1.0'): InitialAPI & { connect: ReturnType<typeof vi.fn> } {
  return {
    rdns: 'io.lace.test',
    name: 'Fake Lace',
    icon: 'data:,',
    apiVersion,
    connect: vi.fn(async () => connected),
  };
}

describe('assertLoopbackUrl', () => {
  it('accepts this machine only', () => {
    expect(assertLoopbackUrl(LOCAL_PROOF_SERVER)).toBe(LOCAL_PROOF_SERVER);
    expect(assertLoopbackUrl('http://localhost:6300')).toBe('http://localhost:6300');
    expect(assertLoopbackUrl('http://[::1]:6300')).toBe('http://[::1]:6300');
  });

  it('refuses a remote proof server, look-alike hosts and other schemes', () => {
    for (const url of [
      'https://prover.example.com',
      'http://127.0.0.1.evil.example:6300',
      'http://localhost.evil.example',
      'http://10.0.0.5:6300',
      'ftp://127.0.0.1:6300',
      'not a url',
    ]) {
      expect(() => assertLoopbackUrl(url), url).toThrow(/proof server/i);
    }
  });
});

describe('listWallets', () => {
  it('splits wallets by connector API major version and skips junk entries', () => {
    const c = fakeConnected();
    const { compatible, incompatible } = listWallets({
      a: fakeInitial(c, '4.1.0'),
      b: fakeInitial(c, '3.0.0'),
      junk: 'not a wallet' as never,
    });
    expect(compatible.map((w) => w.key)).toEqual(['a']);
    expect(incompatible).toEqual([{ key: 'b', name: 'Fake Lace', apiVersion: '3.0.0' }]);
    expect(listWallets(undefined)).toEqual({ compatible: [], incompatible: [] });
  });
});

describe('connectWallet', () => {
  it('connects on the expected network and decodes the shielded keys to hex', async () => {
    const c = fakeConnected();
    const initial = fakeInitial(c);
    const s = await connectWallet(initial, NETWORK, FAST);
    expect(initial.connect).toHaveBeenCalledWith(NETWORK);
    expect(s.coinPublicKey).toBe(COIN_PK_HEX);
    expect(s.encryptionPublicKey).toBe(ENC_PK_HEX);
    expect(s.indexerUri).toBe('https://indexer.example/api/v4/graphql');
    expect(c.calls[0]).toBe('hintUsage');
  });

  it('connects to a wallet that does not implement hintUsage', async () => {
    const c = fakeConnected();
    delete (c as { hintUsage?: unknown }).hintUsage;
    const s = await connectWallet(fakeInitial(c), NETWORK, FAST);
    expect(s.coinPublicKey).toBe(COIN_PK_HEX);
  });

  it('refuses mainnet before asking the wallet anything', async () => {
    const initial = fakeInitial(fakeConnected({}, 'mainnet'));
    await expect(connectWallet(initial, 'mainnet', FAST)).rejects.toThrow(/Mainnet is out of scope/);
    expect(initial.connect).not.toHaveBeenCalled();
  });

  it('refuses a wallet whose connection is on another network', async () => {
    const c = fakeConnected({
      getConnectionStatus: async () => ({ status: 'connected', networkId: 'preprod' }),
    });
    await expect(connectWallet(fakeInitial(c), NETWORK, FAST)).rejects.toThrow(/on network "preprod", not "preview"/);
  });

  it('refuses a wallet configured for another network', async () => {
    const c = fakeConnected({
      getConfiguration: async () => ({
        indexerUri: 'x',
        indexerWsUri: 'y',
        substrateNodeUri: 'z',
        networkId: 'preprod',
      }),
    });
    await expect(connectWallet(fakeInitial(c), NETWORK, FAST)).rejects.toThrow(/configured for "preprod"/);
  });

  it('refuses a disconnected wallet', async () => {
    const c = fakeConnected({ getConnectionStatus: async () => ({ status: 'disconnected' }) });
    await expect(connectWallet(fakeInitial(c), NETWORK, FAST)).rejects.toThrow(/disconnected/);
  });

  it('refuses keys encoded for another network', async () => {
    const c = fakeConnected({ getShieldedAddresses: async () => bech('preprod') });
    await expect(connectWallet(fakeInitial(c), NETWORK, FAST)).rejects.toThrow(/not valid preview keys/);
  });

  it('reports a declined connection with its connector code and no wallet text or URL', async () => {
    const initial = fakeInitial(fakeConnected());
    initial.connect.mockRejectedValueOnce(connectorError('Rejected'));
    const err = await connectWallet(initial, NETWORK, FAST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Could not connect to the wallet: you declined the request in the wallet');
    expect((err as { upstreamCode?: string }).upstreamCode).toBe('Rejected');
    expect((err as Error).message).not.toMatch(/https?:|project_id|wallet-supplied/);
  });

  // Seen live on 2026-11-23: a locked Lace answered the read step with `Rejected` without ever
  // showing a popup, and the page said "you declined". Only approval steps are a decline.
  it.each([
    ['getConnectionStatus', 'read the wallet connection status'],
    ['getConfiguration', 'read the wallet configuration'],
    ['getShieldedAddresses', 'read the wallet keys'],
  ] as const)('does not call a refused %s a decline: the wallet may be locked', async (method, step) => {
    const c = fakeConnected({
      [method]: async () => {
        throw connectorError('Rejected');
      },
    });
    const err = await connectWallet(fakeInitial(c), NETWORK, FAST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(`Could not ${step}`);
    expect(message).toMatch(/locked|does not allow/);
    expect(message).toMatch(/Unlock Lace/);
    expect(message).not.toMatch(/you declined/);
    expect((err as { upstreamCode?: string }).upstreamCode).toBe('Rejected');
  });

  it('times out a connection the user never answers, naming the step', async () => {
    const initial = fakeInitial(fakeConnected());
    initial.connect.mockImplementationOnce(() => new Promise(() => undefined));
    await expect(connectWallet(initial, NETWORK, FAST)).rejects.toThrow(
      /Could not connect to the wallet: AttemptTimeoutError: connect to the wallet: attempt timed out after 50 ms/,
    );
  });
});

describe('walletProviders', () => {
  const session = async (over: Partial<ConnectedAPI> = {}) =>
    connectWallet(fakeInitial(fakeConnected(over)), NETWORK, FAST);

  it('sends the unbound transaction as hex and returns the sealed transaction from the wallet', async () => {
    const seen: string[] = [];
    const s = await session({
      balanceUnsealedTransaction: async (tx) => {
        seen.push(tx);
        return { tx: fakeBalance(tx) };
      },
    });
    const { walletProvider } = walletProviders(s);
    const tx = await unboundTx();
    const finalized = await walletProvider.balanceTx(tx, FIXED_TTL);
    expect(seen).toEqual([bytesToHex(tx.serialize())]);
    expect(finalized.stage).toBe('Finalized');
    expect(finalized.era).toBe('v9');
    expect(walletProvider.getCoinPublicKey()).toBe(COIN_PK_HEX);
    expect(walletProvider.getEncryptionPublicKey()).toBe(ENC_PK_HEX);
  });

  it('refuses a wallet answer that is not a sealed transaction', async () => {
    const s = await session({ balanceUnsealedTransaction: async (tx) => ({ tx }) }); // returned unbound
    const { walletProvider } = walletProviders(s);
    await expect(walletProvider.balanceTx(await unboundTx(), FIXED_TTL)).rejects.toThrow();
  });

  it('reports too little DUST in words the user can act on', async () => {
    const s = await session({
      balanceUnsealedTransaction: async () => {
        throw connectorError('InsufficientFunds');
      },
    });
    const { walletProvider } = walletProviders(s);
    await expect(walletProvider.balanceTx(await unboundTx(), FIXED_TTL)).rejects.toThrow(/too little DUST/);
  });

  it('submits the hex once and returns the id read from the transaction', async () => {
    const submitted: string[] = [];
    const s = await session({
      submitTransaction: async (tx) => {
        submitted.push(tx);
      },
    });
    const { walletProvider, submit } = walletProviders(s);
    const finalized = await walletProvider.balanceTx(await unboundTx(), FIXED_TTL);
    const id = await submit(finalized as LedgerTransaction<'Finalized', 'v9'>);
    expect(submitted).toEqual([bytesToHex(finalized.serialize())]);
    expect(id).toBe(finalized.deserialize({ v9: Transaction }).identifiers()[0]);
    expect(id.length).toBeGreaterThan(0);
  });

  it('does not retry a failed submit, and names the transaction id', async () => {
    let calls = 0;
    const s = await session({
      submitTransaction: async () => {
        calls++;
        throw connectorError('Disconnected');
      },
    });
    const { walletProvider, submit } = walletProviders(s);
    const finalized = (await walletProvider.balanceTx(await unboundTx(), FIXED_TTL)) as LedgerTransaction<'Finalized', 'v9'>;
    const id = finalized.deserialize({ v9: Transaction }).identifiers()[0]!;
    await expect(submit(finalized)).rejects.toThrow(`(transaction ${id}): the wallet connection was lost`);
    expect(calls).toBe(1);
  });
});

describe('describeWalletError', () => {
  it('maps every connector code and sanitises anything else', () => {
    expect(describeWalletError(connectorError('PermissionRejected'), 'x').message).toMatch(/did not grant/);
    expect(describeWalletError(connectorError('SomethingNew'), 'x').message).toBe('Could not x: wallet error SomethingNew');
    const other = describeWalletError(new Error('boom at https://indexer.example/?project_id=abc\nstack'), 'read');
    expect(other.message).toBe('Could not read: Error: boom at <url>');
  });
});
