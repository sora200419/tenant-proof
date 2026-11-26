// This file is part of example-tenant-proof.
// Copyright (C) Midnight Foundation
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0 (the "License");
// You may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// The landlord types the multiplier. Only `d` or `d.d` (a dot, one decimal) is
// read; anything that would need a guess about separators is refused.

import { describe, expect, it } from 'vitest';
import { formatMultiplier, parseMultiplierTenths, requiredIncome } from '../attest.js';

const FORMAT = 'Multiplier must be a number like 3 or 2.5 (a dot, at most one decimal)';

describe('parseMultiplierTenths', () => {
  it.each([
    ['3', 30n],
    ['2.5', 25n],
    ['10', 100n],
    ['10.0', 100n],
    ['1.0', 10n],
    [' 2.5 ', 25n],
    ['2.5x', 25n],
    ['2.5X', 25n],
    ['3×', 30n],
    ['0', 0n],
    ['25.5', 255n],
  ])('reads %j as %s tenths', (raw, tenths) => {
    expect(parseMultiplierTenths(raw)).toBe(tenths);
  });

  it.each([
    ['2,5', 'a decimal comma is not guessed'],
    ['1,000', 'a thousands separator is not guessed'],
    ['1.000', 'more than one decimal is refused, so a European thousands dot is never read as 1.0'],
    ['2.55', 'two decimals'],
    ['abc', 'not a number'],
    ['', 'empty'],
    ['.5', 'no integer part'],
    ['2.', 'a dot with no digit'],
    ['-2', 'negative'],
    ['+2', 'a sign'],
    ['1e1', 'exponent'],
    ['2 .5', 'inner space'],
    ['2.5xx', 'two suffixes'],
    ['1000', 'four integer digits'],
  ])('refuses %j (%s)', (raw) => {
    expect(() => parseMultiplierTenths(raw)).toThrow(FORMAT);
  });

  // The 1.0x-10.0x range is the contract's to enforce ('0', '15' and '25.5'
  // parse, and the circuit rejects them; see "rejects a multiplier of %s
  // tenths (outside 1.0x-10.0x)" in tenant-proof.sim.test.ts). Only values that cannot fit
  // Uint<8> stop here, with the contract's own wording.
  it.each(['25.6', '26', '99.9'])('refuses %j, which does not fit Uint<8> tenths', (raw) => {
    expect(() => parseMultiplierTenths(raw)).toThrow('Multiplier must be between 1.0x and 10.0x');
  });
});

describe('formatMultiplier and requiredIncome', () => {
  it('formats tenths with one decimal', () => {
    expect(formatMultiplier(30n)).toBe('3.0×');
    expect(formatMultiplier(25n)).toBe('2.5×');
    expect(formatMultiplier(100n)).toBe('10.0×');
  });

  it('rounds the required income up, matching income * 10 >= m * rent', () => {
    expect(requiredIncome(1500n, 25n)).toBe(3750n);
    expect(requiredIncome(1001n, 33n)).toBe(3304n);
    expect(requiredIncome(1000n, 70n)).toBe(7000n);
  });
});
