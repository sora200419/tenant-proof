// This file is part of TenantProof.
// SPDX-License-Identifier: Apache-2.0
//
// The demo client (frontend/src/lib/client.ts) against the compiled contract,
// in memory: what the UI reads back from the ledger must be enough to close a
// listing, whatever label the landlord typed.

import { describe, expect, it } from 'vitest';
import { TenantProofDemo, fromHex, newSecretKeyHex, ownedListingIdHexes } from '../../frontend/src/lib/client';

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
