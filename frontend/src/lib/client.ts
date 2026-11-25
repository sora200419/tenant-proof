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
  formatMultiplier,
  issueAttestation,
  listingIdFor,
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
export const attestationLeafHex = (income: bigint, tenantPkHex: string, saltHex: string): string =>
  toHex(pureCircuits.attestationLeaf(income, fromHex(tenantPkHex, 32), fromHex(saltHex, 32)));

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
    listings,
    applications,
    publicFields: collectPublicBytes(l).map((p) => ({ label: p.label, hex: toHex(p.bytes) })),
  };
}

/** One in-page deployment of the contract. Each method is one transaction. */
export class TenantProofDemo {
  private constructor(private sim: TenantProofSim) {}

  /** Deploys a fresh contract; the deployer's key becomes the issuer. */
  static async deploy(issuerSecretKeyHex: string): Promise<TenantProofDemo> {
    return new TenantProofDemo(await deploySim(fromHex(issuerSecretKeyHex, 32)));
  }

  snapshot(): LedgerSnapshot {
    return readSnapshot(this.sim);
  }

  /** Issuer publishes a salted commitment to (income, tenant public key). */
  async attest(p: { callerSecretKeyHex: string; tenantPublicKeyHex: string; income: bigint }) {
    const att = issueAttestation(p.income, fromHex(p.tenantPublicKeyHex, 32));
    this.sim.privateState = createTenantProofPrivateState(fromHex(p.callerSecretKeyHex, 32));
    await this.sim.call('attest', att.leaf);
    return { leafHex: toHex(att.leaf), saltHex: toHex(att.salt), snapshot: this.snapshot() };
  }

  /** Landlord lists a room. The contract derives the id from the landlord's key and the label. */
  async createListing(p: { landlordSecretKeyHex: string; label: string; rent: bigint; multiplierTenths: bigint }) {
    const sk = fromHex(p.landlordSecretKeyHex, 32);
    this.sim.privateState = createTenantProofPrivateState(sk);
    await this.sim.call('createListing', listingLabelBytes(p.label.trim()), p.rent, p.multiplierTenths);
    return { listingIdHex: toHex(listingIdFor(p.label.trim(), sk)), snapshot: this.snapshot() };
  }

  /**
   * Landlord closes a listing for good, by the label bytes stored on the ledger.
   * With any other key the contract finds no such listing.
   */
  async closeListing(p: { callerSecretKeyHex: string; labelHex: string }) {
    this.sim.privateState = createTenantProofPrivateState(fromHex(p.callerSecretKeyHex, 32));
    await this.sim.call('closeListing', fromHex(p.labelHex, 32));
    return { snapshot: this.snapshot() };
  }

  /** Tenant proves income >= the listing's multiplier x rent. `income` and `salt` are witness inputs only. */
  async apply(p: { tenantSecretKeyHex: string; income: bigint; saltHex: string; listingIdHex: string }) {
    const id = fromHex(p.listingIdHex, 32);
    const sk = fromHex(p.tenantSecretKeyHex, 32);
    this.sim.privateState = createTenantProofPrivateState(sk, p.income, fromHex(p.saltHex, 32));
    await this.sim.call('apply', id);
    return { applicationIdHex: toHex(applicationIdFor(id, sk)), snapshot: this.snapshot() };
  }
}
