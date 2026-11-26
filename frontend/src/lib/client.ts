// Browser-side bridge to the compiled TenantProof contract.
//
// The contract's compiler-generated JavaScript runs here, in the page, on the
// official Compact runtime: the same circuits and asserts that a deployed
// contract enforces. This in-page demo (demo mode) does NOT build a
// zero-knowledge proof or submit a transaction; wallet mode does both, through
// network-client.ts, the user's Lace wallet and their local proof server.
import { Contract, ledger, pureCircuits, type Ledger } from '../../../contract/managed/tenant-proof/contract/index.js';
import { createTenantProofPrivateState, witnesses } from '../../../contract/witnesses';
import { Sim, collectPublicBytes } from '../../../src/test/sim';
import {
  applicationIdFor,
  checkTimeFor,
  formatMultiplier,
  issueAttestation,
  leafIndexFromPath,
  listingIdFor,
  parseExpiresAt,
  listingLabelBytes,
  randomBytes32,
  requiredIncome,
} from '../../../src/attest';

/**
 * One listing as the ledger shows it. `label` is for display only; `labelHex`
 * is the exact 32 bytes stored, which closing and the ownership check use.
 * `multiplierTenths` is 30 for 3.0×; a closed listing never reopens.
 */
export type LedgerListing = {
  idHex: string;
  label: string;
  labelHex: string;
  rent: string;
  multiplierTenths: string;
  open: boolean;
};
export type LedgerApplication = { applicationIdHex: string; listingIdHex: string; listingLabel: string };
export type PublicField = { label: string; hex: string };

export type LedgerSnapshot = {
  issuerPkHex: string;
  attestationCount: string;
  attestationRoot: string;
  /** Indices (0 = first attested) of revoked attestations, ascending. */
  revoked: string[];
  listings: LedgerListing[];
  applications: LedgerApplication[];
  /** Every byte string in the decoded public ledger, with the field it sits in. */
  publicFields: PublicField[];
};

export const UINT32_MAX = 0xffffffffn;

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string, expectedBytes?: number): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, '');
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean)) throw new Error('Not a valid hex string');
  if (expectedBytes !== undefined && clean.length !== expectedBytes * 2) {
    throw new Error(`Expected ${expectedBytes} bytes of hex, got ${clean.length / 2}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function shortHex(hex: string, head = 10, tail = 8): string {
  return hex.length <= head + tail + 3 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

export function decodeListingLabel(id: Uint8Array): string {
  let end = id.length;
  while (end > 0 && id[end - 1] === 0) end--;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(id.slice(0, end));
    // Any readable text, not only ASCII; control characters fall back to hex.
    if (text.length > 0 && !/\p{Cc}/u.test(text)) return text;
  } catch {
    // not text: fall through to hex
  }
  return `0x${toHex(id).slice(0, 12)}`;
}

export const newSecretKeyHex = (): string => toHex(randomBytes32());
export const publicKeyHex = (secretKeyHex: string): string => toHex(pureCircuits.publicKey(fromHex(secretKeyHex, 32)));
export const applicationIdHex = (listingIdHex: string, tenantSecretKeyHex: string): string =>
  toHex(applicationIdFor(fromHex(listingIdHex, 32), fromHex(tenantSecretKeyHex, 32)));
/** The id a landlord's key gives this label: how a landlord finds its own listings. */
export const listingIdHexFor = (label: string, landlordSecretKeyHex: string): string =>
  toHex(listingIdFor(label.trim(), fromHex(landlordSecretKeyHex, 32)));

/**
 * Which of these listings this landlord key created: the id is recomputed from
 * the stored label bytes (never from the display label), locally.
 */
export function ownedListingIdHexes(listings: readonly LedgerListing[], landlordSecretKey: Uint8Array): Set<string> {
  const mine = new Set<string>();
  for (const l of listings) {
    if (toHex(pureCircuits.listingId(fromHex(l.labelHex, 32), landlordSecretKey)) === l.idHex) mine.add(l.idHex);
  }
  return mine;
}

export const requiredIncomeFor = (l: LedgerListing): bigint => requiredIncome(BigInt(l.rent), BigInt(l.multiplierTenths));
/** "rent 1500 · 3.0× · needs income ≥ 4500" for one listing. */
export const listingTerms = (l: LedgerListing): string =>
  `rent ${l.rent} · ${formatMultiplier(BigInt(l.multiplierTenths))} · needs income ≥ ${requiredIncomeFor(l)}`;

/** The attestation leaf the contract would compute for these values. */
export const attestationLeafHex = (income: bigint, tenantPkHex: string, expiresAt: bigint, saltHex: string): string =>
  toHex(pureCircuits.attestationLeaf(income, fromHex(tenantPkHex, 32), expiresAt, fromHex(saltHex, 32)));

/**
 * The index the `revoke` circuit takes for this commitment, read from the
 * current attestation tree; undefined if it is not in the tree (never
 * attested, or already revoked).
 */
export function attestationIndexOf(l: Ledger, leafHex: string): bigint | undefined {
  const path = l.attestations.findPathForLeaf(fromHex(leafHex, 32));
  return path === undefined ? undefined : leafIndexFromPath(path);
}

/** Seconds since the epoch of the wall clock, as the contract counts time. */
export const wallClockSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

/** The largest time a JavaScript Date can show (8.64e15 ms). */
const MAX_DATE_SECONDS = 8_640_000_000_000n;

/**
 * "2026-03-31 00:00 UTC" for an expiry in seconds since the epoch. A valid
 * `Uint<64>` expiry can lie beyond what a Date can hold; it is shown as raw
 * seconds rather than throwing.
 */
export const formatUtc = (seconds: bigint): string =>
  seconds > MAX_DATE_SECONDS
    ? `${seconds} s after 1970 (beyond the calendar range)`
    : `${new Date(Number(seconds) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** What the issuer hands a tenant off-chain (JSON). `expiresAt` is whole seconds since the epoch, as a decimal string. */
export type CredentialBundle = { tenantPublicKey: string; income: string; expiresAt: string; salt: string; leaf: string };

/**
 * Parses and verifies a credential JSON for the tenant with this public key:
 * every field present, issued to this key, and income, expiry and salt
 * recompute the commitment. Nothing is stored here.
 */
export function parseCredentialBundle(
  text: string,
  tenantPkHex: string,
  tenantName: string,
): { income: bigint; expiresAt: bigint; saltHex: string; leafHex: string } {
  let raw: Partial<CredentialBundle>;
  try {
    raw = JSON.parse(text) as Partial<CredentialBundle>;
  } catch (e) {
    throw new Error('Credential is not valid JSON', { cause: e });
  }
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof raw.tenantPublicKey !== 'string' ||
    typeof raw.income !== 'string' ||
    typeof raw.expiresAt !== 'string' ||
    typeof raw.salt !== 'string' ||
    typeof raw.leaf !== 'string'
  ) {
    throw new Error('Credential must have tenantPublicKey, income, expiresAt, salt and leaf as strings');
  }
  fromHex(raw.salt, 32);
  fromHex(raw.leaf, 32);
  if (raw.tenantPublicKey.trim().toLowerCase() !== tenantPkHex.toLowerCase()) {
    throw new Error(`This credential was issued to another public key, not ${tenantName}`);
  }
  const t = raw.income.trim();
  if (!/^\d+$/.test(t)) throw new Error('Income must be a whole number with no separators');
  const income = BigInt(t);
  if (income > UINT32_MAX) throw new Error(`Income must be at most ${UINT32_MAX}`);
  const expiresAt = parseExpiresAt(raw.expiresAt);
  const saltHex = raw.salt.trim().toLowerCase().replace(/^0x/, '');
  const leafHex = attestationLeafHex(income, tenantPkHex.toLowerCase(), expiresAt, saltHex);
  if (leafHex !== raw.leaf.trim().toLowerCase().replace(/^0x/, '')) {
    throw new Error('Income, expiry and salt do not match the commitment in this credential');
  }
  return { income, expiresAt, saltHex, leafHex };
}

/**
 * Looks up an attestation index through a read that may be stale (an indexer
 * can lag behind a confirmed block). "Not found" is reported only after
 * `attempts` reads, `delayMs` apart; a found index is returned at once.
 */
export async function findAttestationIndex(
  read: () => Promise<bigint | undefined>,
  { attempts = 4, delayMs = 2000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<bigint | undefined> {
  for (let i = 0; i < attempts; i++) {
    const index = await read();
    if (index !== undefined) return index;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return undefined;
}

/** `income as Field as Bytes<32>`: the exact 32 bytes the circuit hashes (little-endian). */
export function incomeAsCircuitBytesHex(income: bigint): string {
  const out = new Uint8Array(32);
  let v = income;
  for (let i = 0; i < 32 && v > 0n; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return toHex(out);
}

/** Strips the runtime's prefix so the UI shows the contract's own assert message. */
export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^failed assert:\s*/i, '');
}

export type Secret = { name: string; hex: string };
export type Leak = { name: string; field: string };

/**
 * Looks for each secret inside every byte string of the public ledger.
 * Containment, not equality, so a secret embedded in a larger field counts.
 * This is a check of the ledger state, not a proof about the protocol.
 */
export function findLeaks(snapshot: LedgerSnapshot, secrets: Secret[]): Leak[] {
  const leaks: Leak[] = [];
  for (const s of secrets) {
    const needle = s.hex.toLowerCase();
    if (needle.length === 0) continue;
    for (const f of snapshot.publicFields) {
      if (f.hex.includes(needle)) leaks.push({ name: s.name, field: f.label });
    }
  }
  return leaks;
}

type TenantProofSim = Awaited<ReturnType<typeof deploySim>>;

const deploySim = (issuerSecretKey: Uint8Array) =>
  Sim.deploy({
    contract: new Contract(witnesses),
    ledger,
    privateState: createTenantProofPrivateState(issuerSecretKey),
  });

function readSnapshot(sim: TenantProofSim): LedgerSnapshot {
  return snapshotFromLedger(sim.ledger());
}

/** What the UI shows of a decoded public ledger, from the simulator or from the indexer. */
export function snapshotFromLedger(l: Ledger): LedgerSnapshot {
  const listings: LedgerListing[] = [];
  for (const [id, listing] of l.listings) {
    listings.push({
      idHex: toHex(id),
      label: decodeListingLabel(listing.label),
      labelHex: toHex(listing.label),
      rent: listing.rent.toString(),
      multiplierTenths: listing.multiplierTenths.toString(),
      open: listing.open,
    });
  }
  const labelOf = (idHex: string) => listings.find((x) => x.idHex === idHex)?.label ?? `0x${idHex.slice(0, 12)}`;
  const applications: LedgerApplication[] = [];
  for (const [appId, listingId] of l.applications) {
    applications.push({
      applicationIdHex: toHex(appId),
      listingIdHex: toHex(listingId),
      listingLabel: labelOf(toHex(listingId)),
    });
  }
  return {
    issuerPkHex: toHex(l.issuerPk),
    attestationCount: l.attestationCount.toString(),
    attestationRoot: l.attestations.root().field.toString(16),
    revoked: [...l.revoked].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((i) => i.toString()),
    listings,
    applications,
    publicFields: collectPublicBytes(l).map((p) => ({ label: p.label, hex: toHex(p.bytes) })),
  };
}

/**
 * One in-page deployment of the contract. Each method is one transaction.
 * Block time is a demo clock: the wall clock plus whatever `advanceClock` has
 * added, so expiry can be shown without waiting.
 */
export class TenantProofDemo {
  private clockOffset = 0n;

  private constructor(
    private sim: TenantProofSim,
    private readonly clock: () => bigint,
  ) {}

  /** Deploys a fresh contract; the deployer's key becomes the issuer. `clock` gives seconds since the epoch. */
  static async deploy(issuerSecretKeyHex: string, clock: () => bigint = wallClockSeconds): Promise<TenantProofDemo> {
    return new TenantProofDemo(await deploySim(fromHex(issuerSecretKeyHex, 32)), clock);
  }

  /** The demo clock (seconds since the epoch): the block time of the next transaction. */
  nowSeconds(): bigint {
    return this.clock() + this.clockOffset;
  }

  /** Moves the demo clock forward; nothing on the ledger changes. */
  advanceClock(seconds: bigint): void {
    if (seconds <= 0n) throw new Error('The demo clock only moves forward');
    this.clockOffset += seconds;
  }

  private call: TenantProofSim['call'] = (circuit, ...args) => {
    this.sim.time = Number(this.nowSeconds());
    return this.sim.call(circuit, ...args);
  };

  snapshot(): LedgerSnapshot {
    return readSnapshot(this.sim);
  }

  /** Index of this commitment in the attestation tree, or undefined if it is not there (never attested, or revoked). */
  attestationIndex(leafHex: string): bigint | undefined {
    return attestationIndexOf(this.sim.ledger(), leafHex);
  }

  /** Issuer publishes a salted commitment to (income, tenant public key, expiry). */
  async attest(p: { callerSecretKeyHex: string; tenantPublicKeyHex: string; income: bigint; expiresAt: bigint }) {
    const att = issueAttestation(p.income, fromHex(p.tenantPublicKeyHex, 32), p.expiresAt);
    this.sim.privateState = createTenantProofPrivateState(fromHex(p.callerSecretKeyHex, 32));
    await this.call('attest', att.leaf);
    return { leafHex: toHex(att.leaf), saltHex: toHex(att.salt), expiresAt: att.expiresAt, snapshot: this.snapshot() };
  }

  /** Issuer revokes the attestation at `index`. Applications already made stay. */
  async revoke(p: { callerSecretKeyHex: string; index: bigint }) {
    this.sim.privateState = createTenantProofPrivateState(fromHex(p.callerSecretKeyHex, 32));
    await this.call('revoke', p.index);
    return { snapshot: this.snapshot() };
  }

  /** Landlord lists a room. The contract derives the id from the landlord's key and the label. */
  async createListing(p: { landlordSecretKeyHex: string; label: string; rent: bigint; multiplierTenths: bigint }) {
    const sk = fromHex(p.landlordSecretKeyHex, 32);
    this.sim.privateState = createTenantProofPrivateState(sk);
    await this.call('createListing', listingLabelBytes(p.label.trim()), p.rent, p.multiplierTenths);
    return { listingIdHex: toHex(listingIdFor(p.label.trim(), sk)), snapshot: this.snapshot() };
  }

  /**
   * Landlord closes a listing for good, by the label bytes stored on the ledger.
   * With any other key the contract finds no such listing.
   */
  async closeListing(p: { callerSecretKeyHex: string; labelHex: string }) {
    this.sim.privateState = createTenantProofPrivateState(fromHex(p.callerSecretKeyHex, 32));
    await this.call('closeListing', fromHex(p.labelHex, 32));
    return { snapshot: this.snapshot() };
  }

  /**
   * Tenant proves income >= the listing's multiplier x rent with an unexpired
   * attestation. `income`, `salt` and `expiresAt` are witness inputs only; the
   * public check time is `checkTimeFor` the demo clock.
   */
  async apply(p: { tenantSecretKeyHex: string; income: bigint; saltHex: string; expiresAt: bigint; listingIdHex: string }) {
    const id = fromHex(p.listingIdHex, 32);
    const sk = fromHex(p.tenantSecretKeyHex, 32);
    this.sim.privateState = createTenantProofPrivateState(sk, p.income, fromHex(p.saltHex, 32), p.expiresAt);
    const checkTime = checkTimeFor(this.nowSeconds());
    await this.call('apply', id, checkTime);
    return { applicationIdHex: toHex(applicationIdFor(id, sk)), checkTime, snapshot: this.snapshot() };
  }
}
