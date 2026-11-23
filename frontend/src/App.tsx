import { useEffect, useMemo, useRef, useState } from 'react';
import WalletMode from './WalletMode';
import {
  TenantProofDemo,
  UINT32_MAX,
  applicationIdHex,
  attestationLeafHex,
  errorMessage,
  findLeaks,
  fromHex,
  incomeAsCircuitBytesHex,
  newSecretKeyHex,
  publicKeyHex,
  shortHex,
  type LedgerSnapshot,
  type Secret,
} from './lib/client';

type RoleTab = 'issuer' | 'landlord' | 'tenant';

/** What the issuer hands a tenant off-chain. Never written to the ledger. */
type Credential = { income: string; saltHex: string; leafHex: string };

type Tenant = {
  id: string;
  name: string;
  secretKeyHex: string;
  publicKeyHex: string;
  credential?: Credential;
};

type LogEntry = { id: number; ok: boolean; actor: string; message: string; time: string };

type CredentialBundle = { tenantPublicKey: string; income: string; salt: string; leaf: string };

const ROOM_A = 'bukit-jalil-room-a';
const STUDIO = 'cyberjaya-studio';

function parseUint32(raw: string, field: string): bigint {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) throw new Error(`${field} must be a whole number with no separators`);
  const n = BigInt(t);
  if (n > UINT32_MAX) throw new Error(`${field} must be at most ${UINT32_MAX}`);
  return n;
}

function makeTenant(id: string, name: string): Tenant {
  const sk = newSecretKeyHex();
  return { id, name, secretKeyHex: sk, publicKeyHex: publicKeyHex(sk) };
}

const initialTenants = (): Tenant[] => [makeTenant('alice', 'Alice'), makeTenant('bob', 'Bob')];

let logSeq = 0;

type Mode = 'demo' | 'wallet';

/** Demo mode (in-page simulator, every role in this tab) or wallet mode (one role, Lace, local proof server, Preview). */
export default function App() {
  const [mode, setMode] = useState<Mode>(() =>
    new URLSearchParams(window.location.search).get('mode') === 'wallet' ? 'wallet' : 'demo',
  );
  const choose = (m: Mode) => {
    setMode(m);
    const url = new URL(window.location.href);
    url.searchParams.set('mode', m);
    window.history.replaceState(null, '', url);
  };
  return (
    <>
      <nav className="mode-switch page" aria-label="Mode">
        <button className={`tab ${mode === 'demo' ? 'active' : ''}`} onClick={() => choose('demo')}>
          Demo mode: every role's keys in this tab, in-page simulator, no proof, no transaction
        </button>
        <button className={`tab ${mode === 'wallet' ? 'active' : ''}`} onClick={() => choose('wallet')}>
          Wallet mode: one role, your Lace wallet, your local proof server, Preview testnet
        </button>
      </nav>
      {mode === 'demo' ? (
        <DemoMode />
      ) : (
        <div className="page">
          <WalletMode />
        </div>
      )}
    </>
  );
}

function DemoMode() {
  const [issuerSk, setIssuerSk] = useState(newSecretKeyHex);
  const [landlordSk, setLandlordSk] = useState(newSecretKeyHex);
  const [tenants, setTenants] = useState<Tenant[]>(initialTenants);
  const [tab, setTab] = useState<RoleTab>('issuer');
  const [tenantId, setTenantId] = useState('alice');

  const demoRef = useRef<TenantProofDemo | null>(null);
  const [snapshot, setSnapshot] = useState<LedgerSnapshot | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // Issuer form
  const [attestTargetId, setAttestTargetId] = useState('alice');
  const [attestIncome, setAttestIncome] = useState('6000');
  const [lastBundle, setLastBundle] = useState<CredentialBundle | null>(null);
  // Landlord form
  const [listingLabel, setListingLabel] = useState(ROOM_A);
  const [listingRent, setListingRent] = useState('1500');
  // Tenant form
  const [applyLabel, setApplyLabel] = useState(ROOM_A);
  const [claimedIncome, setClaimedIncome] = useState('');
  const [importText, setImportText] = useState('');

  const tenant = tenants.find((t) => t.id === tenantId) ?? tenants[0]!;
  const attestTarget = tenants.find((t) => t.id === attestTargetId) ?? tenants[0]!;
  const issuerPk = useMemo(() => publicKeyHex(issuerSk), [issuerSk]);
  const landlordPk = useMemo(() => publicKeyHex(landlordSk), [landlordSk]);

  const log = (ok: boolean, actor: string, message: string) =>
    setLogs((prev) => [
      { id: ++logSeq, ok, actor, message, time: new Date().toLocaleTimeString() },
      ...prev.slice(0, 19),
    ]);

  // Deploy the contract once, in the page.
  useEffect(() => {
    let cancelled = false;
    TenantProofDemo.deploy(issuerSk)
      .then((demo) => {
        if (cancelled) return;
        demoRef.current = demo;
        setSnapshot(demo.snapshot());
      })
      .catch((e) => !cancelled && setFatal(errorMessage(e)));
    return () => {
      cancelled = true;
    };
    // The issuer key at first mount is the deployer; reset() redeploys explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The income field defaults to what the issuer attested for this tenant.
  useEffect(() => {
    setClaimedIncome(tenant.credential?.income ?? '');
  }, [tenant.id, tenant.credential?.income]);

  // Keep the selected listing valid as listings appear.
  useEffect(() => {
    if (snapshot && snapshot.listings.length > 0 && !snapshot.listings.some((l) => l.label === applyLabel)) {
      setApplyLabel(snapshot.listings[0]!.label);
    }
  }, [snapshot, applyLabel]);

  /** Runs one action against the contract, with busy state and logging. */
  const run = async (actor: string, action: (demo: TenantProofDemo) => Promise<string>) => {
    const demo = demoRef.current;
    if (!demo) return;
    setBusy(true);
    try {
      const message = await action(demo);
      log(true, actor, message);
    } catch (e) {
      log(false, actor, `Rejected: ${errorMessage(e)}`);
    } finally {
      setSnapshot(demo.snapshot());
      setBusy(false);
    }
  };

  const setCredential = (id: string, credential: Credential) =>
    setTenants((prev) => prev.map((t) => (t.id === id ? { ...t, credential } : t)));

  const reset = async () => {
    setBusy(true);
    try {
      const sk = newSecretKeyHex();
      const demo = await TenantProofDemo.deploy(sk);
      demoRef.current = demo;
      setIssuerSk(sk);
      setLandlordSk(newSecretKeyHex());
      setTenants(initialTenants());
      setTenantId('alice');
      setAttestTargetId('alice');
      setLastBundle(null);
      setImportText('');
      setLogs([]);
      setSnapshot(demo.snapshot());
    } catch (e) {
      setFatal(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const seedDemo = () =>
    run('Demo data', async (demo) => {
      const [alice, bob] = tenants;
      if (!alice || !bob) throw new Error('Reset first');
      const a = await demo.attest({ callerSecretKeyHex: issuerSk, tenantPublicKeyHex: alice.publicKeyHex, income: 6000n });
      const b = await demo.attest({ callerSecretKeyHex: issuerSk, tenantPublicKeyHex: bob.publicKeyHex, income: 3500n });
      setCredential(alice.id, { income: '6000', saltHex: a.saltHex, leafHex: a.leafHex });
      setCredential(bob.id, { income: '3500', saltHex: b.saltHex, leafHex: b.leafHex });
      await demo.createListing({ landlordSecretKeyHex: landlordSk, label: ROOM_A, rent: 1500n });
      await demo.createListing({ landlordSecretKeyHex: landlordSk, label: STUDIO, rent: 1000n });
      setApplyLabel(ROOM_A);
      setTab('tenant');
      return 'Issuer attested Alice (6000) and Bob (3500); landlord listed two rooms (rent 1500 and 1000).';
    });

  const attest = (impostor: boolean) =>
    run(impostor ? 'Impostor issuer' : 'Issuer', async (demo) => {
      const income = parseUint32(attestIncome, 'Monthly income');
      const res = await demo.attest({
        callerSecretKeyHex: impostor ? newSecretKeyHex() : issuerSk,
        tenantPublicKeyHex: attestTarget.publicKeyHex,
        income,
      });
      const credential = { income: income.toString(), saltHex: res.saltHex, leafHex: res.leafHex };
      setCredential(attestTarget.id, credential);
      setLastBundle({
        tenantPublicKey: attestTarget.publicKeyHex,
        income: credential.income,
        salt: credential.saltHex,
        leaf: credential.leafHex,
      });
      return `Published commitment ${shortHex(res.leafHex)} for ${attestTarget.name}. The income itself is not on the ledger.`;
    });

  const createListing = () =>
    run('Landlord', async (demo) => {
      if (!listingLabel.trim()) throw new Error('Enter a listing id');
      const rent = parseUint32(listingRent, 'Monthly rent');
      await demo.createListing({ landlordSecretKeyHex: landlordSk, label: listingLabel, rent });
      setApplyLabel(listingLabel.trim());
      return `Listed "${listingLabel.trim()}" at rent ${rent}. Applicants must prove income of at least ${rent * 3n}.`;
    });

  const apply = () =>
    run(tenant.name, async (demo) => {
      if (!applyLabel.trim()) throw new Error('Choose a listing first');
      // With no credential the circuit still runs (random salt), so the
      // rejection shown is the contract's own, not a UI shortcut.
      const income = parseUint32(claimedIncome || (tenant.credential ? '' : '9000'), 'Income');
      const res = await demo.apply({
        tenantSecretKeyHex: tenant.secretKeyHex,
        income,
        saltHex: tenant.credential?.saltHex ?? newSecretKeyHex(),
        listingLabel: applyLabel,
      });
      return `Eligible for "${applyLabel}". Application ${shortHex(res.applicationIdHex)} recorded; the income was not written to the ledger, and the listing shows it is at least 3× the rent.`;
    });

  const addStranger = () => {
    const n = tenants.filter((t) => t.id.startsWith('stranger')).length + 1;
    const t = makeTenant(`stranger-${n}`, `Stranger ${n} (no attestation)`);
    setTenants((prev) => [...prev, t]);
    setTenantId(t.id);
    setTab('tenant');
  };

  const importBundle = () => {
    try {
      const raw = JSON.parse(importText) as Partial<CredentialBundle>;
      if (typeof raw.tenantPublicKey !== 'string' || typeof raw.income !== 'string' || typeof raw.salt !== 'string' || typeof raw.leaf !== 'string') {
        throw new Error('Credential must have tenantPublicKey, income, salt and leaf as strings');
      }
      fromHex(raw.salt, 32);
      fromHex(raw.leaf, 32);
      if (raw.tenantPublicKey.toLowerCase() !== tenant.publicKeyHex) {
        throw new Error(`This credential was issued to another public key, not ${tenant.name}`);
      }
      const income = parseUint32(raw.income, 'Income');
      const leaf = attestationLeafHex(income, tenant.publicKeyHex, raw.salt);
      if (leaf !== raw.leaf.toLowerCase()) throw new Error('Income and salt do not match the commitment in this credential');
      setCredential(tenant.id, { income: income.toString(), saltHex: raw.salt.toLowerCase(), leafHex: leaf });
      setImportText('');
      log(true, tenant.name, `Imported and verified the issuer credential (commitment ${shortHex(leaf)}).`);
    } catch (e) {
      log(false, tenant.name, `Import failed: ${errorMessage(e)}`);
    }
  };

  // --- Derived views -------------------------------------------------------

  /** Every secret the demo holds, checked against every public ledger field. */
  const audit = useMemo(() => {
    if (!snapshot) return null;
    const secrets: Secret[] = [
      { name: 'issuer secret key', hex: issuerSk },
      { name: 'landlord secret key', hex: landlordSk },
    ];
    for (const t of tenants) {
      secrets.push({ name: `${t.name}: secret key`, hex: t.secretKeyHex });
      secrets.push({ name: `${t.name}: public key`, hex: t.publicKeyHex });
      if (t.credential) {
        secrets.push({ name: `${t.name}: salt`, hex: t.credential.saltHex });
        secrets.push({ name: `${t.name}: income`, hex: incomeAsCircuitBytesHex(BigInt(t.credential.income)) });
      }
    }
    return { checked: secrets.length, fields: snapshot.publicFields.length, leaks: findLeaks(snapshot, secrets) };
  }, [snapshot, issuerSk, landlordSk, tenants]);

  /** Applications of the selected tenant. Only the tenant's secret key can find them. */
  const myApplications = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.listings
      .map((l) => ({ label: l.label, id: applicationIdHex(l.label, tenant.secretKeyHex) }))
      .filter((a) => snapshot.applications.some((x) => x.applicationIdHex === a.id));
  }, [snapshot, tenant.secretKeyHex]);

  const selectedListing = snapshot?.listings.find((l) => l.label === applyLabel);
  const precheck = (() => {
    if (!tenant.credential) return { cls: 'precheck-warn', text: 'No issuer credential on this device. The contract will reject the application.' };
    if (!selectedListing) return { cls: 'precheck-info', text: 'Choose a listing to see the requirement.' };
    const need = BigInt(selectedListing.rent) * 3n;
    const have = BigInt(tenant.credential.income);
    return have >= need
      ? { cls: 'precheck-ok', text: `Local check: attested income ${have} meets the requirement of ${need}.` }
      : { cls: 'precheck-warn', text: `Local check: attested income ${have} is below the requirement of ${need}. The contract will reject it.` };
  })();

  const localView =
    tab === 'issuer'
      ? { role: 'Issuer', sk: issuerSk, pk: issuerPk, extra: [] as { k: string; v: string }[] }
      : tab === 'landlord'
        ? { role: 'Landlord', sk: landlordSk, pk: landlordPk, extra: [] }
        : {
            role: tenant.name,
            sk: tenant.secretKeyHex,
            pk: tenant.publicKeyHex,
            extra: [
              { k: 'Attested income (witness)', v: tenant.credential?.income ?? 'none' },
              { k: 'Salt (witness)', v: tenant.credential ? shortHex(tenant.credential.saltHex, 14, 10) : 'none' },
            ],
          };

  if (fatal) {
    return (
      <div className="page">
        <div className="audit-banner audit-fail">
          <strong>The contract could not start in this browser.</strong> {fatal}
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>TenantProof</h1>
          <p className="subtitle">
            Show a landlord a source-verified income signal from a trusted issuer, “my income is at least 3× the rent”, without sending payslips. Built on Midnight’s Compact.
          </p>
        </div>
        <div className="topbar-actions">
          <span className="badge" title="The compiled contract runs in this page. No proof is generated and nothing is sent to a network. Every role's keys are held in this one tab.">
            Demo mode · local simulator · no on-chain proof
          </span>
          <button className="btn secondary" onClick={seedDemo} disabled={busy || !snapshot}>
            Load demo data
          </button>
          <button className="btn ghost" onClick={reset} disabled={busy}>
            Reset
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="panel">
          <div className="tabs">
            {(['issuer', 'landlord', 'tenant'] as const).map((r, i) => (
              <button key={r} className={`tab ${tab === r ? 'active' : ''}`} onClick={() => setTab(r)}>
                {i + 1}. {r === 'issuer' ? 'Issuer (mock)' : r === 'landlord' ? 'Landlord' : 'Tenant'}
              </button>
            ))}
          </div>

          {tab === 'issuer' && (
            <div className="card">
              <h2>Attest a tenant’s income</h2>
              <p className="hint">
                <strong>Mock issuer (simulated).</strong> In real use this is an employer, university or bank. Here the demo plays that role, and it is trusted to state the income truthfully.
              </p>
              <p className="hint">
                The issuer publishes only a salted commitment to <code>(income, tenant public key)</code>. The income and the salt go to the tenant privately.
              </p>
              <label className="field">
                <span>Tenant</span>
                <select value={attestTargetId} onChange={(e) => setAttestTargetId(e.target.value)}>
                  {tenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({shortHex(t.publicKeyHex, 8, 6)})
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Attested monthly income (the issuer is trusted; stays off-chain)</span>
                <input inputMode="numeric" value={attestIncome} onChange={(e) => setAttestIncome(e.target.value)} />
              </label>
              <div className="btn-row">
                <button className="btn primary" onClick={() => attest(false)} disabled={busy}>
                  Publish attestation
                </button>
                <button className="btn danger" onClick={() => attest(true)} disabled={busy}>
                  Try as someone who is not the issuer
                </button>
              </div>

              {lastBundle && (
                <div className="bundle-box">
                  <div className="bundle-header">
                    <strong>Credential to hand to the tenant (off-chain)</strong>
                    <button className="btn small ghost" onClick={() => navigator.clipboard?.writeText(JSON.stringify(lastBundle, null, 2)).catch(() => {})}>
                      Copy
                    </button>
                  </div>
                  <pre className="bundle-pre">{JSON.stringify(lastBundle, null, 2)}</pre>
                </div>
              )}
            </div>
          )}

          {tab === 'landlord' && (
            <div className="card">
              <h2>List a room</h2>
              <p className="hint">
                The landlord sets a public rent. Afterwards the landlord sees only application ids, with no name or key attached, that passed <code>income ≥ 3 × rent</code>.
              </p>
              <label className="field">
                <span>Listing id (up to 32 characters)</span>
                <input value={listingLabel} onChange={(e) => setListingLabel(e.target.value)} />
              </label>
              <label className="field">
                <span>Monthly rent</span>
                <input inputMode="numeric" value={listingRent} onChange={(e) => setListingRent(e.target.value)} />
              </label>
              <div className="btn-row">
                <button className="btn primary" onClick={createListing} disabled={busy}>
                  Create listing
                </button>
              </div>

              <div className="sublist">
                <h3>What the landlord sees</h3>
                {!snapshot || snapshot.listings.length === 0 ? (
                  <p className="muted">No listings yet.</p>
                ) : (
                  snapshot.listings.map((l) => {
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

          {tab === 'tenant' && (
            <div className="card">
              <h2>Prove eligibility and apply</h2>
              <p className="hint">
                The tenant’s key, income and salt are private inputs. The circuit checks that the issuer attested this income and that it is at least 3× the rent.
              </p>
              <label className="field">
                <span>Acting as</span>
                <div className="inline-select">
                  <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
                    {tenants.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <button className="btn small ghost" onClick={addStranger} disabled={busy}>
                    + New tenant
                  </button>
                </div>
              </label>
              <label className="field">
                <span>Listing</span>
                {snapshot && snapshot.listings.length > 0 ? (
                  <select value={applyLabel} onChange={(e) => setApplyLabel(e.target.value)}>
                    {snapshot.listings.map((l) => (
                      <option key={l.idHex} value={l.label}>
                        {l.label} (rent {l.rent}, needs income ≥ {(BigInt(l.rent) * 3n).toString()})
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={applyLabel} onChange={(e) => setApplyLabel(e.target.value)} placeholder="Create a listing on the Landlord tab first" />
                )}
              </label>
              <label className="field">
                <span>Income given to the circuit (raise it to try lying)</span>
                <input inputMode="numeric" value={claimedIncome} onChange={(e) => setClaimedIncome(e.target.value)} placeholder="no credential yet" />
              </label>

              <div className={`precheck ${precheck.cls}`}>{precheck.text}</div>

              <div className="btn-row">
                <button className="btn primary" onClick={apply} disabled={busy}>
                  Prove and apply
                </button>
                {tenant.credential && claimedIncome !== tenant.credential.income && (
                  <button className="btn secondary" onClick={() => setClaimedIncome(tenant.credential!.income)} disabled={busy}>
                    Back to attested income ({tenant.credential.income})
                  </button>
                )}
              </div>

              <details className="import-box">
                <summary>Import a credential from the issuer</summary>
                <p className="muted">Paste the JSON the issuer gave you. It is checked against your key before it is stored on this device.</p>
                <textarea rows={5} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='{"tenantPublicKey": "…", "income": "…", "salt": "…", "leaf": "…"}' />
                <div className="btn-row" style={{ marginTop: 8 }}>
                  <button className="btn small secondary" onClick={importBundle} disabled={!importText.trim()}>
                    Verify and import
                  </button>
                </div>
              </details>
            </div>
          )}

          <div className="card">
            <h3>Activity</h3>
            {logs.length === 0 ? (
              <p className="muted">Nothing yet. Press “Load demo data”, or go through tabs 1 → 2 → 3.</p>
            ) : (
              <ul className="log-list">
                {logs.map((e) => (
                  <li key={e.id} className={e.ok ? 'log-ok' : 'log-err'}>
                    <span className="log-meta">
                      [{e.time}] {e.actor} {e.ok ? '✓' : '✗'}
                    </span>
                    <span>{e.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <aside className="panel">
          {audit && (
            <div className={`audit-banner ${audit.leaks.length === 0 ? 'audit-ok' : 'audit-fail'}`}>
              {audit.leaks.length === 0 ? (
                <>
                  <strong>Privacy check passed.</strong> Searched every byte string in the decoded public ledger ({audit.fields}) for {audit.checked} private values (keys, salts, incomes): none found.
                </>
              ) : (
                <>
                  <strong>Privacy check failed.</strong> {audit.leaks.map((l) => `${l.name} appears in ${l.field}`).join('; ')}
                </>
              )}
            </div>
          )}

          <div className="card public-card">
            <div className="card-header">
              <h2>Public ledger</h2>
              <span className="pill public">visible to everyone</span>
            </div>
            {!snapshot ? (
              <p className="muted">Starting the contract…</p>
            ) : (
              <div className="kv-list">
                <div className="kv">
                  <span className="k">issuerPk</span>
                  <code className="v">{shortHex(snapshot.issuerPkHex, 14, 10)}</code>
                </div>
                <div className="kv">
                  <span className="k">attestations</span>
                  <code className="v">{snapshot.attestationCount} commitments, root {shortHex(snapshot.attestationRoot, 8, 6)}</code>
                </div>
                <div className="kv-block">
                  <span className="k">listings (id → rent)</span>
                  {snapshot.listings.length === 0 ? (
                    <p className="muted">empty</p>
                  ) : (
                    <ul>
                      {snapshot.listings.map((l) => (
                        <li key={l.idHex}>
                          <code>{l.label}</code> → <strong>{l.rent}</strong>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="kv-block">
                  <span className="k">applications (id → listing)</span>
                  {snapshot.applications.length === 0 ? (
                    <p className="muted">empty</p>
                  ) : (
                    <ul>
                      {snapshot.applications.map((a) => (
                        <li key={a.applicationIdHex}>
                          <code>{shortHex(a.applicationIdHex, 12, 8)}</code> → <code>{a.listingLabel}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <details className="raw-dump">
                  <summary>Every byte field on the ledger</summary>
                  <pre>{snapshot.publicFields.map((f) => `${f.label}\n  ${f.hex}`).join('\n')}</pre>
                </details>
              </div>
            )}
          </div>

          {tab === 'tenant' && myApplications.length > 0 && (
            <div className="card unlink-card">
              <div className="card-header">
                <h2>{tenant.name}’s applications</h2>
                <span className="pill unlink">separate ids</span>
              </div>
              <div className="unlink-group">
                <ul>
                  {myApplications.map((a) => (
                    <li key={a.id}>
                      <code>{a.label}</code> → <code>{shortHex(a.id, 12, 8)}</code>
                    </li>
                  ))}
                </ul>
                <p className="unlink-note muted">
                  Each id is a hash of the listing and {tenant.name}’s secret key, so the contract’s public state does not show
                  {myApplications.length > 1 ? ' that these ids belong to the same person' : ' whose id this is'}. The issuer knows incomes and may still narrow it down when few
                  tenants qualify.
                </p>
              </div>
            </div>
          )}

          <div className="card local-card">
            <div className="card-header">
              <h2>Private state</h2>
              <span className="pill private">never on the ledger</span>
            </div>
            <p className="hint">
              Viewing as <strong>{localView.role}</strong>. These values reach the circuit only as witness inputs and are never written to the ledger. In demo mode they are not sent to any network (the issuer’s Copy button puts a credential on the clipboard to hand to the tenant); in wallet mode they also go to the user’s own local proof server, which builds the proof.
            </p>
            <div className="kv-list">
              <div className="kv">
                <span className="k">Secret key</span>
                <code className="v">{shortHex(localView.sk, 14, 10)}</code>
              </div>
              <div className="kv">
                <span className="k">Public key</span>
                <code className="v">{shortHex(localView.pk, 14, 10)}</code>
              </div>
              {localView.extra.map((x) => (
                <div className="kv" key={x.k}>
                  <span className="k">{x.k}</span>
                  <code className="v">{x.v}</code>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
