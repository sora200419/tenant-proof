// This file is part of TenantProof.
// SPDX-License-Identifier: Apache-2.0
//
// The demo client (frontend/src/lib/client.ts) against the compiled contract,
// in memory: what the UI reads back from the ledger must be enough to close a
// listing, whatever label the landlord typed.

import { describe, expect, it } from 'vitest';
import {
  TenantProofDemo,
  attestationLeafHex,
  findAttestationIndex,
  formatUtc,
  fromHex,
  newSecretKeyHex,
  ownedListingIdHexes,
  parseCredentialBundle,
  publicKeyHex,
} from '../../frontend/src/lib/client';
import { SECONDS_PER_DAY, expiresAtFromDays } from '../attest';

const UINT64_MAX = 0xffffffffffffffffn;

describe('formatUtc', () => {
  it('shows a calendar date for a normal expiry', () => {
    expect(formatUtc(1_767_225_600n)).toBe('2026-01-01 00:00 UTC');
  });
  it.each([UINT64_MAX, 8_640_000_000_001n])('shows %s as raw seconds instead of throwing (beyond the Date range)', (s) => {
    expect(formatUtc(s)).toBe(`${s} s after 1970 (beyond the calendar range)`);
  });
});

describe('parseCredentialBundle', () => {
  const sk = newSecretKeyHex();
  const pk = publicKeyHex(sk);
  const salt = newSecretKeyHex();
  const bundle = (over: Record<string, string> = {}, expiresAt = 1_774_972_800n) =>
    JSON.stringify({
      tenantPublicKey: pk,
      income: '6000',
      expiresAt: expiresAt.toString(),
      salt,
      leaf: attestationLeafHex(6000n, pk, expiresAt, salt),
      ...over,
    });

  it('accepts a credential that matches its commitment', () => {
    expect(parseCredentialBundle(bundle(), pk, 'Alice')).toEqual({
      income: 6000n,
      expiresAt: 1_774_972_800n,
      saltHex: salt,
      leafHex: attestationLeafHex(6000n, pk, 1_774_972_800n, salt),
    });
  });

  it('accepts the largest Uint<64> expiry, and formatting it does not throw', () => {
    const c = parseCredentialBundle(bundle({}, UINT64_MAX), pk, 'Alice');
    expect(c.expiresAt).toBe(UINT64_MAX);
    expect(() => formatUtc(c.expiresAt)).not.toThrow();
  });

  it('refuses a credential whose expiry was changed (it no longer matches the commitment)', () => {
    const changed = JSON.parse(bundle()) as Record<string, string>;
    changed.expiresAt = '1900000000';
    expect(() => parseCredentialBundle(JSON.stringify(changed), pk, 'Alice')).toThrow('do not match the commitment');
  });

  it('refuses a credential with no expiry, one for another key, and one with a separator in the expiry', () => {
    const noExpiry = JSON.parse(bundle()) as Record<string, string>;
    delete noExpiry.expiresAt;
    expect(() => parseCredentialBundle(JSON.stringify(noExpiry), pk, 'Alice')).toThrow('expiresAt');
    expect(() => parseCredentialBundle(bundle(), publicKeyHex(newSecretKeyHex()), 'Bob')).toThrow('another public key, not Bob');
    expect(() => parseCredentialBundle(bundle({ expiresAt: '1,774,972,800' }), pk, 'Alice')).toThrow('digits only');
  });

  it('refuses text that is not JSON', () => {
    expect(() => parseCredentialBundle('not json', pk, 'Alice')).toThrow('not valid JSON');
  });
});

describe('findAttestationIndex (stale indexer reads)', () => {
  const noSleep = async () => undefined;

  it('keeps reading while the indexer answers stale, and returns the index once it appears', async () => {
    const answers = [undefined, undefined, 3n];
    let reads = 0;
    const index = await findAttestationIndex(async () => answers[reads++], { attempts: 4, sleep: noSleep });
    expect(index).toBe(3n);
    expect(reads).toBe(3);
  });

  it('reports not found only after every attempt, waiting between reads', async () => {
    let reads = 0;
    const waits: number[] = [];
    const index = await findAttestationIndex(
      async () => {
        reads++;
        return undefined;
      },
      { attempts: 4, delayMs: 2000, sleep: async (ms) => void waits.push(ms) },
    );
    expect(index).toBeUndefined();
    expect(reads).toBe(4);
    expect(waits).toEqual([2000, 2000, 2000]);
  });

  it('returns at once when the first read finds it', async () => {
    let reads = 0;
    expect(await findAttestationIndex(async () => (reads++, 0n), { sleep: noSleep })).toBe(0n);
    expect(reads).toBe(1);
  });
});

// Fixed demo clock (2026-01-01T00:00:00Z), never the real date.
const NOW = 1_767_225_600n;

describe('demo client: expiry and revocation', () => {
  const setup = async () => {
    const issuerSk = newSecretKeyHex();
    const landlordSk = newSecretKeyHex();
    const demo = await TenantProofDemo.deploy(issuerSk, () => NOW);
    const { listingIdHex } = await demo.createListing({ landlordSecretKeyHex: landlordSk, label: 'room-a', rent: 1000n, multiplierTenths: 30n });
    const tenant = async () => {
      const sk = newSecretKeyHex();
      const att = await demo.attest({
        callerSecretKeyHex: issuerSk,
        tenantPublicKeyHex: publicKeyHex(sk),
        income: 9000n,
        expiresAt: expiresAtFromDays(demo.nowSeconds(), 30n),
      });
      return { sk, ...att };
    };
    const apply = (t: Awaited<ReturnType<typeof tenant>>, id = listingIdHex) =>
      demo.apply({ tenantSecretKeyHex: t.sk, income: 9000n, saltHex: t.saltHex, expiresAt: t.expiresAt, listingIdHex: id });
    return { demo, issuerSk, landlordSk, tenant, apply, listingIdHex };
  };

  it('accepts before expiry and rejects after the demo clock passes it; the earlier application stays', async () => {
    const { demo, landlordSk, tenant, apply } = await setup();
    const t = await tenant();
    const first = await apply(t);
    const { listingIdHex: second } = await demo.createListing({ landlordSecretKeyHex: landlordSk, label: 'room-b', rent: 1000n, multiplierTenths: 30n });
    demo.advanceClock(30n * SECONDS_PER_DAY);
    await expect(apply(t, second)).rejects.toThrow('Attestation has expired');
    expect(demo.snapshot().applications.map((a) => a.applicationIdHex)).toEqual([first.applicationIdHex]);
  });

  it('revokes by the index found for the commitment; the tenant can no longer apply and the index is shown', async () => {
    const { demo, issuerSk, tenant, apply } = await setup();
    await tenant();
    const t = await tenant();
    const index = demo.attestationIndex(t.leafHex);
    expect(index).toBe(1n);
    await demo.revoke({ callerSecretKeyHex: issuerSk, index: index! });
    expect(demo.snapshot().revoked).toEqual(['1']);
    expect(demo.attestationIndex(t.leafHex)).toBeUndefined();
    await expect(apply(t)).rejects.toThrow('No issuer attestation');
  });

  it('refuses to move the demo clock backwards', async () => {
    const { demo } = await setup();
    expect(() => demo.advanceClock(0n)).toThrow('only moves forward');
    expect(demo.nowSeconds()).toBe(NOW);
  });
});

describe('demo client: listing labels round-trip to closing', () => {
  it.each(['bukit-jalil-room-a', 'Café room', 'Bilik – A', '房间A'])('the landlord can close a listing labelled %s', async (label) => {
    const demo = await TenantProofDemo.deploy(newSecretKeyHex());
    const landlordSk = newSecretKeyHex();
    const { listingIdHex } = await demo.createListing({ landlordSecretKeyHex: landlordSk, label, rent: 1000n, multiplierTenths: 30n });
    const listing = demo.snapshot().listings.find((l) => l.idHex === listingIdHex)!;
    expect(listing.open).toBe(true);
    expect(listing.label).toBe(label);
    // The landlord's tab finds it as its own; another key does not.
    expect(ownedListingIdHexes(demo.snapshot().listings, fromHex(landlordSk, 32)).has(listingIdHex)).toBe(true);
    expect(ownedListingIdHexes(demo.snapshot().listings, fromHex(newSecretKeyHex(), 32)).size).toBe(0);
    await demo.closeListing({ callerSecretKeyHex: landlordSk, labelHex: listing.labelHex });
    expect(demo.snapshot().listings.find((l) => l.idHex === listingIdHex)!.open).toBe(false);
  });
});
