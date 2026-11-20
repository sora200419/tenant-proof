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
| Secrets in logs | deploy / tests | The Blockfrost id travels in URL query strings. The only URL our code logs itself is the keyless faucet page (`src/wallet.ts`, funding prompt). The wallet log no longer prints part of the master seed (removed 2026-11-20); testkit's own logger is limited to warnings. SDK errors we log (`Wallet sync error` in `src/wallet.ts`, `deploy failed` in `scripts/deploy.ts`, `wait-for-dust failed` in `scripts/wait-for-dust.ts`, retry warnings) go through `sanitizeError` in `src/retry.ts`: label, error name and first line of up to three causes, with URLs replaced by `<url>`, `project_id` values and Blockfrost-style keys removed, no stack and no `cause`. The deploy script, the wait-for-dust script and the network test call `installConsoleRedaction()` at start, so third-party loggers that write through the console (the Polkadot RPC client logs the node URL on disconnect) are redacted the same way. **Gaps:** stacks are dropped from these logs (less to debug with). A logger that writes to stdout directly rather than through the console is not covered, and neither is Vitest's reporter, which prints a failing test's error (stack, `cause`, own properties) itself. Errors that are passed on unchanged by design (a 4xx, a circuit assert, unknown errors, and `syncWallet`'s rethrow) reach that reporter unredacted. Nothing automated checks that no logger call prints seed material. Not yet run on Preprod | `src/test/retry.sim.test.ts` (URL, `project_id` in query, JSON and header form, Blockfrost key, cause chain, console redaction of a Polkadot-shaped disconnect line); each guard shown to fail its test when removed. Scan of the 2026-11-20 11:57 UTC Preview run log (with redaction): no URL, `project_id`, seed, salt or mnemonic; the 6 `RPC-CORE` disconnect lines show `<url>`. The earlier 06:28 UTC run (before redaction) printed only the keyless Preview node URL |
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
| Midnight indexer + node (Preview) | indexer API v4 | preview (testnet) | Indexer reads (`query*`): 90 s per attempt (`src/retry.ts`, wrapped in `buildProviders`). Waits (`watchFor*`): no timeout of ours. Each retry starts the SDK's `maxWaitMs` again (when given), so the total wait can reach 4 × `maxWaitMs` plus backoff. `scripts/deploy.ts`: 30 s per attempt for the stale-deployment query. Wallet sync bounded by `MIDNIGHT_SYNC_TIMEOUT_MS` | TODO | Under the SDK's own retry (Apollo, 5 attempts, 1–10 s), our layer retries timeouts, connection errors, 5xx and 429: 4 attempts, backoff 2 s doubling to 30 s with jitter, then a sanitised error. 4xx, circuit asserts, the SDK's `WatchTimeoutError` and unknown errors are not retried. Observed: HTTP 503 from the indexer on 2026-11-15 (that run, before retries existed, stopped after `createListing`). On 2026-11-20, 6 reads about 2 minutes apart (06:17:59–06:28:07 UTC) all returned HTTP 200 from both indexer and node, with the tip advancing about 20 blocks per interval (189931 to 190032), and the full flow test passed; it passed again at 11:57 UTC through the retry wrappers (no retry was needed). A real 503 outage has not been seen since the retries were added: that path is tested in memory only |
| Blockfrost (Preprod) | api v0 | preprod (testnet) | TODO | TODO (project id quota) | TODO |
| Local network (`compose.yml`) | — | undeployed | `scripts/deploy.ts`: 5 s reachability check on node and indexer | — | Deploy stops before sending anything |
| Proof server | `midnightntwrk/proof-server:9.0.0` | local Docker | `scripts/deploy.ts`: 5 s reachability check. `proveTx`: the SDK's 300 s per call (no shorter timeout of ours) | — | Our layer retries `proveTx` only when the connection was refused or the server answered 5xx/429 (3 attempts, backoff 5 s doubling to 30 s). It does not retry a timeout, a reset or a socket hang-up, because the proving job may still be running on the proof server; the error says so. **Gap:** the SDK's client underneath (`fetch-retry` 6.0.0) POSTs `/prove` again up to 3 times (2/4/8 s) after a 500/503 *and after any failed fetch*, including a reset or hang-up. So a reset in the middle of a proof can already start a second job below our layer. A final "refused" can also follow such a reset, and our layer then retries. Closing this needs our own proof client without transport retries. Deploy stops before sending anything if the server does not answer. At start-up the container downloads proving parameters from `srs.midnight.network` and exits if TLS fails (seen 2026-11-20 behind an HTTPS-scanning antivirus; fixed by giving it a CA bundle via `SSL_CERT_FILE`) |
| midnight-js SDK / wallet-sdk | 5.0.0 / 2.0.0 | — | Wallet sync: `Rx.timeout` in `syncWallet`. Indexer reads and proving: see the rows above. Submit: none of our own | — | `submitTx` is never retried: a failed submit may still land. Its error is sanitised and says the outcome is unknown and to read chain state (indexer, tx id) before submitting again. Errors that are not retried pass through unchanged. Our sanitised errors keep a midnight-js code only as `upstreamCode`, so midnight-js-contracts wraps them as provider failures, not as its own (possibly TRANSIENT) errors |
| tNIGHT faucet | — | preview / preprod | — | — | Manual top-up; tests assume a funded wallet |
| GitHub Pages | actions/deploy-pages@v4 | — | — | — | Re-run the workflow |

Transaction fees: paid in DUST generated from tNIGHT held by the wallet (`scripts/wait-for-dust.ts`). No other money moves through the product.

## Deployments
| Network | Address | What it is | Issuer key |
| --- | --- | --- | --- |
| preview | `a92bebe0a8e3c54e142a583da8caaa77dab1ec401a40c1d545efba98a6c4ece6` | Verification-only test deploy (2026-11-20, blocks 190065–190081); list, apply and low-income rejection verified | Random, not saved: cannot attest again |
| preview | `c3b7b61ddfd2414f166fffe57e4950777e66f1b82c86f6dc8a1f41d1c7f6ff02` | Verification-only test deploy (2026-11-20, blocks 193333–193349) through the retry wrappers; same flow verified | Random, not saved: cannot attest again |
| preview | `e6123a996294cbdf608d8909af52d2a8e5b1bbd636e6fb49e1f93db79a0c96bb` | Partial deploy from 2026-11-15: deploy and `createListing` (block 122818) only | Random, not saved |

Every run of the network test deploys a new contract with a random issuer key that is never saved. A deployment meant for use is made with `npm run deploy`, which keeps the issuer secret in `.tenant-proof/issuer.json`; none exists yet.
