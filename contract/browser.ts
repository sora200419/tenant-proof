// This file is part of TenantProof.
// SPDX-License-Identifier: Apache-2.0
//
// The compiled contract with its witnesses, without anything Node-only, so the
// UI can deploy and call it. contract/index.ts builds the Node export from
// `tenantProofContractWithWitnesses` too.
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-js';
import { Contract } from './managed/tenant-proof/contract/index.js';
import { witnesses } from './witnesses.js';

export const tenantProofContractWithWitnesses = CompiledContract.make('TenantProofContract', Contract).pipe(
  CompiledContract.withWitnesses(witnesses),
);

/**
 * For the browser. Midnight.js 5.0.0 never reads the compiled-assets path
 * (compact-js defines `getCompiledAssetsPath`, and nothing in midnight-js
 * calls it; keys and ZKIR come from the ZKConfigProvider), so a placeholder is
 * given, as midnight-js-protocol's own engine does with '.'.
 */
// Data-first call: the value `pipe` returns is not itself pipeable at runtime.
export const BrowserTenantProofContract = CompiledContract.withCompiledFileAssets(tenantProofContractWithWitnesses, '.');
