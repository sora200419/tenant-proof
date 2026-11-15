# TenantProof

**Prove you can afford the rent without showing what you earn.**

Renting a room usually means sending payslips and ID to a stranger. TenantProof lets a tenant prove one fact to a landlord, "my monthly income is at least 3× the rent of this listing", and nothing else. It is a smart contract written in [Compact](https://docs.midnight.network/) for the Midnight network, plus a browser demo.

## Status

| | |
|---|---|
| Contract | Compiles with the Compact compiler 0.36.0 (language 0.28), including proving keys for all three circuits |
| Tests | 17 in-memory tests pass (`npm run test:sim`) |
| Browser demo | Runs the compiled contract in the page on the official Compact runtime |
| Public network | **Not deployed yet.** The deploy script and an end-to-end network test are in the repo but have not been run against Preview or Preprod |

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

Open http://localhost:5173 and press **Load demo data**. Then, on the Tenant tab:

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

[src/test/tenant-proof.test.ts](src/test/tenant-proof.test.ts) is the same flow against a real network (deploy, attest, list, apply, and a rejected low-income applicant). It has not been run yet.

## Deploying

Not done yet. To deploy to the Preview test network you need Docker (for the proof server), a wallet seed funded with tNIGHT from the [Preview faucet](https://midnight-tmnight-preview.nethermind.dev/), and a Linux, macOS or WSL shell:

```bash
npm run compile
npm run proof:up
npm run test:preview
npm run deploy:preview
```

The wallet seed is read from `MIDNIGHT_PREVIEW_ALICE_SEED` and the private-state password from `MIDNIGHT_PRIVATE_STATE_PASSWORD`, both in a gitignored `.env.preview` (see [.env.example](.env.example)). The issuer's contract secret is created on first deploy in `.tenant-proof/issuer.json`, also gitignored.

## Limits of this version

- **One issuer, and it is trusted.** The contract checks that the issuer attested an income. It cannot check that the issuer told the truth.
- **Attestations never expire and cannot be revoked.** An old payslip stays valid.
- **Anonymity is only as large as the set of attested tenants who qualify.** The issuer knows every tenant's income. An application shows the listing, so it shows that the applicant earns at least 3× that rent. If few attested tenants clear that bar, the issuer can narrow down or identify the applicant, and can link that person's applications the same way. In the demo data only Alice qualifies for the 1500 room, so the issuer would know it is her.
- **An application id is not tied to a person.** The landlord sees that someone eligible applied, but the contract gives the tenant no way yet to show "this id is mine" without revealing the secret key, which would link all their applications.
- **Credentials can be shared.** Nothing binds an attestation to a wallet or an identity: a tenant who gives their key, income and salt to someone else lets that person apply as them.
- **Anyone can create a listing**, including taking a listing id before its real landlord does, and the multiplier is fixed at 3.
- **The demo keeps every role's keys in one browser tab** so the flow fits on one screen. In real use each role has its own device and wallet.
- **The attestation tree holds 1024 leaves.**

## Roadmap

- Deploy to Preview, then connect the UI to the Lace wallet and a proof server
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
