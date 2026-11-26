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

// The wallet-mode private-state store is read, then written. These tests use a
// store whose reads and writes yield to the event loop, like the real level
// store, to show the race and that KeyedLock removes it.

import { describe, expect, it } from 'vitest';
import { KeyedLock, getOrCreate, type StateStore } from '../../frontend/src/lib/keyed-lock';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function slowStore(): StateStore<string> & { writes: string[] } {
  const data = new Map<string, string>();
  const writes: string[] = [];
  return {
    writes,
    async get(id) {
      await tick();
      return data.get(id) ?? null;
    },
    async set(id, state) {
      await tick();
      writes.push(state);
      data.set(id, state);
    },
  };
}

function counter() {
  let n = 0;
  return () => `key-${++n}`;
}

describe('getOrCreate and KeyedLock', () => {
  it('without the lock, two overlapping calls each store a different new state', async () => {
    const store = slowStore();
    const create = counter();
    const [a, b] = await Promise.all([getOrCreate(store, 'landlord', create), getOrCreate(store, 'landlord', create)]);
    expect(a).not.toBe(b);
    expect(store.writes).toHaveLength(2);
  });

  it('under the lock, overlapping calls for one id create and store one state', async () => {
    const store = slowStore();
    const create = counter();
    const lock = new KeyedLock();
    const run = () => lock.run('contract/landlord', () => getOrCreate(store, 'landlord', create));
    const results = await Promise.all([run(), run(), run()]);
    expect(new Set(results).size).toBe(1);
    expect(store.writes).toEqual(['key-1']);
    expect(await store.get('landlord')).toBe('key-1');
  });

  it('runs work for one key in call order', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const step = (name: string) =>
      lock.run('k', async () => {
        order.push(`${name}:start`);
        await tick();
        order.push(`${name}:end`);
      });
    await Promise.all([step('a'), step('b')]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('does not make different keys wait for each other', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = lock.run('one', async () => {
      order.push('one:start');
      await held;
      order.push('one:end');
    });
    await lock.run('two', async () => {
      order.push('two:done');
    });
    release();
    await first;
    expect(order).toEqual(['one:start', 'two:done', 'one:end']);
  });

  it('passes a failure to its own caller and still runs the next call', async () => {
    const lock = new KeyedLock();
    const failing = lock.run('k', async () => {
      throw new Error('store refused');
    });
    const next = lock.run('k', async () => 'ok');
    await expect(failing).rejects.toThrow('store refused');
    await expect(next).resolves.toBe('ok');
  });
});
