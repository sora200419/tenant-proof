// This file is part of TenantProof.
// SPDX-License-Identifier: Apache-2.0
//
// The Node and browser exports of the compiled contract build at import time
// (a non-pipeable `pipe` result once broke both, and only the network test or
// the page would have shown it).
import { describe, expect, it } from 'vitest';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-js';
import { CompiledTenantProofContract, zkConfigPath } from '../../contract/index.js';
import { BrowserTenantProofContract } from '../../contract/browser.js';

describe('compiled contract exports', () => {
  it('the Node export carries the compiled-assets path', () => {
    expect(CompiledContract.getCompiledAssetsPath(CompiledTenantProofContract)).toBe(zkConfigPath);
  });

  it('the browser export builds with the placeholder path', () => {
    expect(CompiledContract.getCompiledAssetsPath(BrowserTenantProofContract)).toBe('.');
  });
});
