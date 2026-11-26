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

/**
 * Runs async work one at a time per key. Work for different keys runs in
 * parallel. A failed run does not block the next one; its error goes to its
 * own caller.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

/** The part of a private-state store that `getOrCreate` needs. */
export type StateStore<S> = {
  get(id: string): Promise<S | null>;
  set(id: string, state: S): Promise<void>;
};

/**
 * Returns the state stored under `id`, or stores and returns `create()` when
 * there is none. Not safe on its own when two calls overlap: both can read
 * nothing and both write a new state. Callers run it under a `KeyedLock`.
 */
export async function getOrCreate<S>(store: StateStore<S>, id: string, create: () => S): Promise<S> {
  const existing = await store.get(id);
  if (existing) return existing;
  const fresh = create();
  await store.set(id, fresh);
  return fresh;
}
