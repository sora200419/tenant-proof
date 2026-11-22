# Design: TenantProof

## Current state
A single-page demo (`frontend/src/App.tsx`, `frontend/src/styles.css`) built to show the whole flow on one screen:

- A header with **Load demo data** and **Reset**.
- Three role tabs: 1 Issuer (attest a tenant's income), 2 Landlord (list a room), 3 Tenant (prove eligibility and apply, import a credential).
- A right-hand column: privacy-check banner, public ledger, the selected tenant's applications, and that tenant's private state.
- An activity log of accepted and rejected actions, showing the contract's own assert message.

That is **demo mode**: it keeps every role's keys in one browser tab, which a product must not do, so the page labels it. Since S3 the page has a second mode, **wallet mode** (`frontend/src/WalletMode.tsx`): one role per tab, the user's Lace wallet, the proof server on the same machine, Preview testnet. A switch at the top of the page picks the mode (`?mode=wallet` opens the second).

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

### Wallet mode (S3, built; local run only)
| Screen | Step in core path | Loading | Empty | Error |
| --- | --- | --- | --- | --- |
| Connect wallet | before every step | Waits for the user in Lace | "No Midnight wallet with connector API 4.x found" (names wallets found but unsupported) | Wrong network, declined connection, wallet disconnected: one line naming the step |
| Choose role + store password | before every step | — | — | Password too weak |
| Contract | 1 | Reads the indexer | Address field; issuer also sees Deploy | Not a 64-hex address, indexer unavailable |
| Tenant: import credential | 1 → 3 | — | No credential yet | Credential issued to another key, income or salt does not match the commitment |
| Tenant: apply | 3 | Four stages: proof on this computer, waiting for approval in Lace, submitted (tx id), confirmed (block) | No listings on this contract | Circuit assert shown before anything is proven (`Income is below 3x the rent`), proof server unreachable, DUST missing, Lace declined |
| Landlord: listings and applications | 2, 4 | Same four stages | No listings / no applications | Same |
| Issuer: attest | 1 | Same four stages | — | Not the issuer, same |

Not designed yet: mockups, tokens and a visual direction (the page reuses the demo's styles); separate entry points per role (today one page, one role per tab).

## Baseline
- Works at phone width (375px) without horizontal scroll (today: one breakpoint at 960px).
- Keyboard reachable, visible focus, text contrast at least 4.5:1.
- Every form: inline validation, disabled submit while sending, error message the user can act on.
- UI text about privacy matches `docs/SECURITY.md`.
