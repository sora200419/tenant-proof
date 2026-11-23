// Wallet mode: one role per tab, the user's own Lace wallet pays and signs,
// proofs are built by the proof server on this computer, and transactions go
// to Preview. Demo mode (App.tsx) is the in-page simulator.
import { useEffect, useMemo, useState } from 'react';
import { LOCAL_PROOF_SERVER, connectWallet, listWallets, type WalletSession } from '../../src/dapp-wallet';
import { sanitizeError } from '../../src/retry';
import { TenantProofNetwork, privateStateIdFor, type Role, type TxResult, type TxStage } from './lib/network-client';
import { UINT32_MAX, attestationLeafHex, errorMessage, fromHex, shortHex, type LedgerSnapshot } from './lib/client';

const NETWORK = 'preview';

type CredentialBundle = { tenantPublicKey: string; income: string; salt: string; leaf: string };

function parseUint32(raw: string, field: string): bigint {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) throw new Error(`${field} must be a whole number with no separators`);
  const n = BigInt(t);
  if (n > UINT32_MAX) throw new Error(`${field} must be at most ${UINT32_MAX}`);
  return n;
}

/**
 * The error text plus up to three causes, each cut to its first line with URLs
 * and project ids removed (sanitizeError), so a wrapped SDK error shows its
 * real reason. A circuit assert keeps its plain message.
 */
function withCauses(e: unknown): string {
  const top = errorMessage(e);
  const chain = sanitizeError(e, '').message.replace(/^: /, '');
  const causes = chain.includes(' <- ') ? chain.slice(chain.indexOf(' <- ')) : '';
  return `${top}${causes}`;
}

const STAGES: { key: TxStage['stage']; label: string }[] = [
  { key: 'proving', label: 'Building the proof on this computer (can take a few minutes)' },
  { key: 'wallet', label: 'Waiting for your approval in Lace' },
  { key: 'submitted', label: 'Submitted to Preview' },
  { key: 'confirmed', label: 'Confirmed in a block' },
];

/** Tenant identity names per contract, kept in this browser (names only; keys stay in the encrypted store). */
const identitiesKey = (address: string) => `tenant-proof:identities:${address}`;
function readIdentities(address: string): string[] {
  try {
    const raw = window.localStorage.getItem(identitiesKey(address));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') && parsed.length > 0 ? parsed : ['tenant-1'];
  } catch {
    return ['tenant-1'];
  }
}
function writeIdentities(address: string, names: string[]) {
  try {
    window.localStorage.setItem(identitiesKey(address), JSON.stringify(names));
  } catch {
    // storage unavailable (private window): the names live for this session only
  }
}

function StageView({ stage, result }: { stage: TxStage | null; result: TxResult | null }) {
  if (!stage) return null;
  const reached = STAGES.findIndex((s) => s.key === stage.stage);
  return (
    <div className="stages" aria-live="polite">
      <ol>
        {STAGES.map((s, i) => (
          <li key={s.key} className={i < reached ? 'stage-done' : i === reached ? 'stage-now' : 'stage-todo'}>
            {s.label}
            {s.key === 'submitted' && 'txId' in stage && i <= reached && (
              <>
                {' '}
                · tx <code>{shortHex(stage.txId, 10, 8)}</code>
              </>
            )}
          </li>
        ))}
      </ol>
      {result && (
        <p className="muted">
          Block {result.blockHeight} · tx hash <code>{result.txHash}</code>
        </p>
      )}
    </div>
  );
}

export default function WalletMode() {
  const devServer = import.meta.env.DEV;
  const [walletKey, setWalletKey] = useState('');
  const [session, setSession] = useState<WalletSession | null>(null);
  const [role, setRole] = useState<Role>('tenant');
  const [password, setPassword] = useState('');
  const [client, setClient] = useState<TenantProofNetwork | null>(null);
  const [address, setAddress] = useState(() => new URLSearchParams(window.location.search).get('contract') ?? '');
  const [snapshot, setSnapshot] = useState<LedgerSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stage, setStage] = useState<TxStage | null>(null);
  const [lastTx, setLastTx] = useState<TxResult | null>(null);

  // Issuer
  const [tenantPk, setTenantPk] = useState('');
  const [income, setIncome] = useState('6000');
  const [bundle, setBundle] = useState<CredentialBundle | null>(null);
  // Landlord
  const [label, setLabel] = useState('bukit-jalil-room-a');
  const [rent, setRent] = useState('1500');
  // Tenant
  const [identities, setIdentities] = useState<string[]>(['tenant-1']);
  const [identity, setIdentity] = useState('tenant-1');
  const [myPk, setMyPk] = useState('');
  const [importText, setImportText] = useState('');
  const [applyLabel, setApplyLabel] = useState('');

  const wallets = useMemo(() => listWallets(window.midnight), []);
  const tenantStateId = privateStateIdFor('tenant', identity);

  useEffect(() => {
    if (!walletKey && wallets.compatible[0]) setWalletKey(wallets.compatible[0].key);
  }, [wallets, walletKey]);

  useEffect(() => {
    if (address) {
      const names = readIdentities(address);
      setIdentities(names);
      setIdentity(names[0]!);
    }
  }, [address]);

  // The tenant's public key for the active identity (created on first use).
  useEffect(() => {
    setMyPk('');
    if (!client || role !== 'tenant' || !address || !snapshot) return;
    let cancelled = false;
    client
      .tenantPublicKeyHex(address, tenantStateId)
      .then((pk) => !cancelled && setMyPk(pk))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [client, role, address, snapshot, tenantStateId]);

  const guard = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setError(withCauses(e));
    } finally {
      setBusy(false);
    }
  };

  const txRun = (action: (onStage: (s: TxStage) => void) => Promise<TxResult>, done: (r: TxResult) => string) =>
    guard(async () => {
      setStage(null);
      setLastTx(null);
      const r = await action(setStage);
      setLastTx(r);
      setNotice(done(r));
      if (address) setSnapshot(await settledSnapshot(address, snapshot));
    });

  /**
   * The indexer can lag a few seconds behind a confirmed block, so a read right
   * after a transaction may still show the old state (seen on Preview, 2026-11-22).
   * Re-read until the counts differ from `before`, at most 6 more times, 2 s apart.
   */
  const settledSnapshot = async (addr: string, before: LedgerSnapshot | null) => {
    const sig = (x: LedgerSnapshot) => `${x.attestationCount}/${x.listings.length}/${x.applications.length}`;
    let snap = await client!.snapshot(addr);
    for (let i = 0; i < 6 && before !== null && sig(snap) === sig(before); i++) {
      await new Promise((r) => setTimeout(r, 2000));
      snap = await client!.snapshot(addr);
    }
    return snap;
  };

  const connect = () =>
    guard(async () => {
      const w = wallets.compatible.find((x) => x.key === walletKey);
      if (!w) throw new Error('Choose a wallet first');
      setSession(await connectWallet(w.api, NETWORK));
    });

  const open = () =>
    guard(async () => {
      if (!session) throw new Error('Connect a wallet first');
      if (password.length < 16) throw new Error('Use a password of at least 16 characters with 3 of: upper case, lower case, digits, symbols');
      setClient(TenantProofNetwork.open(role, session, password));
    });

  const load = (addr: string) =>
    guard(async () => {
      const a = addr.trim();
      if (!/^[0-9a-fA-F]{64}$/.test(a)) throw new Error('A contract address is 64 hex characters');
      const snap = await client!.snapshot(a);
      setAddress(a);
      setSnapshot(snap);
      const url = new URL(window.location.href);
      url.searchParams.set('contract', a);
      window.history.replaceState(null, '', url);
    });

  const deploy = () =>
    guard(async () => {
      setStage(null);
      setLastTx(null);
      const r = await client!.deploy(setStage);
      setLastTx(r);
      setAddress(r.address);
      setSnapshot(await settledDeploySnapshot(r.address));
      const url = new URL(window.location.href);
      url.searchParams.set('contract', r.address);
      window.history.replaceState(null, '', url);
      setNotice(`Deployed. Share this contract address with the landlord and tenants: ${r.address}`);
    });

  /** A just-deployed contract may not be readable yet: retry the first read a few times. */
  const settledDeploySnapshot = async (addr: string) => {
    let lastError: unknown;
    for (let i = 0; i < 7; i++) {
      try {
        return await client!.snapshot(addr);
      } catch (e) {
        lastError = e;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw lastError;
  };

  const attest = () =>
    txRun(
      async (onStage) => {
        const inc = parseUint32(income, 'Monthly income');
        fromHex(tenantPk, 32);
        const pk = tenantPk.trim().toLowerCase();
        // The salt exists only here: show the credential before the transaction
        // goes out, so a reload or an error after the commitment lands cannot lose it.
        const r = await client!.attest(address, pk, inc, onStage, (c) =>
          setBundle({ tenantPublicKey: pk, income: inc.toString(), salt: c.saltHex, leaf: c.leafHex }),
        );
        return r.tx;
      },
      () => 'Attestation published. Hand the credential below to the tenant privately; the income is not on the ledger.',
    );

  const createListing = () =>
    txRun(
      (onStage) => {
        if (!label.trim()) throw new Error('Enter a listing id');
        return client!.createListing(address, label, parseUint32(rent, 'Monthly rent'), onStage);
      },
      () => `Listed "${label.trim()}". Applicants must prove income of at least ${BigInt(rent) * 3n}.`,
    );

  const apply = () => {
    let appId = '';
    return txRun(
      async (onStage) => {
        if (!applyLabel) throw new Error('Choose a listing');
        const r = await client!.apply(address, tenantStateId, applyLabel, onStage);
        appId = r.applicationIdHex;
        return r.tx;
      },
      () => `Eligible for "${applyLabel}". Application ${shortHex(appId)} recorded; the income was not written to the ledger.`,
    );
  };

  const importCredential = () =>
    guard(async () => {
      const raw = JSON.parse(importText) as Partial<CredentialBundle>;
      if (typeof raw.tenantPublicKey !== 'string' || typeof raw.income !== 'string' || typeof raw.salt !== 'string' || typeof raw.leaf !== 'string') {
        throw new Error('Credential must have tenantPublicKey, income, salt and leaf as strings');
      }
      if (raw.tenantPublicKey.toLowerCase() !== myPk) throw new Error(`This credential was issued to another public key, not identity "${identity}"`);
      const inc = parseUint32(raw.income, 'Income');
      const salt = fromHex(raw.salt, 32);
      if (attestationLeafHex(inc, myPk, raw.salt) !== raw.leaf.toLowerCase()) {
        throw new Error('Income and salt do not match the commitment in this credential');
      }
      await client!.setTenantCredential(address, tenantStateId, inc, salt);
      setImportText('');
      setNotice(`Credential verified and stored in this browser's encrypted store for identity "${identity}".`);
    });

  const newIdentity = () => {
    const name = `tenant-${identities.length + 1}`;
    const next = [...identities, name];
    setIdentities(next);
    setIdentity(name);
    writeIdentities(address, next);
  };

  const listings = snapshot?.listings ?? [];
  useEffect(() => {
    if (listings.length > 0 && !listings.some((l) => l.label === applyLabel)) setApplyLabel(listings[0]!.label);
  }, [listings, applyLabel]);

  return (
    <div className="wallet-mode">
      <div className="audit-banner proof-notice">
        <strong>Your proof server, your machine.</strong> Proofs are built by the proof server on this computer ({LOCAL_PROOF_SERVER}).
        It receives your private inputs (for a tenant: income and salt). This page never uses a remote proof server; never run one for
        someone else's inputs.
      </div>

      {!devServer ? (
        <div className="card">
          <h2>Wallet mode needs a local run</h2>
          <p className="hint">
            This hosted page has no proving keys. Clone the repository, run <code>npm run compile</code> (or use your existing keys),
            start the proof server on 127.0.0.1:6300, then <code>npm run dev</code> and open http://localhost:5173. See README, "Wallet mode".
          </p>
        </div>
      ) : (
        <>
          <div className="card">
            <h2>1. Connect your wallet</h2>
            {wallets.compatible.length === 0 ? (
              <p className="precheck precheck-warn">
                No Midnight wallet with connector API 4.x found in this browser. Install Lace with Midnight support, set it to Preview, then reload.
                {wallets.incompatible.length > 0 &&
                  ` Found, but not supported: ${wallets.incompatible.map((w) => `${w.name} (API ${w.apiVersion})`).join(', ')}.`}
              </p>
            ) : session ? (
              <div className="kv-list">
                <div className="kv">
                  <span className="k">Network</span>
                  <code className="v">{session.networkId}</code>
                </div>
                <div className="kv">
                  <span className="k">Wallet coin key</span>
                  <code className="v">{shortHex(session.coinPublicKey, 10, 8)}</code>
                </div>
              </div>
            ) : (
              <>
                <label className="field">
                  <span>Wallet</span>
                  <select value={walletKey} onChange={(e) => setWalletKey(e.target.value)}>
                    {wallets.compatible.map((w) => (
                      <option key={w.key} value={w.key}>
                        {w.name} (API {w.apiVersion})
                      </option>
                    ))}
                  </select>
                </label>
                <div className="btn-row">
                  <button className="btn primary" onClick={connect} disabled={busy}>
                    Connect to {NETWORK}
                  </button>
                </div>
              </>
            )}
          </div>

          {session && !client && (
            <div className="card">
              <h2>2. Choose this tab's role</h2>
              <p className="hint">
                This tab holds only this role's keys, in its own encrypted store in this browser. Other roles in the same browser profile use
                separate stores but the same browser; to keep roles truly apart, use a separate browser profile or device per role.
              </p>
              <div className="tabs">
                {(['issuer', 'landlord', 'tenant'] as const).map((r) => (
                  <button key={r} className={`tab ${role === r ? 'active' : ''}`} onClick={() => setRole(r)}>
                    {r === 'issuer' ? 'Issuer (mock)' : r === 'landlord' ? 'Landlord' : 'Tenant'}
                  </button>
                ))}
              </div>
              <label className="field">
                <span>Password for this role's private-state store (not saved; at least 16 characters, 3 of: upper, lower, digits, symbols)</span>
                <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
              <div className="btn-row">
                <button className="btn primary" onClick={open} disabled={busy}>
                  Continue as {role}
                </button>
              </div>
            </div>
          )}

          {client && (
            <div className="card">
              <h2>3. Contract</h2>
              {snapshot ? (
                <div className="kv-list">
                  <div className="kv">
                    <span className="k">Address</span>
                    <code className="v">{shortHex(address, 12, 10)}</code>
                  </div>
                  <div className="kv">
                    <span className="k">Attestations</span>
                    <code className="v">{snapshot.attestationCount}</code>
                  </div>
                  <div className="btn-row">
                    <button className="btn small ghost" onClick={() => load(address)} disabled={busy}>
                      Refresh from the indexer
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <label className="field">
                    <span>Contract address (from the issuer)</span>
                    <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="64 hex characters" />
                  </label>
                  <div className="btn-row">
                    <button className="btn secondary" onClick={() => load(address)} disabled={busy || !address.trim()}>
                      Load
                    </button>
                    {client.role === 'issuer' && (
                      <button className="btn primary" onClick={deploy} disabled={busy}>
                        Deploy a new contract (you become its issuer)
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {client && snapshot && client.role === 'issuer' && (
            <div className="card">
              <h2>Attest a tenant's income</h2>
              <p className="hint">
                <strong>Mock issuer.</strong> In real use an employer, university or bank. It publishes only a salted commitment; hand the
                income and salt to the tenant privately.
              </p>
              <label className="field">
                <span>Tenant public key (the tenant shows it on their tab)</span>
                <input value={tenantPk} onChange={(e) => setTenantPk(e.target.value)} placeholder="64 hex characters" />
              </label>
              <label className="field">
                <span>Attested monthly income</span>
                <input inputMode="numeric" value={income} onChange={(e) => setIncome(e.target.value)} />
              </label>
              <div className="btn-row">
                <button className="btn primary" onClick={attest} disabled={busy}>
                  Publish attestation
                </button>
              </div>
              {bundle && (
                <div className="bundle-box">
                  <div className="bundle-header">
                    <strong>Credential to hand to the tenant (off-chain, privately). Valid only once the attestation above is confirmed; copy it now, it is not stored.</strong>
                    <button className="btn small ghost" onClick={() => navigator.clipboard?.writeText(JSON.stringify(bundle, null, 2)).catch(() => {})}>
                      Copy
                    </button>
                  </div>
                  <pre className="bundle-pre">{JSON.stringify(bundle, null, 2)}</pre>
                </div>
              )}
            </div>
          )}

          {client && snapshot && client.role === 'landlord' && (
            <div className="card">
              <h2>List a room</h2>
              <label className="field">
                <span>Listing id (up to 32 characters)</span>
                <input value={label} onChange={(e) => setLabel(e.target.value)} />
              </label>
              <label className="field">
                <span>Monthly rent</span>
                <input inputMode="numeric" value={rent} onChange={(e) => setRent(e.target.value)} />
              </label>
              <div className="btn-row">
                <button className="btn primary" onClick={createListing} disabled={busy}>
                  Create listing
                </button>
              </div>
              <div className="sublist">
                <h3>Your listings and eligible applications</h3>
                {listings.length === 0 ? (
                  <p className="muted">No listings yet.</p>
                ) : (
                  listings.map((l) => {
                    const apps = snapshot.applications.filter((a) => a.listingIdHex === l.idHex);
                    return (
                      <div key={l.idHex} className="subitem">
                        <div>
                          <strong>{l.label}</strong> · rent {l.rent} · requires income ≥ {(BigInt(l.rent) * 3n).toString()}
                        </div>
                        <div className="muted">
                          Eligible applicants ({apps.length}): {apps.length === 0 ? 'none yet' : apps.map((a) => shortHex(a.applicationIdHex, 10, 6)).join(', ')}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {client && snapshot && client.role === 'tenant' && (
            <div className="card">
              <h2>Prove eligibility and apply</h2>
              <label className="field">
                <span>Active identity (its keys stay in this browser's encrypted store)</span>
                <div className="inline-select">
                  <select value={identity} onChange={(e) => setIdentity(e.target.value)}>
                    {identities.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <button className="btn small ghost" onClick={newIdentity} disabled={busy}>
                    + New tenant identity
                  </button>
                </div>
              </label>
              <div className="kv">
                <span className="k">Your public key (give it to the issuer)</span>
                <code className="v">{myPk || '…'}</code>
              </div>
              <details className="import-box">
                <summary>Import the credential from the issuer</summary>
                <textarea rows={5} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='{"tenantPublicKey": "…", "income": "…", "salt": "…", "leaf": "…"}' />
                <div className="btn-row" style={{ marginTop: 8 }}>
                  <button className="btn small secondary" onClick={importCredential} disabled={busy || !importText.trim() || !myPk}>
                    Verify and import
                  </button>
                </div>
              </details>
              <label className="field">
                <span>Listing</span>
                {listings.length > 0 ? (
                  <select value={applyLabel} onChange={(e) => setApplyLabel(e.target.value)}>
                    {listings.map((l) => (
                      <option key={l.idHex} value={l.label}>
                        {l.label} (rent {l.rent}, needs income ≥ {(BigInt(l.rent) * 3n).toString()})
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="muted">No listings on this contract yet.</p>
                )}
              </label>
              <p className="hint">
                The circuit first runs in this page: if the income is below 3× the rent, it stops here and nothing is proven or sent.
              </p>
              <div className="btn-row">
                <button className="btn primary" onClick={apply} disabled={busy || listings.length === 0}>
                  Prove and apply
                </button>
              </div>
            </div>
          )}

          <StageView stage={stage} result={lastTx} />
          {notice && <div className="precheck precheck-ok">{notice}</div>}
          {error && <div className="precheck precheck-warn" role="alert">Rejected: {error}</div>}
        </>
      )}
    </div>
  );
}
