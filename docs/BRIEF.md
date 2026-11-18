# Brief: TenantProof

## Goal
Prove you can afford the rent without showing what you earn. A tenant proves one fact to a landlord, "my monthly income is at least 3× the rent of this listing", instead of sending payslips and ID. Phase one (hackathon demo) is done; this phase turns it into something real tenants, landlords and issuers can use.

## Who uses or judges it
- **Tenants** (primary): young university students and young working people renting a room.
- **Landlords**: list a room with a public rent and receive applications from eligible tenants.
- **Issuers**: an employer, university or bank that attests a tenant's income. Today the issuer is the contract deployer.

## Deadline
TODO: next delivery date.

## Core user path
1. The issuer attests a tenant's income and hands the tenant a credential (income + salt) privately.
2. A landlord lists a room with its monthly rent.
3. The tenant, on their own device and wallet, proves income ≥ 3× rent and applies.
4. The landlord sees an application id for that listing.

## Acceptance criteria (draft)
- [ ] The list, apply and low-income-rejection flow tests pass on Preview against a deployed contract.
- [ ] The UI connects to the Lace wallet and a proof server, generates a proof and submits a real transaction.
- [ ] Each role uses its own device and keys; no role's secrets are held in another role's browser.
- [ ] Every privacy statement in README, UI and docs matches the per-party table in `docs/SECURITY.md`.

## Out of scope (not doing)
- Deposit or rent payments (the only money involved is network transaction fees).
- KYC or real-name identity checks.
- Mainnet deployment (for now).
- TODO: confirm further exclusions.

## Milestones
Order follows the README roadmap; dates are not set yet.

| Date | Milestone | Done when |
| --- | --- | --- |
| TODO | Preview flow verified | The three network flow tests pass on Preview |
| TODO | Wallet integration | The UI submits apply / createListing / attest through Lace and a proof server |
| TODO | Expiry and revocation | Attestations can expire and be revoked |
| TODO | Multiple issuers and criteria | More than one issuer; alternatives such as savings ≥ 12× rent |
| TODO | Landlord-owned listings | Listings bound to the landlord's key, configurable multiplier, can be closed |
| TODO | "This id is mine" | A tenant can prove ownership of one application id to one landlord without linking their other applications |
| TODO | Feature freeze | Only bug fixes and demo prep after this date |
| TODO | Delivery | Everything in the deliverables list below is submitted |

## Deliverables
- [x] Public repository with README
- [x] Live demo: https://sora200419.github.io/tenant-proof/ (in-page simulator)
- [ ] Deployed contract with verified flows on a public testnet
- [ ] TODO: further deliverables for the next phase

## Open questions
- Hosting: stay on GitHub Pages, or move to Vercel for a preview deploy on every PR?
- Is a backend needed (credential delivery from issuer to tenant, a listing index for landlords)?
- Who is the first real issuer, and how does it hand the credential to the tenant privately?
- How does a landlord contact an eligible applicant without the tenant revealing their key?

## Demo / delivery script
Follow README "Run it" (load demo data, then the five scenarios on the Tenant and Issuer tabs). Run it for real before every delivery.
