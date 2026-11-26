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

import { useState } from 'react';

type CopyState = { kind: 'idle' } | { kind: 'copied'; text: string } | { kind: 'failed'; text: string; reason: string };

/**
 * Copies `text` and says whether it worked. The issuer's credential exists
 * only in the page, so a refused clipboard write must never look like success.
 * The result is tied to the text it was for: when a new credential replaces
 * the old one, an earlier "Copied." is not shown next to it.
 */
export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<CopyState>({ kind: 'idle' });

  const copy = async () => {
    if (!navigator.clipboard) {
      setState({ kind: 'failed', text, reason: 'this page has no clipboard access' });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setState({ kind: 'copied', text });
    } catch (e) {
      const reason = e instanceof Error ? e.message.split('\n')[0]! : String(e);
      setState({ kind: 'failed', text, reason });
    }
  };

  const current = state.kind !== 'idle' && state.text === text ? state : null;

  return (
    <>
      <button className="btn small ghost" onClick={() => void copy()}>
        Copy
      </button>
      {current?.kind === 'copied' && (
        <span className="hint" role="status">
          Copied.
        </span>
      )}
      {current?.kind === 'failed' && (
        <span className="precheck precheck-warn" role="alert">
          Not copied ({current.reason}). Select the text below and copy it by hand before leaving this page.
        </span>
      )}
    </>
  );
}
