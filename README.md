# TenantProof

**Give landlords a source-verified income signal from a trusted issuer, without sending payslips.**

A landlord renting out a room usually relies on payslips that the tenant supplies and that are hard to check. With TenantProof, an issuer (an employer, university or bank) attests the tenant's income, and the tenant proves one fact to the landlord: "my attested monthly income is at least 3× the rent of this listing". The landlord learns that fact and a lower bound on the income, not the payslip or the tenant's key. The signal is source-verified in one sense only: the contract checks that the issuer attested the income. The issuer is trusted: the contract cannot check that it told the truth. As a side benefit, the tenant does not send payslips to the landlord. It is a smart contract written in [Compact](https://docs.midnight.network/) for the Midnight network, plus a browser demo.

## Status

| | |
|---|---|
| Contract | Compiles with the Compact compiler 0.36.0 (language 0.28), including proving keys for all three circuits |
| Tests | 17 in-memory tests pass (`npm run test:sim`) |
| Browser demo | Runs the compiled contract in the page on the official Compact runtime. Live: https://sora200419.github.io/tenant-proof/ |
| Public network | **Flow verified on Preview (2026-11-20).** The network test deployed a test contract, `a92bebe0a8e3c54e142a583da8caaa77dab1ec401a40c1d545efba98a6c4ece6`, and the list, apply and low-income rejection tests passed against it. This is a verification-only test deploy: its issuer key was not saved, so it cannot attest again. A deployment meant for use is made with `npm run deploy`, which keeps the issuer key in `.tenant-proof/issuer.json`; none exists yet. Not run on Preprod |

The browser demo executes the real circuit logic and every `assert`, but it does not generate a zero-knowledge proof or submit a transaction. That needs a proof server and a funded wallet (see [Deploying](#deploying)).

## How it works

Three roles, one contract ([contract/tenant-proof.compact](contract/tenant-proof.compact)):

1. **Issuer** (an employer, university or bank; the deployer in this version) calls `attest(leaf)`. The leaf is a salted commitment to `(income, tenant public key)`. The issuer gives the income and the salt to the tenant privately.
2. **Landlord** calls `createListing(listingId, rent)`. The rent is public.
3. **Tenant** calls `apply(listingId)`. The tenant's secret key, income and salt are private witness inputs. The circuit:
   - recomputes the commitment and checks, with a Merkle path, that the issuer attested it;
   - checks `income >= 3 * rent`;
   - records an application id, `hash(listing, tenant secret key)`.

### What is public and what is not

| On the public ledger | Never on the ledger |
|---|---|
| The issuer's public key | The tenant's secret key (and public key, which only the issuer sees) |
| A Merkle tree of salted income commitments | The income |
| Each listing id and its rent | The salt |
| Application id → listing id, for applicants who passed | Which commitment in the tree belongs to the tenant |

What the landlord learns from an application is that the applicant's attested income is at least 3× the rent. Because the rent is public, that is a lower bound on the income, not the income.

Application ids are per listing. The same tenant applying to two listings produces two ids that are unrelated hashes: the ledger does not show that they belong to the same person, or which attestation was used. That is not the same as anonymity against everyone (see [Limits](#limits-of-this-version)). A second application to the same listing is rejected.

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

Open http://localhost:5173 and press **Load demo data**. The issuer in the demo is a mock run by the page, not a real employer. Then, on the Tenant tab:

- Apply as Alice (income 6000) to both rooms: both pass, with two unrelated application ids.
- Apply as Bob (income 3500) to the 1500 room: rejected, `Income is below 3x the rent`.
- Raise Bob's income field to 9000 and apply again: rejected, `No issuer attestation for this income`.
- Press **+ New tenant** and apply: rejected, there is no attestation for that key.
- On the Issuer tab, **Try as someone who is not the issuer**: rejected, `Only the issuer can attest`.

The panel on the right shows the public ledger next to the private state. The banner above it searches every byte string in the decoded ledger for every key, salt and income the demo holds. Keys and salts are searched for as bytes, and each income as the 32-byte value the circuit hashes; numeric fields such as rents are not searched. It is a check of the ledger contents, not a proof about the protocol.

The compiled contract (`contract/managed/tenant-proof/contract`) is committed, so the tests and the demo run without the Compact compiler. The compiler is only needed to change the contract (`npm run compile`), and it runs on Linux, macOS or WSL.

## Tests

[src/test/tenant-proof.sim.test.ts](src/test/tenant-proof.sim.test.ts) runs the compiled contract in memory:

- the deployer is recorded as the issuer; only the issuer can attest
- listings: rent is stored; duplicate ids and zero rent are rejected
- income of exactly 3× rent is accepted; one below is rejected
- a tenant who claims more than was attested is rejected
- a tenant with no attestation is rejected
- a tampered client that supplies another tenant's valid Merkle path is rejected by the circuit
- a tampered client that relabels that path with its own leaf is rejected by the circuit's root check
- unknown listing and double application are rejected
- one tenant, two listings: two different application ids
- an application is still accepted after the issuer attests other tenants (historic Merkle root)
- no secret key, tenant public key, salt or income appears in the public ledger

[src/test/tenant-proof.test.ts](src/test/tenant-proof.test.ts) is the same flow against a real network (deploy, attest, list, apply, and a rejected low-income applicant).

**Preview result (2026-11-20):** all four tests passed. The Preview indexer shows the test contract `a92bebe0a8e3c54e142a583da8caaa77dab1ec401a40c1d545efba98a6c4ece6` with these actions:

| Block | Action | Transaction |
|---|---|---|
| 190065 | deploy | `7edda9884d3ac09ca022ebbeb281b2c580fab457fb007ae7ad588f28ec02c292` |
| 190069 | `createListing` | `9b7c9204d8239eaf5653c782723311a206e89825ff3d2855ec93a86f2ed74f8c` |
| 190073 | `attest` (eligible tenant) | `76189a4ed8c2576d3f2e03e18baeeb64d6e627955f3cb14f7ba7d1dfaadb9729` |
| 190077 | `apply` | `bb9a2c3aa7bfe5b6a1c0ff4d221ca95bfec36ae39e14e5a4701be783df2dcdcb` |
| 190081 | `attest` (low-income tenant) | `515b131924b92dcdaaca2b595a1ccbc33751017bbed56afbf7342bccbb1c95c2` |

The low-income tenant's `apply` was rejected by the circuit before anything was submitted, so there is no second `apply`. Each run of the network test deploys a new contract with a random issuer key that is not saved; that contract is for verification only and cannot attest again.

An earlier run on 2026-11-15 deployed `e6123a996294cbdf608d8909af52d2a8e5b1bbd636e6fb49e1f93db79a0c96bb`. Only its deploy and `createListing` (block 122818) reached the chain before the Preview indexer returned HTTP 503. That partial deploy is not used.

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

If antivirus software on your machine inspects HTTPS (it re-signs certificates with its own root), the proof server container cannot verify `srs.midnight.network` and exits at start-up with `UnknownIssuer`. Give the container a CA bundle that also holds that root, mounted read-only and named in `SSL_CERT_FILE`. The proof server still checks every downloaded parameter file against its known hash.

## Limits of this version

- **One issuer, and it is trusted.** The contract checks that the issuer attested an income. It cannot check that the issuer told the truth.
- **Attestations never expire and cannot be revoked.** An old payslip stays valid.
- **Anonymity is only as large as the set of attested tenants who qualify.** The issuer knows every tenant's income. An application shows the listing, so it shows that the applicant earns at least 3× that rent. If few attested tenants clear that bar, the issuer can narrow down or identify the applicant, and can link that person's applications the same way. In the demo data only Alice qualifies for the 1500 room, so the issuer would know it is her.
- **An application id is not tied to a person.** The landlord sees that someone eligible applied, but the contract gives the tenant no way yet to show "this id is mine" without revealing the secret key, which would link all their applications.
- **Credentials can be shared.** Nothing binds an attestation to a wallet or an identity: a tenant who gives their key, income and salt to someone else lets that person apply as them.
- **Anyone can create a listing**, including taking a listing id before its real landlord does, and the multiplier is fixed at 3.
- **The demo keeps every role's keys in one browser tab** so the flow fits on one screen. In real use each role has its own device and wallet.
- **The proof server sees the private inputs.** To build a proof it receives the tenant's key, income and salt. That is only safe when the user runs it on their own machine (`127.0.0.1:6300`); a remote proof server would see the income and the salt. The in-page demo uses no proof server.
- **The page handles keys.** The demo page runs the circuits and holds keys in memory, so a tampered build of the page could send them elsewhere. There is no defence for this yet.
- **The attestation tree holds 1024 leaves.**

## Roadmap

- Deploy to Preview with `npm run deploy` (issuer key kept), then connect the UI to the Lace wallet and a proof server
- Expiry and revocation for attestations
- Several issuers, and alternative criteria such as savings ≥ 12× rent
- Listings owned by the landlord's key, with a configurable multiplier and the ability to close
- A way for a tenant to prove in person "this application id is mine" for one listing only

## Project layout

```
contract/tenant-proof.compact   the contract
contract/witnesses.ts           private inputs (runs on the user's device)
contract/managed/               compiler output (JS, ZKIR)
src/attest.ts                   off-chain helpers shared by tests and UI
src/test/                       in-memory tests and the network test
scripts/deploy.ts               deploy to local, Preview or Preprod
frontend/                       browser demo (Vite + React)
```

The project scaffold (`src/config.ts`, `src/providers.ts`, `src/wallet.ts`, `src/deployments.ts`, `src/test/sim.ts`, `scripts/`, `compose.yml`) was generated by the official [midnight-examples](https://github.com/midnightntwrk/midnight-examples) tooling. The contract, witnesses, tests, helpers and frontend are ours.

## License

Apache-2.0
