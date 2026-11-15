# Demo script and Devpost text

## Two-minute video

Start the demo with `npm run dev` and open http://localhost:5173.

| Time | Do | Say |
|---|---|---|
| 0:00 | Title screen | "To rent a room you send payslips and ID to a stranger. TenantProof lets you prove one thing instead: that you earn at least three times the rent." |
| 0:15 | Press **Load demo data** | "An employer has attested two tenants. Alice earns 6000, Bob earns 3500. A landlord has listed two rooms, at 1500 and 1000." |
| 0:30 | Point at the right-hand panels | "The top card is everything the public ledger holds: commitments, listings and rents. The card below it is what stays on the tenant's device: the key, the income, the salt." |
| 0:45 | Tenant tab, Alice, **Prove and apply** to room A | "Alice applies. The circuit checks her employer's attestation and that 6000 is at least 4500. The ledger gets an application id for that room, with no name, key or income attached." |
| 1:00 | Switch listing to the studio, apply again | "She applies to a second room. Two ids, and nothing on the ledger says they belong to the same person." |
| 1:15 | Switch to Bob, apply to room A | "Bob earns 3500. Rejected: income is below three times the rent." |
| 1:25 | Change Bob's income to 9000, apply | "Bob lies about his income. Rejected: there is no employer attestation for that number." |
| 1:35 | Issuer tab, **Try as someone who is not the issuer** | "Someone pretends to be the employer. Rejected." |
| 1:45 | Point at the green banner | "After all of that, the page searches the whole public ledger for every key, salt and income in the demo. None is there." |
| 1:55 | README status table | "The contract compiles with proving keys and passes 17 tests. This demo runs the real circuit logic in the browser. Deploying it to the Midnight test network is the next step." |

## Devpost

**Name:** TenantProof

**Tagline:** Prove you can afford the rent without showing what you earn.

**Inspiration**

Students and young workers renting a room are asked for payslips, bank statements and ID before they have even seen the place. The landlord needs one answer, "can this person afford it", and gets a file of personal data instead.

**What it does**

An issuer, such as an employer or a university, attests a tenant's income by publishing a salted commitment. A landlord lists a room with a public rent. The tenant then proves that the attested income is at least three times that rent. The landlord sees an application id, with no name or key attached, for each applicant who passed. The income, the salt and the tenant's key are never written to the ledger, and the ledger does not show that two applications to different rooms come from the same person.

**How we built it**

- One contract in Compact (language 0.28, compiler 0.36.0) with three circuits: `attest`, `createListing` and `apply`.
- Attestations sit in a historic Merkle tree. The tenant proves membership with a private Merkle path, so the proof does not say which attestation is theirs.
- Application ids are a hash of the listing and the tenant's secret key, which blocks double applications while keeping the ids of one tenant's applications unrelated on the ledger.
- 17 in-memory tests cover the contract's guards, including two kinds of tampered client that try to reuse someone else's Merkle path, and check that no secret appears in the public ledger.
- A React demo runs the compiled contract in the browser on the official Compact runtime, with the public ledger and the private state side by side.

**Challenges**

Getting the toolchain running on Windows (the compiler runs in WSL), and moving from an older compiler to the current one partway through, which changed the runtime from synchronous to asynchronous.

**What we learned**

Compiling and passing tests says nothing about privacy. We had to assert on the public state itself: read the ledger back and check that no secret is in it.

**What's next**

Deploy to the Preview network and connect the UI to the Lace wallet and a proof server. Then expiry and revocation for attestations, more than one issuer, alternative criteria such as savings, and listings owned by the landlord's key.

**What is not done**

Privacy has limits we state in the README: the issuer knows incomes, so when few attested tenants qualify for a listing it can narrow down who applied. The contract is not deployed to a public network yet. The demo executes the circuit logic and its checks in the browser but does not generate zero-knowledge proofs or submit transactions.

**Built with:** Midnight, Compact, TypeScript, React, Vite, Vitest
