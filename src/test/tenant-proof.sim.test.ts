// This file is part of TenantProof.
// SPDX-License-Identifier: Apache-2.0
//
// In-memory tests: the compiled contract runs with compact-runtime, with no
// network and no proofs. The guards and the privacy invariants are tested here;
// tenant-proof.test.ts runs the end-to-end flow on a real network.

import { describe, expect, it } from 'vitest';
import { Sim, assertNotInPublicState, expectRejects } from './sim.js';
import { Contract, ledger, pureCircuits, type Ledger } from '../../contract/managed/tenant-proof/contract/index.js';
import { createTenantProofPrivateState, witnesses, type TenantProofPrivateState } from '../../contract/witnesses.js';
import {
  applicationIdFor,
  checkTimeFor,
  issueAttestation,
  leafIndexFromPath,
  listingIdFor,
  listingLabelBytes,
  parseMultiplierTenths,
  randomBytes32,
  requiredIncome,
  SECONDS_PER_DAY,
  tenantPublicKey,
} from '../attest.js';

const RENT = 1500n;
const THREE_X = 30n; // multiplier in tenths
const ROOM_A = 'bukit-jalil-room-a';
const STUDIO = 'cyberjaya-studio';
const UINT32_MAX = 0xffffffffn;

// Fixed clock (never the real date): 2026-01-01T00:00:00Z, block time of every call
// unless a test moves it. T is the public check time a client sends at NOW.
const NOW = 1_767_225_600n;
const T = checkTimeFor(NOW);
/** Default expiry of a test attestation: 90 days after NOW. */
const EXPIRES = NOW + 90n * SECONDS_PER_DAY;

/** A fresh in-memory deployment whose block time is pinned to NOW. */
const deployAt = async (w: typeof witnesses, privateState: TenantProofPrivateState) => {
  const sim = await Sim.deploy({ contract: new Contract(w), ledger, privateState });
  sim.time = Number(NOW);
  return sim;
};

/** Deploys with a fresh issuer, lists ROOM_A at RENT and 3.0x, and returns helpers per role. */
const setup = async () => {
  const issuerSk = randomBytes32();
  const landlordSk = randomBytes32();
  const issuer = createTenantProofPrivateState(issuerSk);
  const landlord = createTenantProofPrivateState(landlordSk);
  const sim = await deployAt(witnesses, issuer);

  const as = (ps: TenantProofPrivateState) => {
    sim.privateState = ps;
    return sim;
  };
  /** The issuer attests a new tenant's income; returns that tenant's private state and the leaf. */
  const attestTenant = async (income: bigint, expiresAt = EXPIRES) => {
    const sk = randomBytes32();
    const att = issueAttestation(income, tenantPublicKey(sk), expiresAt);
    await as(issuer).call('attest', att.leaf);
    return { tenant: createTenantProofPrivateState(sk, att.income, att.salt, att.expiresAt), leaf: att.leaf };
  };
  const newTenant = async (income: bigint, expiresAt = EXPIRES): Promise<TenantProofPrivateState> =>
    (await attestTenant(income, expiresAt)).tenant;
  /** The issuer revokes the attestation at this index. */
  const revoke = (index: bigint) => as(issuer).call('revoke', index);
  /** Lists a room as `who`; returns the id the contract gives it. */
  const list = async (who: TenantProofPrivateState, label: string, rent: bigint, m: bigint) => {
    await as(who).call('createListing', listingLabelBytes(label), rent, m);
    return listingIdFor(label, who.secretKey);
  };
  const close = (who: TenantProofPrivateState, label: string) => as(who).call('closeListing', listingLabelBytes(label));

  const roomA = await list(landlord, ROOM_A, RENT, THREE_X);
  return { sim, issuerSk, issuer, landlordSk, landlord, as, attestTenant, newTenant, revoke, list, close, roomA };
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
      const att = issueAttestation(99999n, tenantPublicKey(fake.secretKey), EXPIRES);
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
      await as(tenant).call('apply', roomA, T);
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
      const { ledger: l } = await as(tenant).call('apply', roomA, T);
      const app = applicationIdFor(roomA, tenant.secretKey);
      expect(l.applications.size()).toBe(1n);
      expect(l.applications.member(app)).toBe(true);
      expect(l.applications.lookup(app)).toEqual(roomA);
      expect(sim.ledger().applications.size()).toBe(1n);
    });

    it('rejects income one below 3.0x rent', async () => {
      const { sim, as, newTenant, roomA } = await setup();
      const tenant = await newTenant(3n * RENT - 1n);
      await expectRejects(() => as(tenant).call('apply', roomA, T), "Income is below the listing's required multiple of the rent");
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
      await expectRejects(() => as(below).call('apply', id, T), "Income is below the listing's required multiple of the rent");
      const enough = await newTenant(minIncome);
      await as(enough).call('apply', id, T);
    });

    it('rejects the largest income for a 10.0x listing at the largest rent (no overflow)', async () => {
      const { as, landlord, newTenant, list } = await setup();
      const id = await list(landlord, STUDIO, UINT32_MAX, 100n);
      const rich = await newTenant(UINT32_MAX);
      await expectRejects(() => as(rich).call('apply', id, T), "Income is below the listing's required multiple of the rent");
    });

    it('applies two listings with different multipliers to the same tenant independently', async () => {
      const { as, landlord, newTenant, list, roomA } = await setup();
      const studio = await list(landlord, STUDIO, 1000n, 25n);
      const bob = await newTenant(3500n); // needs 4500 for room A, 2500 for the studio
      await expectRejects(() => as(bob).call('apply', roomA, T), "Income is below the listing's required multiple of the rent");
      await as(bob).call('apply', studio, T);
    });

    it('rejects applying to a closed listing, even with enough income', async () => {
      const { sim, as, landlord, newTenant, close, roomA } = await setup();
      const tenant = await newTenant(9000n);
      await close(landlord, ROOM_A);
      await expectRejects(() => as(tenant).call('apply', roomA, T), 'Listing is closed');
      expect(sim.ledger().applications.size()).toBe(0n);
    });

    it('rejects a tenant who claims a higher income than attested', async () => {
      const { sim, as, newTenant, roomA } = await setup();
      const real = await newTenant(2000n);
      const liar = createTenantProofPrivateState(real.secretKey, 9000n, real.incomeSalt, real.expiresAt);
      await expectRejects(() => as(liar).call('apply', roomA, T), 'No issuer attestation');
      expect(sim.ledger().applications.size()).toBe(0n);
    });

    it('rejects a tenant with no attestation', async () => {
      const { as, roomA } = await setup();
      const stranger = createTenantProofPrivateState(randomBytes32(), 9000n, randomBytes32(), EXPIRES);
      await expectRejects(() => as(stranger).call('apply', roomA, T), 'No issuer attestation');
    });

    it("rejects a tampered witness that supplies another tenant's valid path", async () => {
      // A malicious client can run any witness code it likes. The circuit
      // itself must reject a path that belongs to someone else's leaf.
      // A genuine tenant earning 2000 is attested.
      const realLeaf = issueAttestation(2000n, tenantPublicKey(randomBytes32()), EXPIRES).leaf;
      // The attacker's client returns that genuine leaf's valid path, whatever leaf it is asked for.
      const evilWitnesses: typeof witnesses = {
        ...witnesses,
        attestationPath: ({ privateState, ledger: l }) => [privateState, l.attestations.findPathForLeaf(realLeaf)!],
      };
      const deployer = createTenantProofPrivateState(randomBytes32()); // issuer, and landlord here
      const sim = await deployAt(evilWitnesses, deployer);
      await sim.call('createListing', listingLabelBytes(ROOM_A), RENT, THREE_X);
      await sim.call('attest', realLeaf);
      // Attacker claims 9000 with no attestation of their own.
      sim.privateState = createTenantProofPrivateState(randomBytes32(), 9000n, randomBytes32(), EXPIRES);
      await expectRejects(() => sim.call('apply', listingIdFor(ROOM_A, deployer.secretKey), T), 'Attestation path is for a different leaf');
    });

    it("rejects a tampered witness that relabels another tenant's path with the attacker's leaf", async () => {
      // The path is valid for the genuine leaf, but the attacker swaps in their
      // own leaf so the `path.leaf == leaf` check passes. The recomputed root
      // then matches no root the tree ever had: the circuit's root check fires.
      const realLeaf = issueAttestation(2000n, tenantPublicKey(randomBytes32()), EXPIRES).leaf;
      const evilWitnesses: typeof witnesses = {
        ...witnesses,
        attestationPath: ({ privateState, ledger: l }, leaf) => [
          privateState,
          { ...l.attestations.findPathForLeaf(realLeaf)!, leaf },
        ],
      };
      const deployer = createTenantProofPrivateState(randomBytes32());
      const sim = await deployAt(evilWitnesses, deployer);
      await sim.call('createListing', listingLabelBytes(ROOM_A), RENT, THREE_X);
      await sim.call('attest', realLeaf);
      sim.privateState = createTenantProofPrivateState(randomBytes32(), 9000n, randomBytes32(), EXPIRES);
      await expectRejects(
        () => sim.call('apply', listingIdFor(ROOM_A, deployer.secretKey), T),
        'failed assert: No issuer attestation for this income',
      );
      expect(sim.ledger().applications.size()).toBe(0n);
    });

    it('rejects an unknown listing (apply before the listing is created)', async () => {
      const { as, landlord, newTenant, list } = await setup();
      const tenant = await newTenant(9000n);
      const studio = listingIdFor(STUDIO, landlord.secretKey);
      await expectRejects(() => as(tenant).call('apply', studio, T), 'Unknown listing');
      await list(landlord, STUDIO, 1000n, THREE_X);
      await as(tenant).call('apply', studio, T);
    });

    it('rejects applying by label bytes instead of the listing id', async () => {
      const { as, newTenant } = await setup();
      const tenant = await newTenant(9000n);
      await expectRejects(() => as(tenant).call('apply', listingLabelBytes(ROOM_A), T), 'Unknown listing');
    });

    it('rejects applying twice to the same listing (replay)', async () => {
      const { as, newTenant, roomA } = await setup();
      const tenant = await newTenant(9000n);
      await as(tenant).call('apply', roomA, T);
      await expectRejects(() => as(tenant).call('apply', roomA, T), 'Already applied');
    });

    it('lets one tenant apply to two listings with two different application ids', async () => {
      const { sim, as, landlord, newTenant, list, roomA } = await setup();
      const studio = await list(landlord, STUDIO, 1000n, THREE_X);
      const tenant = await newTenant(9000n);
      await as(tenant).call('apply', roomA, T);
      await as(tenant).call('apply', studio, T);
      const a = applicationIdFor(roomA, tenant.secretKey);
      const b = applicationIdFor(studio, tenant.secretKey);
      expect(a).not.toEqual(b);
      expect(sim.ledger().applications.size()).toBe(2n);
    });

    it('still accepts a path built against an older root after the issuer attests someone else (historic root)', async () => {
      // The default witness reads the path from the current tree, which would
      // never test an old root. This one returns the path the tenant's client
      // read before two more tenants were attested, as a client that built its
      // proof earlier would.
      let stalePath: ReturnType<Ledger['attestations']['findPathForLeaf']>;
      const staleWitnesses: typeof witnesses = {
        ...witnesses,
        attestationPath: (ctx, leaf) => (stalePath ? [ctx.privateState, stalePath] : witnesses.attestationPath(ctx, leaf)),
      };
      const issuer = createTenantProofPrivateState(randomBytes32());
      const landlord = createTenantProofPrivateState(randomBytes32());
      const sim = await deployAt(staleWitnesses, issuer);
      sim.privateState = landlord;
      await sim.call('createListing', listingLabelBytes(ROOM_A), RENT, THREE_X);
      const roomA = listingIdFor(ROOM_A, landlord.secretKey);

      const sk = randomBytes32();
      const att = issueAttestation(9000n, tenantPublicKey(sk), EXPIRES);
      sim.privateState = issuer;
      await sim.call('attest', att.leaf);
      stalePath = sim.ledger().attestations.findPathForLeaf(att.leaf);
      expect(stalePath).toBeDefined();
      const oldRoot = sim.ledger().attestations.root();

      for (const income of [4000n, 7000n]) {
        await sim.call('attest', issueAttestation(income, tenantPublicKey(randomBytes32()), EXPIRES).leaf);
      }
      const tree = sim.ledger().attestations;
      expect(tree.root()).not.toEqual(oldRoot);
      expect(tree.findPathForLeaf(att.leaf)).not.toEqual(stalePath);
      expect(tree.checkRoot(oldRoot)).toBe(true);

      sim.privateState = createTenantProofPrivateState(sk, att.income, att.salt, att.expiresAt);
      await sim.call('apply', roomA, T);
      expect(sim.ledger().applications.member(applicationIdFor(roomA, sk))).toBe(true);
    });
  });

  describe('apply: expiry', () => {
    it('accepts at both boundaries: block time == check time == expiresAt', async () => {
      const { sim, as, newTenant, roomA } = await setup();
      const tenant = await newTenant(9000n, T);
      sim.time = Number(T);
      await as(tenant).call('apply', roomA, T);
      expect(sim.ledger().applications.member(applicationIdFor(roomA, tenant.secretKey))).toBe(true);
    });

    it('rejects a check time one second before the block time', async () => {
      const { sim, as, newTenant, roomA } = await setup();
      const tenant = await newTenant(9000n);
      sim.time = Number(T) + 1;
      await expectRejects(() => as(tenant).call('apply', roomA, T), 'Check time is in the past');
      expect(sim.ledger().applications.size()).toBe(0n);
    });

    it('rejects an attestation that expires one second before the check time', async () => {
      const { sim, as, newTenant, roomA } = await setup();
      const tenant = await newTenant(9000n, T - 1n);
      await expectRejects(() => as(tenant).call('apply', roomA, T), 'Attestation has expired');
      expect(sim.ledger().applications.size()).toBe(0n);
    });

    it('accepts before expiry and rejects the same credential once the clock passes it (apply after expiry)', async () => {
      const { sim, as, landlord, newTenant, list, roomA } = await setup();
      const studio = await list(landlord, STUDIO, 1000n, THREE_X);
      const tenant = await newTenant(9000n);
      await as(tenant).call('apply', roomA, T);
      sim.time = Number(EXPIRES);
      await expectRejects(() => as(tenant).call('apply', studio, checkTimeFor(EXPIRES)), 'Attestation has expired');
      // The application made before expiry stays: it records that the check passed then.
      expect(sim.ledger().applications.member(applicationIdFor(roomA, tenant.secretKey))).toBe(true);
      expect(sim.ledger().applications.size()).toBe(1n);
    });

    it('rejects an expired tenant who sends an old check time instead (it is in the past)', async () => {
      const { sim, as, newTenant, roomA } = await setup();
      const tenant = await newTenant(9000n);
      sim.time = Number(EXPIRES + 1n);
      await expectRejects(() => as(tenant).call('apply', roomA, EXPIRES), 'Check time is in the past');
    });

    it('rejects a tampered witness that claims a later expiry than attested', async () => {
      const { sim, as, newTenant, roomA } = await setup();
      const real = await newTenant(9000n, T - 1n);
      const extended = createTenantProofPrivateState(real.secretKey, real.income, real.incomeSalt, EXPIRES + 365n * SECONDS_PER_DAY);
      await expectRejects(() => as(extended).call('apply', roomA, T), 'No issuer attestation');
      expect(sim.ledger().applications.size()).toBe(0n);
    });
  });

  describe('revoke', () => {
    it('records the index and stops the tenant from applying (revoke before apply)', async () => {
      const { sim, as, newTenant, revoke, roomA } = await setup();
      await newTenant(9000n); // index 0
      const tenant = await newTenant(9000n); // index 1
      await revoke(1n);
      expect(sim.ledger().revoked.member(1n)).toBe(true);
      expect(sim.ledger().revoked.size()).toBe(1n);
      expect(sim.ledger().attestationCount).toBe(2n);
      await expectRejects(() => as(tenant).call('apply', roomA, T), 'No issuer attestation');
      expect(sim.ledger().applications.size()).toBe(0n);
    });

    it('rejects anyone but the issuer', async () => {
      const { sim, as, landlord, newTenant } = await setup();
      const tenant = await newTenant(9000n);
      for (const other of [landlord, tenant, createTenantProofPrivateState(randomBytes32())]) {
        await expectRejects(() => as(other).call('revoke', 0n), 'Only the issuer can revoke');
      }
      expect(sim.ledger().revoked.size()).toBe(0n);
    });

    it('rejects an index that was never attested, and accepts the last one', async () => {
      const { revoke, newTenant } = await setup();
      await expectRejects(() => revoke(0n), 'Unknown attestation');
      await newTenant(9000n);
      await newTenant(9000n);
      await expectRejects(() => revoke(2n), 'Unknown attestation');
      await revoke(1n);
    });

    it('rejects revoking twice (replay)', async () => {
      const { revoke, newTenant } = await setup();
      await newTenant(9000n);
      await revoke(0n);
      await expectRejects(() => revoke(0n), 'Already revoked');
    });

    it('keeps an application made before the revocation (revoke after apply)', async () => {
      const { sim, as, landlord, newTenant, revoke, list, roomA } = await setup();
      const studio = await list(landlord, STUDIO, 1000n, THREE_X);
      const tenant = await newTenant(9000n);
      await as(tenant).call('apply', roomA, T);
      await revoke(0n);
      expect(sim.ledger().applications.member(applicationIdFor(roomA, tenant.secretKey))).toBe(true);
      await expectRejects(() => as(tenant).call('apply', studio, T), 'No issuer attestation');
    });

    it('lets other tenants and later attestations apply after a revoke', async () => {
      const { sim, as, landlord, attestTenant, newTenant, revoke, list, roomA } = await setup();
      const studio = await list(landlord, STUDIO, 1000n, THREE_X);
      const revokedTenant = await newTenant(9000n);
      const other = await newTenant(9000n);
      await revoke(0n);
      await as(other).call('apply', roomA, T);
      const later = await attestTenant(9000n);
      // Revoked slots are not reused: the new leaf goes to index 2, not 0.
      expect(leafIndexFromPath(sim.ledger().attestations.findPathForLeaf(later.leaf)!)).toBe(2n);
      expect(sim.ledger().attestationCount).toBe(3n);
      await as(later.tenant).call('apply', studio, T);
      // The tenant attested before the revoke still applies after the later attest.
      await as(other).call('apply', studio, T);
      expect(sim.ledger().applications.size()).toBe(3n);
      await expectRejects(() => as(revokedTenant).call('apply', studio, T), 'No issuer attestation');
    });

    it('rejects a proof built against a root from before the revocation (reordering), for every tenant', async () => {
      // A client that read its path before the issuer revoked someone, and
      // sends the apply after: the old root is no longer accepted, even when the
      // revoked attestation is someone else's. Each must build its proof again.
      let stalePath: ReturnType<Ledger['attestations']['findPathForLeaf']>;
      const staleWitnesses: typeof witnesses = {
        ...witnesses,
        attestationPath: (ctx, leaf) => (stalePath ? [ctx.privateState, stalePath] : witnesses.attestationPath(ctx, leaf)),
      };
      const issuer = createTenantProofPrivateState(randomBytes32());
      const landlord = createTenantProofPrivateState(randomBytes32());
      const sim = await deployAt(staleWitnesses, issuer);
      sim.privateState = landlord;
      await sim.call('createListing', listingLabelBytes(ROOM_A), RENT, THREE_X);
      const roomA = listingIdFor(ROOM_A, landlord.secretKey);

      const attest = async () => {
        const sk = randomBytes32();
        const att = issueAttestation(9000n, tenantPublicKey(sk), EXPIRES);
        sim.privateState = issuer;
        await sim.call('attest', att.leaf);
        return { leaf: att.leaf, ps: createTenantProofPrivateState(sk, att.income, att.salt, att.expiresAt) };
      };
      const a = await attest(); // index 0, will be revoked
      const b = await attest(); // index 1, stays valid

      for (const who of [a, b]) {
        stalePath = sim.ledger().attestations.findPathForLeaf(who.leaf);
        expect(stalePath).toBeDefined();
      }
      const pathA = sim.ledger().attestations.findPathForLeaf(a.leaf)!;
      const pathB = sim.ledger().attestations.findPathForLeaf(b.leaf)!;
      sim.privateState = issuer;
      await sim.call('revoke', 0n);

      for (const [who, path] of [[a, pathA], [b, pathB]] as const) {
        stalePath = path;
        sim.privateState = who.ps;
        await expectRejects(() => sim.call('apply', roomA, T), 'No issuer attestation');
      }
      // With a path read after the revocation, b goes through and a still does not.
      stalePath = undefined;
      sim.privateState = b.ps;
      await sim.call('apply', roomA, T);
      sim.privateState = a.ps;
      await expectRejects(() => sim.call('apply', roomA, T), 'No issuer attestation');
      expect(sim.ledger().applications.size()).toBe(1n);
    });

    it('names attestations by insertion order: leafIndexFromPath matches the index revoke takes', async () => {
      const { sim, attestTenant } = await setup();
      const leaves: Uint8Array[] = [];
      for (let i = 0; i < 6; i++) leaves.push((await attestTenant(9000n)).leaf);
      leaves.forEach((leaf, i) => {
        expect(leafIndexFromPath(sim.ledger().attestations.findPathForLeaf(leaf)!)).toBe(BigInt(i));
      });
    });
  });

  // One entry per "Never on the ledger" line of the README table.
  it('keeps secrets out of public state', async () => {
    const { sim, as, issuerSk, landlordSk, newTenant, revoke, roomA } = await setup();
    // A distinctive expiry, so its bytes are not a common pattern.
    const expiresAt = EXPIRES + 12_345n;
    const tenant = await newTenant(7777n, expiresAt);
    await as(tenant).call('apply', roomA, T);
    await newTenant(5000n);
    await revoke(1n);
    const l = sim.ledger();
    expect(Object.keys(l).sort()).toEqual(['applications', 'attestationCount', 'attestations', 'issuerPk', 'listings', 'revoked']);
    // revoked holds only indices (numbers), never a leaf or a key.
    expect([...l.revoked]).toEqual([1n]);
    const expiryBytes = new Uint8Array(8);
    new DataView(expiryBytes.buffer).setBigUint64(0, expiresAt, true);
    // Sanity: the walker does see the public data we expect to be there.
    expect(l.applications.member(applicationIdFor(roomA, tenant.secretKey))).toBe(true);
    const incomeBytes = new Uint8Array(32);
    new DataView(incomeBytes.buffer).setUint32(0, 7777, true);
    assertNotInPublicState(l, {
      tenantSecretKey: tenant.secretKey,
      tenantPublicKey: tenantPublicKey(tenant.secretKey),
      incomeSalt: tenant.incomeSalt!,
      incomeAsBytes: incomeBytes.slice(0, 4),
      expiresAtAsBytes: expiryBytes.slice(0, 5),
      issuerSecretKey: issuerSk,
      landlordSecretKey: landlordSk,
      landlordPublicKey: tenantPublicKey(landlordSk),
    });
  });
});
