// This file is part of TenantProof.
// SPDX-License-Identifier: Apache-2.0
//
// TypeScript implementations of the contract's witnesses: the private inputs a
// circuit reads from the user's own device. They are never written to the
// ledger, but the proof server receives them to build the proof, so it must be
// the user's own (127.0.0.1:6300); a remote one would see income and salt.
// This file also runs in the browser, so no node:* imports.
import { type Ledger, type Witnesses } from './managed/tenant-proof/contract/index.js';
import { type WitnessContext } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';

/**
 * One participant's private state.
 * - issuer and landlord: only `secretKey`.
 * - tenant: `secretKey`, plus the `income` and `incomeSalt` the issuer handed
 *   over privately when it attested them.
 */
export type TenantProofPrivateState = {
  readonly secretKey: Uint8Array;
  readonly income?: bigint;
  readonly incomeSalt?: Uint8Array;
};

export const createTenantProofPrivateState = (
  secretKey: Uint8Array,
  income?: bigint,
  incomeSalt?: Uint8Array,
): TenantProofPrivateState => {
  if (secretKey.length !== 32) throw new Error('secretKey must be 32 bytes');
  if (incomeSalt !== undefined && incomeSalt.length !== 32) throw new Error('incomeSalt must be 32 bytes');
  if (income !== undefined && (income < 0n || income > 0xffffffffn)) throw new Error('income must fit in Uint<32>');
  return { secretKey, ...(income === undefined ? {} : { income }), ...(incomeSalt === undefined ? {} : { incomeSalt }) };
};

// @generated-stub begin witnesses sha=edited
export const witnesses: Witnesses<TenantProofPrivateState> = {
  secretKey: ({ privateState }) => [privateState, privateState.secretKey],
  income: ({ privateState }) => {
    if (privateState.income === undefined) throw new Error('No attested income in private state');
    return [privateState, privateState.income];
  },
  incomeSalt: ({ privateState }) => {
    if (privateState.incomeSalt === undefined) throw new Error('No attestation salt in private state');
    return [privateState, privateState.incomeSalt];
  },
  // Looked up in the attestation tree of the ledger state the circuit runs
  // against. The tree is historic, so the root stays acceptable even if the
  // issuer attests someone else before this transaction lands.
  //
  // If the leaf is not in the tree, return a placeholder path instead of
  // throwing. The decision then belongs to the circuit's own root check
  // ("No issuer attestation for this income"), which is what a deployed
  // contract enforces, rather than to this client-side code.
  attestationPath: ({ privateState, ledger }, leaf) => {
    const path = ledger.attestations.findPathForLeaf(leaf) ?? {
      leaf,
      path: Array.from({ length: 10 }, () => ({ sibling: { field: 0n }, goes_left: true })),
    };
    return [privateState, path];
  },
};
// @generated-stub end witnesses

export type { Ledger, Witnesses, WitnessContext };
