// This file is part of TenantProof.
// SPDX-License-Identifier: Apache-2.0
//
// In-memory tests: the compiled contract runs with compact-runtime, with no
// network and no proofs. The guards and the privacy invariants are tested here;
// tenant-proof.test.ts runs the end-to-end flow on a real network.

import { describe, expect, it } from 'vitest';
import { Sim, assertNotInPublicState, expectRejects } from './sim.js';
import { Contract, ledger, pureCircuits } from '../../contract/managed/tenant-proof/contract/index.js';
import { createTenantProofPrivateState, witnesses, type TenantProofPrivateState } from '../../contract/witnesses.js';
import { applicationIdFor, issueAttestation, listingIdFromLabel, randomBytes32, tenantPublicKey } from '../attest.js';

const RENT = 1500n;
const ROOM_A = listingIdFromLabel('bukit-jalil-room-a');
const STUDIO = listingIdFromLabel('cyberjaya-studio');

/** Deploys with a fresh issuer, lists ROOM_A, and returns helpers per role. */
const setup = async () => {
  const issuerSk = randomBytes32();
  const landlordSk = randomBytes32();
  const issuer = createTenantProofPrivateState(issuerSk);
  const landlord = createTenantProofPrivateState(landlordSk);
  const sim = await Sim.deploy({ contract: new Contract(witnesses), ledger, privateState: issuer });

  const as = (ps: TenantProofPrivateState) => {
    sim.privateState = ps;
    return sim;
  };
  /** The issuer attests a new tenant's income; returns that tenant's private state. */
  const newTenant = async (income: bigint): Promise<TenantProofPrivateState> => {
    const sk = randomBytes32();
    const att = issueAttestation(income, tenantPublicKey(sk));
    await as(issuer).call('attest', att.leaf);
    return createTenantProofPrivateState(sk, att.income, att.salt);
  };

  await as(landlord).call('createListing', ROOM_A, RENT);
  return { sim, issuerSk, issuer, landlord, as, newTenant };
};

describe('TenantProof (in memory)', () => {
  it('records the deployer as the issuer', async () => {
    const { sim, issuerSk } = await setup();
    expect(sim.ledger().issuerPk).toEqual(pureCircuits.publicKey(issuerSk));
    expect(sim.ledger().attestationCount).toBe(0n);
  });

  describe('attest', () => {
    it('lets the issuer publish an attestation', async () => {
      const { sim, newTenant } = await setup();
      await newTenant(5000n);
      expect(sim.ledger().attestationCount).toBe(1n);
    });

    it('rejects anyone else', async () => {
      const { as } = await setup();
      const fake = createTenantProofPrivateState(randomBytes32());
      const att = issueAttestation(99999n, tenantPublicKey(fake.secretKey));
      await expectRejects(() => as(fake).call('attest', att.leaf), 'Only the issuer can attest');
    });
  });

  describe('createListing', () => {
    it('stores the rent publicly', async () => {
      const { sim } = await setup();
      expect(sim.ledger().listings.lookup(ROOM_A)).toBe(RENT);
    });

    it('rejects a duplicate listing id', async () => {
      const { as, landlord } = await setup();
      await expectRejects(() => as(landlord).call('createListing', ROOM_A, 900n), 'Listing already exists');
    });

    it('rejects zero rent', async () => {
      const { as, landlord } = await setup();
      await expectRejects(() => as(landlord).call('createListing', STUDIO, 0n), 'Rent must be positive');
    });
  });

  describe('apply', () => {
    it('accepts income of exactly 3x rent and records an application', async () => {
      const { sim, as, newTenant } = await setup();
      const tenant = await newTenant(3n * RENT);
      const { ledger: l } = await as(tenant).call('apply', ROOM_A);
      const app = applicationIdFor(ROOM_A, tenant.secretKey);
      expect(l.applications.size()).toBe(1n);
      expect(l.applications.member(app)).toBe(true);
      expect(l.applications.lookup(app)).toEqual(ROOM_A);
      expect(sim.ledger().applications.size()).toBe(1n);
    });

    it('rejects income one below 3x rent', async () => {
      const { sim, as, newTenant } = await setup();
      const tenant = await newTenant(3n * RENT - 1n);
      await expectRejects(() => as(tenant).call('apply', ROOM_A), 'Income is below 3x the rent');
      expect(sim.ledger().applications.size()).toBe(0n);
    });

    it('rejects a tenant who claims a higher income than attested', async () => {
      const { sim, as, newTenant } = await setup();
      const real = await newTenant(2000n);
      const liar = createTenantProofPrivateState(real.secretKey, 9000n, real.incomeSalt);
      await expectRejects(() => as(liar).call('apply', ROOM_A), 'No issuer attestation');
      expect(sim.ledger().applications.size()).toBe(0n);
    });

    it('rejects a tenant with no attestation', async () => {
      const { as } = await setup();
      const stranger = createTenantProofPrivateState(randomBytes32(), 9000n, randomBytes32());
      await expectRejects(() => as(stranger).call('apply', ROOM_A), 'No issuer attestation');
    });

    it("rejects a tampered witness that supplies another tenant's valid path", async () => {
      // A malicious client can run any witness code it likes. The circuit
      // itself must reject a path that belongs to someone else's leaf.
      // A genuine tenant earning 2000 is attested.
      const realLeaf = issueAttestation(2000n, tenantPublicKey(randomBytes32())).leaf;
      // The attacker's client returns that genuine leaf's valid path, whatever leaf it is asked for.
      const evilWitnesses: typeof witnesses = {
        ...witnesses,
        attestationPath: ({ privateState, ledger: l }) => [privateState, l.attestations.findPathForLeaf(realLeaf)!],
      };
      const sim = await Sim.deploy({
        contract: new Contract(evilWitnesses),
        ledger,
        privateState: createTenantProofPrivateState(randomBytes32()), // deployer = issuer
      });
      await sim.call('createListing', ROOM_A, RENT);
      await sim.call('attest', realLeaf);
      // Attacker claims 9000 with no attestation of their own.
      sim.privateState = createTenantProofPrivateState(randomBytes32(), 9000n, randomBytes32());
      await expectRejects(() => sim.call('apply', ROOM_A), 'Attestation path is for a different leaf');
    });

    it("rejects a tampered witness that relabels another tenant's path with the attacker's leaf", async () => {
      // The path is valid for the genuine leaf, but the attacker swaps in their
      // own leaf so the `path.leaf == leaf` check passes. The recomputed root
      // then matches no root the tree ever had: the circuit's root check fires.
      const realLeaf = issueAttestation(2000n, tenantPublicKey(randomBytes32())).leaf;
      const evilWitnesses: typeof witnesses = {
        ...witnesses,
        attestationPath: ({ privateState, ledger: l }, leaf) => [
          privateState,
          { ...l.attestations.findPathForLeaf(realLeaf)!, leaf },
        ],
      };
      const sim = await Sim.deploy({
        contract: new Contract(evilWitnesses),
        ledger,
        privateState: createTenantProofPrivateState(randomBytes32()), // deployer = issuer
      });
      await sim.call('createListing', ROOM_A, RENT);
      await sim.call('attest', realLeaf);
      sim.privateState = createTenantProofPrivateState(randomBytes32(), 9000n, randomBytes32());
      await expectRejects(() => sim.call('apply', ROOM_A), 'failed assert: No issuer attestation for this income');
      expect(sim.ledger().applications.size()).toBe(0n);
    });

    it('rejects an unknown listing', async () => {
      const { as, newTenant } = await setup();
      const tenant = await newTenant(9000n);
      await expectRejects(() => as(tenant).call('apply', STUDIO), 'Unknown listing');
    });

    it('rejects applying twice to the same listing', async () => {
      const { as, newTenant } = await setup();
      const tenant = await newTenant(9000n);
      await as(tenant).call('apply', ROOM_A);
      await expectRejects(() => as(tenant).call('apply', ROOM_A), 'Already applied');
    });

    it('lets one tenant apply to two listings with two different application ids', async () => {
      const { sim, as, landlord, newTenant } = await setup();
      await as(landlord).call('createListing', STUDIO, 1000n);
      const tenant = await newTenant(9000n);
      await as(tenant).call('apply', ROOM_A);
      await as(tenant).call('apply', STUDIO);
      const a = applicationIdFor(ROOM_A, tenant.secretKey);
      const b = applicationIdFor(STUDIO, tenant.secretKey);
      expect(a).not.toEqual(b);
      expect(sim.ledger().applications.size()).toBe(2n);
    });

    it('still accepts an application after the issuer attests someone else (historic root)', async () => {
      const { as, newTenant } = await setup();
      const tenant = await newTenant(9000n);
      await newTenant(4000n);
      await newTenant(7000n);
      await as(tenant).call('apply', ROOM_A);
    });
  });

  // One entry per "Never on the ledger" line of the README table.
  it('keeps secrets out of public state', async () => {
    const { sim, as, issuerSk, newTenant } = await setup();
    const tenant = await newTenant(7777n);
    await as(tenant).call('apply', ROOM_A);
    const l = sim.ledger();
    expect(Object.keys(l).sort()).toEqual(['applications', 'attestationCount', 'attestations', 'issuerPk', 'listings']);
    // Sanity: the walker does see the public data we expect to be there.
    expect(l.applications.member(applicationIdFor(ROOM_A, tenant.secretKey))).toBe(true);
    const incomeBytes = new Uint8Array(32);
    new DataView(incomeBytes.buffer).setUint32(0, 7777, true);
    assertNotInPublicState(l, {
      tenantSecretKey: tenant.secretKey,
      tenantPublicKey: tenantPublicKey(tenant.secretKey),
      incomeSalt: tenant.incomeSalt!,
      incomeAsBytes: incomeBytes.slice(0, 4),
      issuerSecretKey: issuerSk,
    });
  });
});
