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

// What `mnkit deploy` deploys: each contract's constructor arguments and
// initial private state. This file is yours. `mnkit derive` fills the
// @generated-stub regions from the compiled contract until you edit them.
//
// `ctx.deployments` holds the contracts already deployed on the network, so a
// constructor that takes another contract's address (or its token color) can
// read it there. Deploy that contract first: `mnkit deploy <name>`.

import { deployable, type Deployable, type DeployContext } from '../src/deployments.js';
import {
  CompiledTenantProofContract,
  type Contract,
  zkConfigPath,
  // @generated-stub begin deploy-imports sha=e3b0c44298fc
  // @generated-stub end deploy-imports
} from './index.js';
import { createTenantProofPrivateState } from './witnesses.js';
import { readOrCreateIssuerSecret } from '../src/keys.js';

// The deployer is the issuer: the constructor stores publicKey(secretKey) as
// issuerPk. The secret comes from .tenant-proof/issuer.json (created on first
// deploy), read lazily so importing this file never touches the disk.

export const deployables: Record<string, Deployable<any>> = {
  'tenant-proof': deployable<Contract>({
    compiledContract: CompiledTenantProofContract,
    zkConfigPath,
    privateStateId: 'TenantProofState',
    // @generated-stub begin private-state sha=edited
    get initialPrivateState() {
      return createTenantProofPrivateState(readOrCreateIssuerSecret());
    },
    // @generated-stub end private-state
    args: (ctx: DeployContext) => [
      // @generated-stub begin constructor-args sha=e3b0c44298fc
      // @generated-stub end constructor-args
    ],
  }),
  // @generated-stub begin secondary-deploys sha=e3b0c44298fc
  // @generated-stub end secondary-deploys
};
