# Security: TenantProof

<!-- Any change to a privacy claim here must be made in README, UI text (frontend/src/App.tsx),
     contract comments and the demo script in the same change. -->

## Assets to protect
- Tenant secret key (ties a tenant to their attestation and application ids).
- Tenant income and attestation salt (the credential).
- Issuer secret (`.tenant-proof/issuer.json`): whoever holds it can attest any income.
- Wallet mnemonic and private-state password (`.env.preview` / `.env.preprod`).
- Blockfrost project id (`.env.preprod`).

## Roles and permissions
| Role | Can read | Can change | Cannot |
| --- | --- | --- | --- |
| Anyone / chain observer | The whole public ledger | Create a listing (no owner check yet) | Attest; apply without a valid credential |
| Issuer | Ledger; every income it attested and each tenant's public key | Add attestations | Remove or revoke an attestation (not supported); apply for a tenant without that tenant's secret key |
| Landlord | Ledger: its listings, their rents, application ids per listing | Create listings | Close or edit a listing; learn an applicant's income or key from the ledger |
| Tenant | Ledger; its own private state | Apply once per listing | Apply above its attested income; apply twice to one listing |

## Threats
| Threat | Where | Defence | Test |
| --- | --- | --- | --- |
| Tenant claims more income than attested | `apply` | Leaf recomputed in circuit + Merkle root check | "rejects a tenant who claims a higher income than attested" |
| Tenant reuses another tenant's Merkle path | `apply` witness | `path.leaf == leaf` check and root check in circuit | Two "tampered witness" tests |
| Someone other than the issuer attests | `attest` | `publicKey(secretKey()) == issuerPk` | "rejects anyone else" |
| Double application | `apply` | Application id is deterministic per (tenant, listing) | "rejects applying twice to the same listing" |
| Credential lending (tenant gives key, income and salt to someone else) | off-chain | **None yet** | — |
| Listing id squatting (taking a landlord's id first) | `createListing` | **None yet**; planned: listings owned by the landlord's key | — |
| Issuer attests a false income | off-chain | **None**: the issuer is trusted | — |
| Stale credential (income changed, job lost) | `attest` | **None yet**; planned: expiry and revocation | — |
| Secrets in logs | deploy / tests | The Blockfrost id travels in URL query strings. The only URL our code logs itself is the keyless faucet page (`src/wallet.ts`, funding prompt). The wallet log no longer prints part of the master seed (removed 2026-11-20); testkit's own logger is limited to warnings. **Gaps:** (1) raw SDK errors are logged unsanitised (`Wallet sync error` in `src/wallet.ts`, `deploy failed` and `wait-for-dust failed` with the stack in `scripts/deploy.ts` and `scripts/wait-for-dust.ts`) and may carry request URLs; a sanitiser is planned for the next slice. (2) The Polkadot RPC client (`RPC-CORE`) logs the node's WebSocket URL when it disconnects; the 2026-11-20 Preview run printed it 6 times. On Preprod both would expose the Blockfrost id. Not yet run on Preprod | Manual scan of the 2026-11-20 Preview run log: no mnemonic, seed, salt, income or `project_id`; only the keyless Preview node URL |
| All roles' keys in one browser tab | demo UI | Demo only; product gives each role its own device and wallet | — |
| Malicious frontend build | GitHub Pages | TODO: the page runs the circuits and handles keys, so a tampered bundle could exfiltrate them | — |

## Privacy claims, per party
Mirrors README "What is public and what is not" and "Limits of this version". Never write a bare "anonymous" or "unlinkable".

| Party | Already knows | Can infer from public data | Our claim |
| --- | --- | --- | --- |
| Issuer | Every attested tenant's income and public key | From an application to a listing: the applicant earns ≥ 3× that rent. If few attested tenants clear that bar, it can narrow down or identify the applicant, and link that person's applications the same way | Nothing beyond what it already holds is put on the ledger; it can still narrow down applicants when few qualify |
| Landlord | Its listings and rents | Each application id on its listing belongs to someone whose attested income is ≥ 3× the rent (a lower bound, not the income) | The landlord learns eligibility, not the income or the key. It cannot yet tell which person an id belongs to |
| Chain observer | Nothing private | Same as the landlord, for every listing. Two applications to different listings are unrelated hashes on the ledger | The ledger does not show that two applications come from the same tenant, or which attestation was used |
| Proof server | Runs on the user's own machine (`127.0.0.1:6300`) | Receives the private inputs needed to build the proof | Only safe when the user runs it themselves; a remote proof server would see income and salt. TODO for the product |
| Frontend host (GitHub Pages) | Visitor IP and requests | Nothing from the ledger; the page holds keys in memory | TODO: product must not hold other roles' keys; see "Malicious frontend build" |

## External services
| Service / SDK | Version | Network | Timeout | Rate limit | On failure |
| --- | --- | --- | --- | --- | --- |
| Midnight indexer + node (Preview) | indexer API v4 | preview (testnet) | `scripts/deploy.ts`: 30 s for the stale-deployment query; wallet sync bounded by `MIDNIGHT_SYNC_TIMEOUT_MS`; other SDK calls TODO (next slice) | TODO | Observed: HTTP 503 from the indexer on 2026-11-15 (that run stopped after `createListing`). On 2026-11-20, 6 reads about 2 minutes apart (06:17:59–06:28:07 UTC) all returned HTTP 200 from both indexer and node, with the tip advancing about 20 blocks per interval (189931 to 190032), and the full flow test passed. No retry or backoff yet: one 503 fails the run. TODO (next slice): retry reads with backoff |
| Blockfrost (Preprod) | api v0 | preprod (testnet) | TODO | TODO (project id quota) | TODO |
| Local network (`compose.yml`) | — | undeployed | `scripts/deploy.ts`: 5 s reachability check on node and indexer | — | Deploy stops before sending anything |
| Proof server | `midnightntwrk/proof-server:9.0.0` | local Docker | `scripts/deploy.ts`: 5 s reachability check; proving calls TODO (next slice: retry connection errors only, never its own timeout, so proving jobs do not stack) | — | Deploy stops before sending anything. At start-up the container downloads proving parameters from `srs.midnight.network` and exits if TLS fails (seen 2026-11-20 behind an HTTPS-scanning antivirus; fixed by giving it a CA bundle via `SSL_CERT_FILE`) |
| midnight-js SDK / wallet-sdk | 5.0.0 / 2.0.0 | — | Wallet sync: `Rx.timeout` in `syncWallet`. Indexer reads, proving and submit: none of our own yet (next slice) | — | Errors propagate unchanged; submit is never retried (unknown outcome) |
| tNIGHT faucet | — | preview / preprod | — | — | Manual top-up; tests assume a funded wallet |
| GitHub Pages | actions/deploy-pages@v4 | — | — | — | Re-run the workflow |

Transaction fees: paid in DUST generated from tNIGHT held by the wallet (`scripts/wait-for-dust.ts`). No other money moves through the product.

## Deployments
| Network | Address | What it is | Issuer key |
| --- | --- | --- | --- |
| preview | `a92bebe0a8e3c54e142a583da8caaa77dab1ec401a40c1d545efba98a6c4ece6` | Verification-only test deploy (2026-11-20, blocks 190065–190081); list, apply and low-income rejection verified | Random, not saved: cannot attest again |
| preview | `e6123a996294cbdf608d8909af52d2a8e5b1bbd636e6fb49e1f93db79a0c96bb` | Partial deploy from 2026-11-15: deploy and `createListing` (block 122818) only | Random, not saved |

Every run of the network test deploys a new contract with a random issuer key that is never saved. A deployment meant for use is made with `npm run deploy`, which keeps the issuer secret in `.tenant-proof/issuer.json`; none exists yet.
