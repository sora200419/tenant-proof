// This file is part of TenantProof.
// SPDX-License-Identifier: Apache-2.0
//
// Off-chain helpers shared by the tests, the deploy script and the UI.
// Browser-safe: no node:* imports.
import { pureCircuits } from '../contract/managed/tenant-proof/contract/index.js';

export const randomBytes32 = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

/** A tenant's public key, which the tenant gives the issuer (never the secret). */
export const tenantPublicKey = (tenantSecretKey: Uint8Array): Uint8Array => pureCircuits.publicKey(tenantSecretKey);

/**
 * What the issuer does off-chain for one tenant: pick a fresh salt and compute
 * the attestation leaf. The issuer publishes `leaf` with the `attest` circuit
 * and hands `{ income, salt }` to the tenant over a private channel.
 */
export const issueAttestation = (income: bigint, tenantPk: Uint8Array, salt: Uint8Array = randomBytes32()) => ({
  income,
  salt,
  leaf: pureCircuits.attestationLeaf(income, tenantPk, salt),
});

/** A listing's human label as the 32 bytes the contract stores (UTF-8, zero-padded). */
export const listingLabelBytes = (label: string): Uint8Array => {
  const bytes = new TextEncoder().encode(label);
  if (bytes.length === 0 || bytes.length > 32) throw new Error('Listing label must be 1-32 bytes of UTF-8');
  const out = new Uint8Array(32);
  out.set(bytes);
  return out;
};

/**
 * The id the contract gives a landlord's listing: a hash of the label and the
 * landlord's secret key (`listingId` in the contract). Another key with the
 * same label gets a different id.
 */
export const listingIdFor = (label: string, landlordSecretKey: Uint8Array): Uint8Array =>
  pureCircuits.listingId(listingLabelBytes(label), landlordSecretKey);

export const applicationIdFor = (listingId: Uint8Array, tenantSecretKey: Uint8Array): Uint8Array =>
  pureCircuits.applicationId(listingId, tenantSecretKey);

/** The multiplier range the contract accepts, in tenths (1.0x to 10.0x). */
export const MULTIPLIER_MIN_TENTHS = 10n;
export const MULTIPLIER_MAX_TENTHS = 100n;

/**
 * Parses a multiplier typed as `3` or `2.5` into tenths (30n, 25n). Only a dot
 * with one decimal digit is accepted; a comma or more digits is refused rather
 * than guessed. The 1.0-10.0 range is left to the contract, so its own message
 * is what the user sees; only values that cannot fit `Uint<8>` stop here.
 */
export const parseMultiplierTenths = (raw: string): bigint => {
  const t = raw.trim().replace(/[x×]$/i, '');
  const m = /^(\d{1,3})(?:\.(\d))?$/.exec(t);
  if (!m) throw new Error('Multiplier must be a number like 3 or 2.5 (a dot, at most one decimal)');
  const tenths = BigInt(m[1]!) * 10n + BigInt(m[2] ?? '0');
  if (tenths > 255n) throw new Error('Multiplier must be between 1.0x and 10.0x');
  return tenths;
};

/** 30n -> "3.0×". */
export const formatMultiplier = (tenths: bigint): string => `${tenths / 10n}.${tenths % 10n}×`;

/**
 * The smallest income that passes `income * 10 >= multiplierTenths * rent`,
 * for display only; the contract makes the decision.
 */
export const requiredIncome = (rent: bigint, multiplierTenths: bigint): bigint =>
  (rent * multiplierTenths + 9n) / 10n;
