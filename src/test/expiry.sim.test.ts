// This file is part of TenantProof.
// SPDX-License-Identifier: Apache-2.0
//
// The off-chain time helpers in src/attest.ts. Fixed times only, never the
// real date.

import { describe, expect, it } from 'vitest';
import { checkTimeFor, expiresAtFromDays, parseExpiresAt, parseValidDays, SECONDS_PER_DAY, SECONDS_PER_HOUR } from '../attest.js';

describe('parseExpiresAt', () => {
  it.each([
    ['1767225600', 1_767_225_600n],
    [' 0 ', 0n],
    ['18446744073709551615', 0xffffffffffffffffn],
  ])('accepts %s', (raw, v) => expect(parseExpiresAt(raw)).toBe(v));

  it.each(['1,767,225,600', '1.767.225.600', '1767225600.5', '-1', '', '2026-01-01', '0x10'])('refuses %s instead of guessing', (raw) => {
    expect(() => parseExpiresAt(raw)).toThrow('digits only');
  });

  it('refuses a value above Uint<64>', () => {
    expect(() => parseExpiresAt('18446744073709551616')).toThrow('too large');
  });
});

describe('parseValidDays', () => {
  it.each([['1', 1n], ['90', 90n], ['3650', 3650n]])('accepts %s', (raw, v) => expect(parseValidDays(raw)).toBe(v));
  it.each(['0', '3651'])('refuses %s (out of range)', (raw) => expect(() => parseValidDays(raw)).toThrow('between 1 and 3650'));
  it.each(['1,000', '1.5', '-3', '', 'ninety'])('refuses %s (not whole days)', (raw) => expect(() => parseValidDays(raw)).toThrow('whole number of days'));
});

const HOUR = SECONDS_PER_HOUR;
// 2026-01-01T00:00:00Z, a whole hour.
const ON_THE_HOUR = 1_767_225_600n;

describe('checkTimeFor', () => {
  it.each([
    ['exactly on the hour', ON_THE_HOUR, ON_THE_HOUR + 2n * HOUR],
    ['one second after the hour', ON_THE_HOUR + 1n, ON_THE_HOUR + 2n * HOUR],
    // Next hour is ON_THE_HOUR + 1 h; plus one: + 2 h, which is 3601 s ahead.
    ['one second before the next hour', ON_THE_HOUR + HOUR - 1n, ON_THE_HOUR + 2n * HOUR],
  ])('%s: rounds up to the next whole hour plus one', (_name, now, expected) => {
    expect(checkTimeFor(now)).toBe(expected);
  });

  it('is always a whole hour, more than one hour (the transaction TTL) and at most two hours ahead', () => {
    for (let s = 0n; s < 2n * HOUR; s += 97n) {
      const now = ON_THE_HOUR + s;
      const t = checkTimeFor(now);
      expect(t % HOUR).toBe(0n);
      expect(t - now > HOUR).toBe(true);
      expect(t - now <= 2n * HOUR).toBe(true);
    }
  });
});

describe('expiresAtFromDays', () => {
  it('adds whole days', () => {
    expect(expiresAtFromDays(ON_THE_HOUR, 90n)).toBe(ON_THE_HOUR + 90n * SECONDS_PER_DAY);
    expect(expiresAtFromDays(ON_THE_HOUR, 1n)).toBe(ON_THE_HOUR + SECONDS_PER_DAY);
  });

  it.each([0n, -1n])('refuses %s days', (days) => {
    expect(() => expiresAtFromDays(ON_THE_HOUR, days)).toThrow('Validity must be at least 1 day');
  });
});
