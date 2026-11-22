# Brief: TenantProof

## Goal
Give a landlord a source-verified signal of income, attested by a trusted issuer (the contract checks the attestation, not the income itself), instead of a payslip PDF. A tenant proves one fact, "my monthly income is at least 3× the rent of this listing", through an issuer attestation. As a side benefit the tenant does not have to send payslips and ID to a stranger. Phase one (hackathon demo) is done; this phase turns it into something real tenants, landlords and issuers can use.

Positioning (decided 2026-11-19, from local research notes, not published): the best-evidenced need is on the landlord side (forgeable tenant-supplied documents, no tenancy tribunal in Malaysia). "Tenants want to share less" is only indirectly evidenced, so privacy is the secondary benefit, not the headline. TenantProof is one layer of screening, not a replacement for deposit, ID or references.

## Who uses or judges it
- **Landlords and agents** (first buyer, and the party to validate): list a room with a public rent and receive applications from eligible tenants. First market: room rental in the Klang Valley.
- **Tenants** (credential holders, free to use): young people who have just started a job and rent a room. Students and gig workers are a later segment (see Known gaps).
- **Issuers**: an employer, university or bank that attests a tenant's income. The first issuer type is a payroll or HR platform (unnamed). In the hackathon demo the issuer is a self-run mock, labelled as such. Today the issuer is the contract deployer.

## Scope of the protocol and the story
- The protocol is generic: no country is hard-coded (the multiplier is meant to be configurable; the issuer can be any employer, university or bank).
- The demo and pitch story is Malaysian (room rental, RM, protagonist is a young person in their first job) and uses only public evidence gathered in the local research notes (not published). UK figures are market-size side evidence only.
- No interviews during the hackathon. The demo contains no invented landlord or tenant quotes.

## Deadline
TODO: next delivery date.

## Core user path
1. The issuer attests a tenant's income and hands the tenant a credential (income + salt) privately.
2. A landlord lists a room with its monthly rent.
3. The tenant, on their own device and wallet, proves income ≥ 3× rent and applies.
4. The landlord sees an application id for that listing.

## Acceptance criteria (draft)
- [x] The list, apply and low-income-rejection flow tests pass on Preview against a deployed contract.
- [x] The UI connects to the Lace wallet and a proof server, generates a proof and submits a real transaction. Done in S3, 2026-11-22, local run only (Preview; see README "Wallet mode" for the transactions read back from the indexer).
- [ ] Each role uses its own device and keys; no role's secrets are held in another role's browser. Partly: wallet mode holds one role per tab in separate encrypted stores, but they share one browser origin; separate profiles or devices are not enforced.
- [ ] Every privacy statement in README, UI and docs matches the per-party table in `docs/SECURITY.md`.

## Assumptions to validate
All of these are UNVALIDATED. None has first-hand evidence yet; the local research notes (not published) are vendor blogs, news and a few old forum threads.

| # | Assumption | Evidence today | Disproved if |
| --- | --- | --- | --- |
| A1 | Landlords and agents accept a bare "income ≥ k× rent" signal instead of payslips. **Disprove this first.** | None in any market. UK agents buy pass/fail referencing results; that is the closest analogue. | Most landlords say they would still require documents. |
| A2 | Tenants want to share fewer documents. | Indirect: one 2021 Lowyat question, one 2021 UK thread, a vendor claim that about 30% of UK tenants decline open banking. | Tenants say they do not mind sharing with genuine landlords. |
| A3 | A payroll or HR platform will sign income attestations. | None. No Malaysian income API found; issuer liability has no source. | No willingness to sign without a legal indemnity. |
| A4 | The 3× multiple matches Malaysian practice. | Vendor content gives about 30-33% of income; no explicit "3×" rule. | Landlords use a clearly different ratio or none. |
| A5 | The signal is useful as one layer, not as a replacement. | Inference from screening practice (deposit, ID, references). | Landlords say it saves them nothing without replacing documents. |

## Validation steps (after the hackathon)
Not done in the hackathon. Record each interview in a gitignored notes file; no real names in public docs. Dates are set by the owner.

1. **Landlords and agents, about 5 (first).** What do you ask for today, and what made you reject an applicant? Have you met forged payslips or borrowed ICs? Would a pass/fail from a source you trust replace payslips, or only supplement them? Whom would you trust as the source? What ratio or multiple do you use? Would you pay for it or require it? Kill criterion: most would still require documents.
2. **Renting tenants, about 5.** Young people in their first job, plus a few students and gig workers to size the known gap. What did you send, and to whom? Did anything feel unsafe or get misused? Would you use a proof instead? Who could issue yours? What if you have no payslip? Kill criterion: they do not mind sharing documents with genuine landlords.
3. **Payroll or HR platform contacts, about 5.** How are employment and income letters handled today, and what do they cost HR? Would you sign a salary attestation? What liability worries you? What integration would you accept? Who pays? Pitch angle: an employee benefit (fewer employment letters, fewer landlord verification calls); the issuer signs only the income figure and the threshold is computed in the circuit, so it does not vouch for "can afford rent". Kill criterion: no willingness to sign without a legal indemnity.

## Known gaps
- **Students and gig or freelance workers have no payroll issuer**, so this version cannot serve them. Deferred; to be solved later. The local research notes (not published) call irregular income a real cross-market gap and the weakest point of an issuer-based design.
- Attestations cannot expire or be revoked, so an old attestation stays valid (landlords prefer fresh data).
- Credentials can be shared; nothing binds them to a person (borrowed identity is the documented fraud pattern).
- Issuer liability for the attested figure is unsourced.

## Out of scope (not doing)
- Deposit or rent payments (the only money involved is network transaction fees).
- KYC or real-name identity checks.
- Mainnet deployment (for now).
- Invented quotes or fabricated user evidence in the demo.
- Naming a real payroll vendor as a partner before there is an agreement.
- TODO: confirm further exclusions.

## First slices
Ordered, each demoable. This list records the slices only; none is started by this change.

| Slice | What | Done when |
| --- | --- | --- |
| S0 | CI | A GitHub Actions workflow runs `npm run typecheck`, `npm --prefix frontend run typecheck` and `npm run test:sim` on push and PR (`pages.yml` stays separate) |
| S1 | Honest framing | README, UI and docs say "source-verified signal"; privacy claims stay per `docs/SECURITY.md`; the UI marks the issuer as a mock |
| S2 | Preview flow verified | The three network flow tests pass on Preview |
| — | Network resilience | Indexer reads and waits retry transient failures with backoff and timeouts; proving retries only a refused connection or 5xx/429; submit is never retried; logged errors carry no URL or Blockfrost `project_id`; the Preview flow passes through the wrapped providers |
| S3 | Wallet integration | apply / createListing / attest go through Lace and a proof server. Done 2026-11-22 (local run only; the hosted page stays demo mode) |
| S4 | Configurable multiplier, landlord-owned listings | Listings bound to the landlord's key; the landlord sets the multiplier; listings can be closed |
| S5 | Expiry, then revocation | Attestations can expire, then be revoked |
| S6 | Malaysian demo script | Young working-person protagonist, public evidence only, A1-A5 shown as unvalidated |

Interviews are not slices; they are the validation steps above.

## Milestones
Order follows the README roadmap; dates are not set yet.

| Date | Milestone | Done when |
| --- | --- | --- |
| TODO | Preview flow verified | The three network flow tests pass on Preview |
| TODO | Wallet integration | The UI submits apply / createListing / attest through Lace and a proof server |
| TODO | Assumptions A1-A5 tested | The validation steps above are done and each assumption is marked confirmed or disproved |
| TODO | First issuer decision | A payroll or HR platform, or another issuer type, is chosen from the interview results |
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
- How does a payroll or HR issuer hand the credential to the tenant privately?
- How does an issuer hand a credential to someone with no payroll (a student, a gig worker)?
- How does a landlord contact an eligible applicant without the tenant revealing their key?

## Demo / delivery script
Follow README "Run it" (load demo data, then the five scenarios on the Tenant and Issuer tabs). Run it for real before every delivery.
