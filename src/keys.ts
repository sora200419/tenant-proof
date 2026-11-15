// This file is part of TenantProof.
// SPDX-License-Identifier: Apache-2.0
//
// The issuer's contract secret, which the deploy (contract/deploy-args.ts)
// needs: the deployer becomes the issuer, and the same secret must sign every
// later `attest`. Stored with mode 0600 in .tenant-proof/ at the repo root
// (gitignored), or TENANTPROOF_KEYS_DIR. Node only: never import from the UI.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toHex, fromHex } from '@midnight-ntwrk/midnight-js-utils';

export const keysDir = (): string =>
  process.env['TENANTPROOF_KEYS_DIR'] ?? fileURLToPath(new URL('../.tenant-proof/', import.meta.url));

const issuerFile = () => path.join(keysDir(), 'issuer.json');

/** Reads the issuer secret, creating it on first use. */
export function readOrCreateIssuerSecret(): Uint8Array {
  const f = issuerFile();
  if (fs.existsSync(f)) {
    const json = JSON.parse(fs.readFileSync(f, 'utf8')) as { secretKey?: string };
    if (typeof json.secretKey !== 'string' || json.secretKey.length !== 64) {
      throw new Error(`${f} is malformed: expected {"secretKey": "<64 hex chars>"}`);
    }
    return fromHex(json.secretKey);
  }
  const secretKey = crypto.getRandomValues(new Uint8Array(32));
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, `${JSON.stringify({ secretKey: toHex(secretKey) }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return secretKey;
}
