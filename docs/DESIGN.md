# Design: TenantProof

## Current state
A single-page demo (`frontend/src/App.tsx`, `frontend/src/styles.css`) built to show the whole flow on one screen:

- A header with **Load demo data** and **Reset**.
- Three role tabs: 1 Issuer (attest a tenant's income), 2 Landlord (list a room), 3 Tenant (prove eligibility and apply, import a credential).
- A right-hand column: privacy-check banner, public ledger, the selected tenant's applications, and that tenant's private state.
- An activity log of accepted and rejected actions, showing the contract's own assert message.

It keeps every role's keys in one browser tab, which a product must not do.

## Direction
TODO: the feeling in one or two sentences, plus 1-3 reference products. The product splits the demo into separate entry points per role (tenant, landlord, issuer), each on its own device and wallet.

## Mockups
- TODO: link to the mockup of the tenant apply flow and the landlord listing view.

## Tokens
TODO: extract from `frontend/src/styles.css` when the product UI is designed.

| Token | Light | Dark |
| --- | --- | --- |
| Background | TODO | TODO |
| Text | TODO | TODO |
| Accent | TODO | TODO |
| Danger | TODO | TODO |

- Font: TODO
- Spacing scale: TODO
- Radius: TODO

## Screens
### Today (demo)
| Screen | Step in core path | Loading | Empty | Error |
| --- | --- | --- | --- | --- |
| Issuer tab | 1. Attest | Buttons disabled while busy | — | Assert message in the log ("Only the issuer can attest") |
| Landlord tab | 2. List a room | Buttons disabled while busy | — | Assert message in the log (duplicate id, zero rent) |
| Tenant tab | 3. Apply | Buttons disabled while busy | — | Assert message in the log (income below 3×, no attestation, already applied) |
| Activity log | all | — | "Nothing yet. Press Load demo data…" | Rejected actions shown in red with the assert message |
| Ledger / private state panels | 4. Landlord sees the id | Waits for the in-page deploy | Empty tables | Full-page message if the contract cannot start in the browser |

### Product (TODO)
| Screen | Step in core path | Loading | Empty | Error |
| --- | --- | --- | --- | --- |
| Connect wallet | before every step | TODO | No wallet installed | Wrong network, rejected connection |
| Tenant: import credential | 1 → 3 | TODO | No credential yet | Credential does not match this key |
| Tenant: apply | 3 | Proof generation in progress, tx pending | — | Proof server unreachable, tx failed, assert rejected |
| Landlord: listings and applications | 2, 4 | TODO | No listings / no applications | Indexer unavailable |
| Issuer: attest | 1 | TODO | — | Not the issuer, tx failed |

## Baseline
- Works at phone width (375px) without horizontal scroll (today: one breakpoint at 960px).
- Keyboard reachable, visible focus, text contrast at least 4.5:1.
- Every form: inline validation, disabled submit while sending, error message the user can act on.
- UI text about privacy matches `docs/SECURITY.md`.
