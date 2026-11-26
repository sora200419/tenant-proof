# TenantProof

**Give landlords a source-verified income signal from a trusted issuer, without sending payslips.**

A landlord renting out a room usually relies on payslips that the tenant supplies and that are hard to check. With TenantProof, an issuer (an employer, university or bank) attests the tenant's income, and the tenant proves one fact to the landlord: "my attested monthly income is at least k× the rent of this listing", where the landlord chose k for that listing. The landlord learns that fact and a lower bound on the income, not the payslip or the tenant's key. The signal is source-verified in one sense only: the contract checks that the issuer attested the income. The issuer is trusted: the contract cannot check that it told the truth. As a side benefit, the tenant does not send payslips to the landlord. It is a smart contract written in [Compact](https://docs.midnight.network/) for the Midnight network, plus a browser demo.

## Status

| | |
|---|---|
| Contract | Compiles with the Compact compiler 0.36.0 (language 0.28), including proving keys for all four circuits (`attest`, `createListing`, `closeListing`, `apply`). Landlord-owned listings with a per-listing multiplier (S4) are tested in memory only; every Preview run below used the earlier three-circuit contract with a fixed 3× |
| Tests | In-memory tests pass (`npm run test:sim`): the contract, the retry layer, and wallet mode with a fake wallet |
| Browser, demo mode | Runs the compiled contract in the page on the official Compact runtime; every role's keys are in one tab. Live: https://sora200419.github.io/tenant-proof/ |
| Browser, wallet mode | **Verified on Preview (2026-11-22), local run only, before S4** (the current version, with landlord-owned listings, has not run on Preview yet). One role per tab; the Lace wallet balances, signs and submits; proofs come from the proof server on this computer. Test contract `db12a2fccb22763f5598b3c613030a7a7ef26469771845082db9f6d00fc4a58c`: deploy (block 224401), `createListing` (224420), `attest` (224457), `apply` (224474), and a second tenant with income below 3× the rent refused by the circuit before anything was proven or sent. All read back from the Preview indexer. See [Wallet mode](#wallet-mode) |
| Public network | **Flow verified on Preview (2026-11-20).** The network test deployed a test contract, `a92bebe0a8e3c54e142a583da8caaa77dab1ec401a40c1d545efba98a6c4ece6`, and the list, apply and low-income rejection tests passed against it. This is a verification-only test deploy: its issuer key was not saved, so it cannot attest again. A deployment meant for use is made with `npm run deploy`, which keeps the issuer key in `.tenant-proof/issuer.json`; none exists yet. Not run on Preprod |

Demo mode executes the real circuit logic and every `assert`, but it does not generate a zero-knowledge proof or submit a transaction. Wallet mode does both (see [Wallet mode](#wallet-mode)).

## How it works

Three roles, one contract ([contract/tenant-proof.compact](contract/tenant-proof.compact)):

1. **Issuer** (an employer, university or bank; the deployer in this version) calls `attest(leaf)`. The leaf is a salted commitment to `(income, tenant public key)`. The issuer gives the income and the salt to the tenant privately.
2. **Landlord** calls `createListing(label, rent, multiplier)`. Label, rent and multiplier are public. The multiplier is set per listing, from 1.0× to 10.0× in steps of 0.1, and cannot be changed afterwards. The circuit computes the listing id as `hash(label, landlord secret key)`, so the listing belongs to that key: nobody else can create it first or close it. The landlord's key is not stored. The landlord can later call `closeListing(label)`; a closed listing accepts no more applications, keeps the ones it has, and never reopens.
3. **Tenant** calls `apply(listingId)`. The tenant's secret key, income and salt are private witness inputs. The circuit:
   - checks that the listing exists and is open;
   - recomputes the commitment and checks, with a Merkle path, that the issuer attested it;
   - checks `income × 10 >= multiplier in tenths × rent` (for 3.0×: `income >= 3 × rent`);
   - records an application id, `hash(listing, tenant secret key)`.

### What is public and what is not

| On the public ledger | Never on the ledger |
|---|---|
| The issuer's public key | The tenant's secret key (and public key, which only the issuer sees) |
| A Merkle tree of salted income commitments | The income |
| Each listing id with its label, rent, multiplier and whether it is open | The salt; the landlord's secret key (listing ids are hashes of it) |
| Application id → listing id, for applicants who passed | Which commitment in the tree belongs to the tenant |

What the landlord learns from an application is that the applicant's attested income is at least the listing's multiple of the rent. Because the rent and the multiplier are public, that is a lower bound on the income, not the income.

Two listings of one landlord have unrelated ids, and the contract's public state does not say who owns a listing. The transactions that created them may still be linked through the wallet that paid the fees (not analysed). Labels are not unique: anyone can list a room under the same label with their own key, which gives a different id, so a tenant should apply to the full listing id the landlord gave them, not to a label. Wallet mode has a field for that id (or `&listing=<id>` in the URL), selects the listing only on an exact match, and shows the full id of the selected listing; the short id in the drop-down list is not enough to tell look-alikes apart.

Application ids are per listing. The same tenant applying to two listings produces two ids that are unrelated hashes: the contract's public state does not show that they belong to the same person, or which attestation was used. Each application does make public the attestation-tree root its proof was checked against. A root fixes how many attestations the tree held at that point, so it tells everyone the applicant's attestation is one of the first N; the issuer, which knows the order it attested tenants in, can use this to narrow down the applicant further. That is not the same as anonymity against everyone: the transactions that carried them are separate public data, and whether they can be linked through the wallet that paid their fees has not been analysed (see [Limits](#limits-of-this-version)). A second application to the same listing is rejected.

## Run it

Requires Node.js 22 or later.

```bash
npm install
npm run test:sim
```

The browser demo:

```bash
npm --prefix frontend install
npm run dev
```

Open http://localhost:5173 and press **Load demo data**. The issuer in the demo is a mock run by the page, not a real employer. The landlord lists the 1500 room at 3.0× (needs 4500) and the 1000 studio at 2.5× (needs 2500). Then, on the Tenant tab:

- Apply as Alice (income 6000) to both rooms: both pass, with two unrelated application ids.
- Apply as Bob (income 3500) to the 1500 room: rejected, `Income is below the listing's required multiple of the rent`. Bob passes for the studio.
- Raise Bob's income field to 9000 and apply again: rejected, `No issuer attestation for this income`.
- Press **+ New tenant** and apply: rejected, there is no attestation for that key.
- On the Issuer tab, **Try as someone who is not the issuer**: rejected, `Only the issuer can attest`.
- On the Landlord tab, **Try closing as someone else**: rejected, `Unknown listing` (another key derives another id). **Close** the room, then apply to it from the Tenant tab: rejected, `Listing is closed`.

The panel on the right shows the public ledger next to the private state. The banner above it searches every byte string in the decoded ledger for every key, salt and income the demo holds. Keys and salts are searched for as bytes, and each income as the 32-byte value the circuit hashes; numeric fields such as rents are not searched. It is a check of the ledger contents, not a proof about the protocol.

The compiled contract (`contract/managed/tenant-proof/contract`) is committed, so the tests and the demo run without the Compact compiler. The compiler is only needed to change the contract (`npm run compile`), and it runs on Linux, macOS or WSL.

## Wallet mode

Runs the same circuits for real: the Lace wallet balances, signs and submits, and the proof is built by the proof server on your computer. It works from a local run only: the proving keys (about 33 MB) are gitignored, so the hosted page cannot prove and says so. Preview testnet only; mainnet is refused.

You need Docker, `contract/managed/tenant-proof/keys` (from `npm run compile`), and Lace with Midnight support (connector API 4.x) set to Preview with tNIGHT and DUST (faucet above).

1. Start the proof server on this machine only (add the CA bundle from [Deploying](#deploying) if antivirus inspects HTTPS):

   ```powershell
   docker run -d --name tenantproof-proof-server -p 127.0.0.1:6300:6300 midnightntwrk/proof-server:9.0.0 midnight-proof-server
   ```

2. `npm --prefix frontend install`, then `npm run dev`, and open http://localhost:5173/?mode=wallet.
3. Connect Lace. Pick one role for this tab (Issuer, Landlord or Tenant) and type a password for that role's encrypted private-state store (at least 16 characters, 3 of: upper, lower, digits, symbols; it is not saved).
4. **Issuer tab:** deploy a contract and copy its address. **Landlord and Tenant tabs:** open the same page with `&contract=<address>` and press Load.
5. **Landlord:** create a listing (label, rent, multiplier) and give tenants its listing id; close it when the room is taken. **Tenant:** copy your public key and give it to the issuer; the issuer attests an income and hands back the credential JSON; the tenant imports it and presses **Prove and apply**.

Each transaction shows four stages: building the proof on this computer (can take a few minutes), waiting for your approval in Lace, submitted (transaction id), confirmed (block). A tenant whose income is below the listing's multiple of the rent, or who applies to a closed listing, is refused by the circuit in the page, before anything is proven or sent. A contract deployed before S4 stores listings differently and cannot be read by this version: deploy a new one.

The proof server receives the tenant's private inputs, so the page only ever uses `127.0.0.1:6300` (through the dev server's `/proof-server` proxy), has no field for another address, and ignores the wallet's own prover setting. Because the proxy forwards to the machine running the dev server, the page refuses to prove when it is opened from any origin other than localhost, 127.0.0.1 or [::1] (for example a dev server started with `--host`). Roles in one browser profile keep separate encrypted stores but share one origin; use a separate browser profile or device per role for real separation.

## Tests

[src/test/tenant-proof.sim.test.ts](src/test/tenant-proof.sim.test.ts) runs the compiled contract in memory:

- the deployer is recorded as the issuer; only the issuer can attest
- listings: label, rent, multiplier and open are stored under an id derived from the landlord's key; another key listing the same label first gets a different id and does not block the landlord (no squatting); a replayed listing, zero rent and a multiplier outside 1.0×–10.0× are rejected
- closing: only the landlord's key can close (anyone else, including a tampered client that returns another key, gets `Unknown listing`); closing twice, closing before creating, and listing a closed label again are rejected; applications made before closing stay; applying to a closed listing is rejected
- the listing's own multiplier decides: exactly the required income is accepted and one below is rejected for 3.0×, 2.5×, 1.0×, 10.0× and 3.3× (rounding up), and the largest rent and income do not overflow
- a tenant who claims more than was attested is rejected
- a tenant with no attestation is rejected
- a tampered client that supplies another tenant's valid Merkle path is rejected by the circuit
- a tampered client that relabels that path with its own leaf is rejected by the circuit's root check
- unknown listing and double application are rejected
- one tenant, two listings: two different application ids
- an application is still accepted after the issuer attests other tenants (historic Merkle root)
- no secret key (tenant, issuer or landlord), tenant public key, salt or income appears in the public ledger

Each S4 guard (the key-derived listing id, the multiplier range, the already-closed check, the closed check in `apply`, and the per-listing multiplier) was removed in turn from a throwaway copy of the contract, recompiled, and its tests shown to fail.

[src/test/tenant-proof.test.ts](src/test/tenant-proof.test.ts) is the same flow against a real network (deploy, attest, list, apply, and a rejected low-income applicant). It has been updated for S4 but not yet run on a network; the Preview results below are from the earlier contract.

**Preview result (2026-11-20):** all four tests passed. The Preview indexer shows the test contract `a92bebe0a8e3c54e142a583da8caaa77dab1ec401a40c1d545efba98a6c4ece6` with these actions:

| Block | Action | Transaction |
|---|---|---|
| 190065 | deploy | `7edda9884d3ac09ca022ebbeb281b2c580fab457fb007ae7ad588f28ec02c292` |
| 190069 | `createListing` | `9b7c9204d8239eaf5653c782723311a206e89825ff3d2855ec93a86f2ed74f8c` |
| 190073 | `attest` (eligible tenant) | `76189a4ed8c2576d3f2e03e18baeeb64d6e627955f3cb14f7ba7d1dfaadb9729` |
| 190077 | `apply` | `bb9a2c3aa7bfe5b6a1c0ff4d221ca95bfec36ae39e14e5a4701be783df2dcdcb` |
| 190081 | `attest` (low-income tenant) | `515b131924b92dcdaaca2b595a1ccbc33751017bbed56afbf7342bccbb1c95c2` |

The low-income tenant's `apply` was rejected by the circuit before anything was submitted, so there is no second `apply`. Each run of the network test deploys a new contract with a random issuer key that is not saved; that contract is for verification only and cannot attest again.

**Preview run with retries and log redaction (2026-11-20, 11:57–12:00 UTC):** all four tests passed again, this time through the retry wrappers in `buildProviders`. Test contract `c3b7b61ddfd2414f166fffe57e4950777e66f1b82c86f6dc8a1f41d1c7f6ff02`: deploy at block 193333 (`112601f09dc681c2fa1374e7dc20c54f28aa5cbfb32eab0d15ad6f4eb0a5bb1d`), `createListing` 193337, `attest` 193341, `apply` 193345, `attest` (low-income tenant) 193349. No retry was needed during the run. The Polkadot client's 6 disconnect lines printed `<url>` instead of the node URL.

An earlier run on 2026-11-15 deployed `e6123a996294cbdf608d8909af52d2a8e5b1bbd636e6fb49e1f93db79a0c96bb`. Only its deploy and `createListing` (block 122818) reached the chain before the Preview indexer returned HTTP 503. That partial deploy is not used.

[src/test/dapp-wallet.sim.test.ts](src/test/dapp-wallet.sim.test.ts), [src/test/provider-set.sim.test.ts](src/test/provider-set.sim.test.ts) and [src/test/compiled-contract.sim.test.ts](src/test/compiled-contract.sim.test.ts) cover wallet mode without a network: a fake Lace connector (real ledger-v9 transactions through the hex round trip), the mainnet and wrong-network refusals, the loopback-only proof-server guard, error mapping, that a failed submit is never retried, that an indexer 503 is, and that both exports of the compiled contract build. Each guard was removed in turn and its test shown to fail.

**Wallet-mode Preview run (2026-11-22):** driven from the UI in Chrome with Lace and a proof server in Docker on the same machine. Every row below was read back from the Preview indexer (hash, block and contract address match what the page showed). The contract is `db12a2fccb22763f5598b3c613030a7a7ef26469771845082db9f6d00fc4a58c`; it is a verification-only deploy whose random issuer key lives only in the issuer tab's encrypted browser store.

| Block | Action | Transaction |
|---|---|---|
| 224401 | deploy | `7759c1d626a89a64ca3d8db957dcd3725063dc664c24aa70a8a8a275ea51c98a` |
| 224420 | `createListing` (rent 1500) | `ae8305cca08b7fe4ddd801ab0eb34002152a5dd6624b2faf986dc305acc86fd4` |
| 224457 | `attest` (income 6000) | `8b5867504e75d0be4953c9a5be74b38958c33304f7df9645677eed68df641207` |
| 224474 | `apply` | `d98be16dc211b044c9bd900a29c42fa5bac0dc1f0ff1c1cea3032311f3b69b5c` |
| 224509 | `attest` (low-income tenant, income 3500) | `f7ca959daacfa8b9a3b5d938769212805312f880ac3f67d1bac9aa2c6954f380` |
| 224623 | `attest` (income 6000 for the second tenant; sent to check that the credential shows before the transaction goes out) | `68109f1616f83037d7cfd0edf4bf7879281445ee0318cecd3dfe1be0e5f61bff` |

To check a row yourself, ask the Preview indexer (`https://indexer.preview.midnight.network/api/v4/graphql`) for `{ transactions(offset:{hash:"<hash>"}) { hash block { height } contractActions { __typename address } } }`.

The low-income tenant's `apply` was refused by the circuit in the page (`failed assert: Income is below 3x the rent`) before anything was proven or sent: the proof server's log did not grow. Checked in a second run on 2026-11-23 (new verification-only contract `190f7915f33b0e6d0b2d825ec5e7e24ed7d2a3d4e9e75d3e5cfcabb590de1522`: deploy at block 235472, tx `bbb8dc12d5adc38c50f393eae01ce9dfce464f5a67e5338c5de08ef0e6c8417a`, read back from the indexer as `ContractDeploy`): (1) when Lace was declined in the approval popup for `attest`, the page showed the "you declined the request in the wallet" text, kept the issuer's credential box, sent nothing (Attestations stayed 0) and the Publish button worked again; (2) the next, approved `attest` (block 235494, tx `197d3b6794529167a809ea99f2ea9a21fd674208f0f8bf574da50acfec0523c8`, read back as `ContractCall`) moved the page's Attestations count from 0 to 1 without pressing Refresh. Found in that run: with Lace locked, connecting failed with "you declined the request in the wallet" although no popup had appeared (Lace answers reads with `Rejected` while locked or when the site is not allowed); the read steps now say the wallet may be locked and to unlock Lace.

**Follow-up run on the same contract (2026-11-25):** (1) With Lace locked, Connect showed the new text ("the wallet refused without asking you. It may be locked or may not allow this site. Unlock Lace, allow this site, then connect again"). (2) `createListing` declined in Lace: "you declined" text, button usable again, "No listings yet." unchanged, nothing sent. The next, approved `createListing` (`bukit-jalil-room-a`, rent 1500; block 259930, tx `02e5e4aa2359edfb418d62117f81a2e3c8fca4964ec78467c2d404f413d3a433`) made the listing appear on the page without pressing Refresh. (3) A second `attest` for a real tenant tab's key (block 259968, tx `9ba5a08c134c6633d56833ead4794d9f3f9e11f8ae67289e5a99854316da7c98`) moved Attestations from 1 to 2 without pressing Refresh (the first read right after confirmation still showed 1; it showed 2 about 20 s later). (4) `apply` declined in Lace: "you declined" text, nothing sent; the next, approved `apply` (block 259989, tx `073fd8eede861d9a602670a576d5f56ad057d3cdaee828cd62045f7429ca966e`) showed "Eligible for bukit-jalil-room-a" in the tenant tab. A separate landlord tab then loaded the listing with "Eligible applicants (1)" and the same application id. Every hash above was read back from the Preview indexer (`ContractCall` on the contract). Not checked: dismissing the Lace popup without answering; the eligible-applicant count updating by itself in a landlord tab that was already open when the tenant applied (the page re-reads only after that tab's own transaction). Credential import: pasting the JSON as a string works; the first attempt in that run (a mis-set field) was refused in the page with "No attested income in private state" before anything was proven. On the first deploy attempt, `submitTx` was rejected for a reason that was not captured (the same action succeeded on the second try); the page now shows the sanitised cause chain.

## Deploying

To run against the Preview test network you need Docker (for the proof server) and a test wallet funded with tNIGHT from the [Preview faucet](https://midnight-tmnight-preview.nethermind.dev/). The run used Windows PowerShell:

```powershell
docker run -d --name tenantproof-proof-server -p 127.0.0.1:6300:6300 midnightntwrk/proof-server:9.0.0 midnight-proof-server
$env:MIDNIGHT_NETWORK = 'preview'
$env:NODE_OPTIONS = '--experimental-vm-modules'
npx vitest run --exclude 'src/**/*.sim.test.ts'
```

The wallet is read from `MIDNIGHT_PREVIEW_ALICE_MNEMONIC` and the private-state password from `MIDNIGHT_PRIVATE_STATE_PASSWORD`, both in a gitignored `.env.preview` (see [.env.example](.env.example)). The issuer's contract secret is created on first deploy in `.tenant-proof/issuer.json`, also gitignored.

A first run from a fresh wallet syncs from genesis and takes about 78 minutes on Preview. Later runs reuse the saved state in `.wallet-state/` (the 2026-11-20 run synced in about 2 minutes).

**Retries and timeouts.** The contract providers built by `buildProviders` go through [src/retry.ts](src/retry.ts); the wallet SDK's own sync and balancing traffic does not. Indexer reads and waits are retried on timeouts, connection errors, HTTP 5xx and 429, with backoff of a few seconds up to 30 s. Our layer retries proving only when the proof server refused the connection or answered 5xx/429. It does not retry a proving timeout or a dropped connection, because the job may still be running on the proof server. The SDK's proof client underneath does re-send a proof up to 3 times after a dropped connection, so a reset in the middle of a proof can still start a second job. Submitting a transaction is never retried, because a failed submit may still land; read chain state before trying again. Error lines our scripts log, and anything written through the console in the deploy script, the wait-for-dust script and the network test, have URLs and the Blockfrost `project_id` removed. Errors that are passed on unchanged (a 4xx, a failed circuit check) and that Vitest prints for a failing test are not redacted.

If antivirus software on your machine inspects HTTPS (it re-signs certificates with its own root), the proof server container cannot verify `srs.midnight.network` and exits at start-up with `UnknownIssuer`. Give the container a CA bundle that also holds that root, mounted read-only and named in `SSL_CERT_FILE`. The proof server still checks every downloaded parameter file against its known hash.

## Limits of this version

- **One issuer, and it is trusted.** The contract checks that the issuer attested an income. It cannot check that the issuer told the truth.
- **Attestations never expire and cannot be revoked.** An old payslip stays valid.
- **Anonymity is only as large as the set of attested tenants who qualify.** The issuer knows every tenant's income. An application shows the listing, so it shows that the applicant earns at least that listing's multiple of its rent. If few attested tenants clear that bar, the issuer can narrow down or identify the applicant, and can link that person's applications the same way. In the demo data only Alice qualifies for the 1500 room, so the issuer would know it is her.
- **An application id is not tied to a person.** The landlord sees that someone eligible applied, but the contract gives the tenant no way yet to show "this id is mine" without revealing the secret key, which would link all their applications.
- **Credentials can be shared.** Nothing binds an attestation to a wallet or an identity: a tenant who gives their key, income and salt to someone else lets that person apply as them.
- **Listing labels are not unique.** A listing id is bound to its landlord's key, so nobody can take it or close it, but anyone can list a room under the same label. A tenant must apply to the id the landlord gave them; the contract cannot tell a genuine listing from a look-alike.
- **A lost landlord key means the listing can never be closed.** The landlord key lives only in that role's encrypted store in one browser (wallet mode) or in the page (demo mode); there is no export or backup. If the store, the browser profile or its password is lost, the listing keeps accepting applications and nobody can close it.
- **A listing's multiplier is fixed once listed, and a closed listing never reopens.** To change terms, the landlord closes it and lists again under a new label.
- **Demo mode keeps every role's keys in one browser tab** so the flow fits on one screen. Wallet mode holds one role per tab, but all roles of one browser profile share an origin, so one page's code could read another role's store. Separate profiles or devices are not enforced.
- **The issuer's credential is not stored.** After an attestation the issuer tab shows the credential (income and salt) once, before the transaction goes out; it lives in the page only. If the tab is closed before the credential is copied, that commitment can never be opened by the tenant and the issuer has to attest again with a new salt.
- **Fees come from a wallet.** Whether the wallet that pays for a tenant's applications lets an observer link them has not been analysed.
- **The proof server sees the private inputs.** To build a proof it receives the tenant's key, income and salt. That is only safe when the user runs it on their own machine (`127.0.0.1:6300`); a remote proof server would see the income and the salt. The in-page demo uses no proof server.
- **The page handles keys.** The page runs the circuits and holds that role's keys in memory (wallet mode also keeps them in an encrypted browser store), so a tampered build of the page could send them elsewhere. There is no defence for this yet.
- **The attestation tree holds 1024 leaves.**

## Roadmap

- Deploy to Preview with `npm run deploy` (issuer key kept); wallet mode already runs the flow through Lace and a local proof server
- Expiry and revocation for attestations
- Several issuers, and alternative criteria such as savings ≥ 12× rent
- A way for a tenant to prove in person "this application id is mine" for one listing only

## Project layout

```
contract/tenant-proof.compact   the contract
contract/witnesses.ts           private inputs (runs on the user's device)
contract/managed/               compiler output (JS, ZKIR)
src/attest.ts                   off-chain helpers shared by tests and UI
src/provider-set.ts             provider assembly with retries, shared by Node and the browser
src/dapp-wallet.ts              Lace (dApp connector) adapter and the local-proof-server guard (browser-safe)
src/retry.ts                    timeouts, retries and sanitised errors (browser-safe)
contract/browser.ts             the compiled contract without Node-only parts
src/test/                       in-memory tests and the network test
scripts/deploy.ts               deploy to local, Preview or Preprod
frontend/                       browser UI: demo mode and wallet mode (Vite + React)
```

The project scaffold (`src/config.ts`, `src/providers.ts`, `src/wallet.ts`, `src/deployments.ts`, `src/test/sim.ts`, `scripts/`, `compose.yml`) was generated by the official [midnight-examples](https://github.com/midnightntwrk/midnight-examples) tooling. The contract, witnesses, tests, helpers and frontend are ours.

## License

Apache-2.0
