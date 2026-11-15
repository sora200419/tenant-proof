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

/** Listing ids are 32 bytes; derive one from a human label (UTF-8, zero-padded). */
export const listingIdFromLabel = (label: string): Uint8Array => {
  const bytes = new TextEncoder().encode(label);
  if (bytes.length === 0 || bytes.length > 32) throw new Error('Listing label must be 1-32 bytes of UTF-8');
  const out = new Uint8Array(32);
  out.set(bytes);
  return out;
};

export const applicationIdFor = (listingId: Uint8Array, tenantSecretKey: Uint8Array): Uint8Array =>
  pureCircuits.applicationId(listingId, tenantSecretKey);
