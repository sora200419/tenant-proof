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
import {
  applicationIdFor,
  issueAttestation,
  listingIdFor,
  listingLabelBytes,
  parseMultiplierTenths,
  randomBytes32,
  requiredIncome,
  tenantPublicKey,
} from '../attest.js';

const RENT = 1500n;
const THREE_X = 30n; // multiplier in tenths
const ROOM_A = 'bukit-jalil-room-a';
const STUDIO = 'cyberjaya-studio';
const UINT32_MAX = 0xffffffffn;

/** Deploys with a fresh issuer, lists ROOM_A at RENT and 3.0x, and returns helpers per role. */
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
  /** Lists a room as `who`; returns the id the contract gives it. */
  const list = async (who: TenantProofPrivateState, label: string, rent: bigint, m: bigint) => {
    await as(who).call('createListing', listingLabelBytes(label), rent, m);
    return listingIdFor(label, who.secretKey);
  };
  const close = (who: TenantProofPrivateState, label: string) => as(who).call('closeListing', listingLabelBytes(label));

  const roomA = await list(landlord, ROOM_A, RENT, THREE_X);
  return { sim, issuerSk, issuer, landlordSk, landlord, as, newTenant, list, close, roomA };
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
    it("stores label, rent, multiplier and open under an id derived from the landlord's key", async () => {
      const { sim, landlordSk, roomA } = await setup();
      expect(roomA).toEqual(pureCircuits.listingId(listingLabelBytes(ROOM_A), landlordSk));
      expect(sim.ledger().listings.size()).toBe(1n);
      const l = sim.ledger().listings.lookup(roomA);
      expect(l.label).toEqual(listingLabelBytes(ROOM_A));
      expect(l.rent).toBe(RENT);
      expect(l.multiplierTenths).toBe(THREE_X);
      expect(l.open).toBe(true);
    });

    it('gives the listing id its own hash domain (not a public key or an application id of the same secret)', async () => {
      const { landlordSk, roomA } = await setup();
      expect(roomA).not.toEqual(pureCircuits.publicKey(landlordSk));
      expect(roomA).not.toEqual(pureCircuits.applicationId(listingLabelBytes(ROOM_A), landlordSk));
    });

    it("cannot be squatted: another key listing the same label first gets its own id, and the landlord's listing still goes through", async () => {
      const { sim, list } = await setup();
      const realLandlord = createTenantProofPrivateState(randomBytes32());
      const squatter = createTenantProofPrivateState(randomBytes32());
      // The squatter sees the label (it is public) and lists it first, with a
      // cheaper rent and a 1.0x bar, to grab the id.
      const squatted = await list(squatter, STUDIO, 1n, 10n);
      const real = await list(realLandlord, STUDIO, 1000n, 25n);
      expect(real).not.toEqual(squatted);
      expect(sim.ledger().listings.lookup(real).rent).toBe(1000n);
      expect(sim.ledger().listings.lookup(real).multiplierTenths).toBe(25n);
      expect(sim.ledger().listings.lookup(squatted).rent).toBe(1n);
    });

    it('rejects a replay of the same listing by the same landlord, and leaves the original untouched', async () => {
      const { sim, as, landlord, roomA } = await setup();
      await expectRejects(() => as(landlord).call('createListing', listingLabelBytes(ROOM_A), 900n, 10n), 'Listing already exists');
      expect(sim.ledger().listings.lookup(roomA).rent).toBe(RENT);
      expect(sim.ledger().listings.lookup(roomA).multiplierTenths).toBe(THREE_X);
    });

    it('rejects zero rent', async () => {
      const { as, landlord } = await setup();
      await expectRejects(() => as(landlord).call('createListing', listingLabelBytes(STUDIO), 0n, THREE_X), 'Rent must be positive');
    });

    it.each([0n, 9n, 101n, 255n])('rejects a multiplier of %s tenths (outside 1.0x-10.0x)', async (m) => {
      const { sim, as, landlord } = await setup();
      await expectRejects(
        () => as(landlord).call('createListing', listingLabelBytes(STUDIO), 1000n, m),
        'Multiplier must be between 1.0x and 10.0x',
      );
      expect(sim.ledger().listings.size()).toBe(1n);
    });

    it.each([10n, 100n])('accepts the boundary multiplier of %s tenths', async (m) => {
      const { sim, list, landlord } = await setup();
      const id = await list(landlord, STUDIO, 1000n, m);
      expect(sim.ledger().listings.lookup(id).multiplierTenths).toBe(m);
    });
  });

  describe('closeListing', () => {
    it('lets the landlord close its listing; applications already made stay', async () => {
      const { sim, as, landlord, newTenant, close, roomA } = await setup();
      const tenant = await newTenant(9000n);
      await as(tenant).call('apply', roomA);
      await close(landlord, ROOM_A);
      const l = sim.ledger().listings.lookup(roomA);
      expect(l.open).toBe(false);
      expect(l.rent).toBe(RENT);
      expect(l.multiplierTenths).toBe(THREE_X);
      expect(l.label).toEqual(listingLabelBytes(ROOM_A));
      expect(sim.ledger().applications.member(applicationIdFor(roomA, tenant.secretKey))).toBe(true);
    });

    it("rejects anyone else closing the landlord's listing", async () => {
      // Any other key, including the issuer's and a tenant's, derives a different id.
      const { sim, issuer, newTenant, close, roomA } = await setup();
      const tenant = await newTenant(9000n);
      for (const other of [createTenantProofPrivateState(randomBytes32()), issuer, tenant]) {
        await expectRejects(() => close(other, ROOM_A), 'Unknown listing');
      }
      expect(sim.ledger().listings.lookup(roomA).open).toBe(true);
    });

    it("rejects a tampered client that returns its own key from the secretKey witness: it cannot produce the landlord's", async () => {
      // A malicious client can run any witness code. Without the landlord's
      // secret it can only return some other key, which derives another id.
      let tampered = false;
      const sim = await Sim.deploy({
        contract: new Contract({
          ...witnesses,
          secretKey: ({ privateState }) => [privateState, tampered ? randomBytes32() : privateState.secretKey],
        }),
        ledger,
        privateState: createTenantProofPrivateState(randomBytes32()),
      });
      const landlordSk = randomBytes32();
      sim.privateState = createTenantProofPrivateState(landlordSk);
      await sim.call('createListing', listingLabelBytes(ROOM_A), RENT, THREE_X);
      tampered = true;
      await expectRejects(() => sim.call('closeListing', listingLabelBytes(ROOM_A)), 'Unknown listing');
      expect(sim.ledger().listings.lookup(listingIdFor(ROOM_A, landlordSk)).open).toBe(true);
    });

    it('rejects closing twice (replay)', async () => {
      const { landlord, close } = await setup();
      await close(landlord, ROOM_A);
      await expectRejects(() => close(landlord, ROOM_A), 'Listing is already closed');
    });

    it('rejects closing a listing that was never created (close before create)', async () => {
      const { landlord, close } = await setup();
      await expectRejects(() => close(landlord, STUDIO), 'Unknown listing');
    });

    it('is permanent: the same landlord cannot list the same label again', async () => {
      const { as, landlord, close } = await setup();
      await close(landlord, ROOM_A);
      await expectRejects(() => as(landlord).call('createListing', listingLabelBytes(ROOM_A), RENT, THREE_X), 'Listing already exists');
    });

    it('leaves the landlord free to list a new label after closing', async () => {
      const { sim, landlord, close, list } = await setup();
      await close(landlord, ROOM_A);
      const next = await list(landlord, `${ROOM_A}-2`, RENT, 25n);
      expect(sim.ledger().listings.lookup(next).open).toBe(true);
    });
  });

  describe('apply', () => {
    it('accepts income of exactly 3.0x rent and records an application', async () => {
      const { sim, as, newTenant, roomA } = await setup();
      const tenant = await newTenant(3n * RENT);
      const { ledger: l } = await as(tenant).call('apply', roomA);
      const app = applicationIdFor(roomA, tenant.secretKey);
      expect(l.applications.size()).toBe(1n);
      expect(l.applications.member(app)).toBe(true);
      expect(l.applications.lookup(app)).toEqual(roomA);
      expect(sim.ledger().applications.size()).toBe(1n);
    });

    it('rejects income one below 3.0x rent', async () => {
      const { sim, as, newTenant, roomA } = await setup();
      const tenant = await newTenant(3n * RENT - 1n);
      await expectRejects(() => as(tenant).call('apply', roomA), "Income is below the listing's required multiple of the rent");
      expect(sim.ledger().applications.size()).toBe(0n);
    });

    // [multiplier text, rent, smallest passing income]
    it.each([
      ['2.5', 1000n, 2500n],
      ['1', 1000n, 1000n],
      ['10', 1000n, 10000n],
      ['3.3', 1001n, 3304n], // 3303.3 rounds up: 3303 * 10 < 33 * 1001
      ['1', UINT32_MAX, UINT32_MAX], // the largest values do not wrap
    ])('uses the listing\'s own multiplier: %sx of rent %s needs %s', async (text, rent, minIncome) => {
      const { as, landlord, newTenant, list } = await setup();
      const m = parseMultiplierTenths(text);
      expect(requiredIncome(rent, m)).toBe(minIncome);
      const id = await list(landlord, STUDIO, rent, m);
      const below = await newTenant(minIncome - 1n);
      await expectRejects(() => as(below).call('apply', id), "Income is below the listing's required multiple of the rent");
      const enough = await newTenant(minIncome);
      await as(enough).call('apply', id);
    });

    it('rejects the largest income for a 10.0x listing at the largest rent (no overflow)', async () => {
      const { as, landlord, newTenant, list } = await setup();
      const id = await list(landlord, STUDIO, UINT32_MAX, 100n);
      const rich = await newTenant(UINT32_MAX);
      await expectRejects(() => as(rich).call('apply', id), "Income is below the listing's required multiple of the rent");
    });

    it('applies two listings with different multipliers to the same tenant independently', async () => {
      const { as, landlord, newTenant, list, roomA } = await setup();
      const studio = await list(landlord, STUDIO, 1000n, 25n);
      const bob = await newTenant(3500n); // needs 4500 for room A, 2500 for the studio
      await expectRejects(() => as(bob).call('apply', roomA), "Income is below the listing's required multiple of the rent");
      await as(bob).call('apply', studio);
    });

    it('rejects applying to a closed listing, even with enough income', async () => {
      const { sim, as, landlord, newTenant, close, roomA } = await setup();
      const tenant = await newTenant(9000n);
      await close(landlord, ROOM_A);
      await expectRejects(() => as(tenant).call('apply', roomA), 'Listing is closed');
      expect(sim.ledger().applications.size()).toBe(0n);
    });

    it('rejects a tenant who claims a higher income than attested', async () => {
      const { sim, as, newTenant, roomA } = await setup();
      const real = await newTenant(2000n);
      const liar = createTenantProofPrivateState(real.secretKey, 9000n, real.incomeSalt);
      await expectRejects(() => as(liar).call('apply', roomA), 'No issuer attestation');
      expect(sim.ledger().applications.size()).toBe(0n);
    });

    it('rejects a tenant with no attestation', async () => {
      const { as, roomA } = await setup();
      const stranger = createTenantProofPrivateState(randomBytes32(), 9000n, randomBytes32());
      await expectRejects(() => as(stranger).call('apply', roomA), 'No issuer attestation');
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
      const deployer = createTenantProofPrivateState(randomBytes32()); // issuer, and landlord here
      const sim = await Sim.deploy({ contract: new Contract(evilWitnesses), ledger, privateState: deployer });
      await sim.call('createListing', listingLabelBytes(ROOM_A), RENT, THREE_X);
      await sim.call('attest', realLeaf);
      // Attacker claims 9000 with no attestation of their own.
      sim.privateState = createTenantProofPrivateState(randomBytes32(), 9000n, randomBytes32());
      await expectRejects(() => sim.call('apply', listingIdFor(ROOM_A, deployer.secretKey)), 'Attestation path is for a different leaf');
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
      const deployer = createTenantProofPrivateState(randomBytes32());
      const sim = await Sim.deploy({ contract: new Contract(evilWitnesses), ledger, privateState: deployer });
      await sim.call('createListing', listingLabelBytes(ROOM_A), RENT, THREE_X);
      await sim.call('attest', realLeaf);
      sim.privateState = createTenantProofPrivateState(randomBytes32(), 9000n, randomBytes32());
      await expectRejects(
        () => sim.call('apply', listingIdFor(ROOM_A, deployer.secretKey)),
        'failed assert: No issuer attestation for this income',
      );
      expect(sim.ledger().applications.size()).toBe(0n);
    });

    it('rejects an unknown listing (apply before the listing is created)', async () => {
      const { as, landlord, newTenant, list } = await setup();
      const tenant = await newTenant(9000n);
      const studio = listingIdFor(STUDIO, landlord.secretKey);
      await expectRejects(() => as(tenant).call('apply', studio), 'Unknown listing');
      await list(landlord, STUDIO, 1000n, THREE_X);
      await as(tenant).call('apply', studio);
    });

    it('rejects applying by label bytes instead of the listing id', async () => {
      const { as, newTenant } = await setup();
      const tenant = await newTenant(9000n);
      await expectRejects(() => as(tenant).call('apply', listingLabelBytes(ROOM_A)), 'Unknown listing');
    });

    it('rejects applying twice to the same listing (replay)', async () => {
      const { as, newTenant, roomA } = await setup();
      const tenant = await newTenant(9000n);
      await as(tenant).call('apply', roomA);
      await expectRejects(() => as(tenant).call('apply', roomA), 'Already applied');
    });

    it('lets one tenant apply to two listings with two different application ids', async () => {
      const { sim, as, landlord, newTenant, list, roomA } = await setup();
      const studio = await list(landlord, STUDIO, 1000n, THREE_X);
      const tenant = await newTenant(9000n);
      await as(tenant).call('apply', roomA);
      await as(tenant).call('apply', studio);
      const a = applicationIdFor(roomA, tenant.secretKey);
      const b = applicationIdFor(studio, tenant.secretKey);
      expect(a).not.toEqual(b);
      expect(sim.ledger().applications.size()).toBe(2n);
    });

    it('still accepts an application after the issuer attests someone else (historic root)', async () => {
      const { as, newTenant, roomA } = await setup();
      const tenant = await newTenant(9000n);
      await newTenant(4000n);
      await newTenant(7000n);
      await as(tenant).call('apply', roomA);
    });
  });

  // One entry per "Never on the ledger" line of the README table.
  it('keeps secrets out of public state', async () => {
    const { sim, as, issuerSk, landlordSk, newTenant, roomA } = await setup();
    const tenant = await newTenant(7777n);
    await as(tenant).call('apply', roomA);
    const l = sim.ledger();
    expect(Object.keys(l).sort()).toEqual(['applications', 'attestationCount', 'attestations', 'issuerPk', 'listings']);
    // Sanity: the walker does see the public data we expect to be there.
    expect(l.applications.member(applicationIdFor(roomA, tenant.secretKey))).toBe(true);
    const incomeBytes = new Uint8Array(32);
    new DataView(incomeBytes.buffer).setUint32(0, 7777, true);
    assertNotInPublicState(l, {
      tenantSecretKey: tenant.secretKey,
      tenantPublicKey: tenantPublicKey(tenant.secretKey),
      incomeSalt: tenant.incomeSalt!,
      incomeAsBytes: incomeBytes.slice(0, 4),
      issuerSecretKey: issuerSk,
      landlordSecretKey: landlordSk,
      landlordPublicKey: tenantPublicKey(landlordSk),
    });
  });
});
