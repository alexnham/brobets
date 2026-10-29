> Implementation update: the matched-wager contract is now in `programs/token-vault/src/matching.rs`, with its generated frontend ABI in `web/lib/matching-idl.json`. This original handoff is retained as the acceptance specification. See [MATCHING_DEPLOYMENT.md](MATCHING_DEPLOYMENT.md) for rollout. Question content is stored directly and immutably on-chain rather than through an off-chain content hash.

# Matching escrow handoff

The frontend needs individual, fully funded, equal-stake wagers under admin-created basketball questions. The current pooled `Bet` / `Position` program must not be used to approximate this behavior.

## Required deployment artifacts

Provide the Anchor IDL, devnet program ID, initialized vault and quote mint addresses, admin/oracle authority setup, PDA derivations and account layouts, transaction version support, error definitions, and a funded devnet test path. The admin/oracle wallet must match the address pinned in the web backend. Question authority must be enforced on-chain as well as in HTTP handlers; filtering a namespace in the UI alone cannot prevent unauthorized publication within the canonical app.

## Operations

| Operation | Required behavior |
| --- | --- |
| Create question | Admin signature; two immutable outcomes, unique question ID, betting cutoff, resolution deadline. Bind title/outcomes/deadlines to an immutable content hash so metadata cannot silently change the wager. |
| Propose | User chooses side A/B and positive six-decimal vault-token amount; transfer maker stake to an isolated escrow atomically. Only before cutoff. |
| Match | Different wallet deposits precisely the same token amount on the opposite side; atomically move proposal from open to matched. Reject further takers. |
| Cancel | Only maker can cancel an unmatched proposal, returning their stake; never cancel a matched wager. Allow cancellation of unmatched stakes after cutoff too. |
| Resolve | Admin/oracle selects A or B during `closesAt <= now < resolveBy`; outcome becomes immutable. |
| Void | Admin/oracle enables full participant refunds after cutoff and before resolution deadline; cannot override a finalized result. |
| Refund expired | Anyone can enable refunds if unresolved at/after resolution deadline; no winner selection. Unmatched deposits are independently refundable after cutoff. |
| Claim | Winner receives exactly both stakes with no platform fee. Void/expiry returns each participant's original stake. Claimant signature, correct destination ownership, and once-only enforcement. |
| Read | Fetch confirmed canonical question/proposal accounts and escrow token balances, including all identities, deadlines, state, stake, and claim flags. |

Use integer base units end to end; checked arithmetic must guarantee `2 * stake <= u64::MAX`. Reject unexpected mint, token program, PDA, owner, signer, recipient, account discriminator, and insufficient escrow. Protect against reinitialization and duplicate claims. Explicitly document rent and fee payer responsibilities. No private keys on the app server.

## Frontend/backend wiring after delivery

Implement `MatchingEscrow` from `lib/escrow.ts` with the delivered generated client; do not add a permissive environment toggle. Add authenticated action endpoints and read endpoints. Create immutable database metadata drafts before preparing a canonical admin transaction; publish only after matching chain account confirmation and metadata-hash verification. Store transaction references only after validating their expected action and wallet. Never populate the live board from browser storage.

For each action: read canonical state, construct the expected transaction, simulate, show stake/payout/network/fee payer/fees, request explicit user signature, submit, and persist a pending reference. On confirmation, verify finalized instruction/account effects and re-read escrow state from the expected program. Confirmed chain state determines UI status; transaction signatures and browser state are never payment proof. Retry confirmation/reconcile on reload and after RPC errors; do not automatically repeat a transfer when the original result is unknown.

Do not accept arbitrary serialized transactions from an untrusted service without checking every instruction, signer, token, destination, amount, and fee. The wallet signs client-side through Helius. Use a supported transaction format for the pinned wallet SDK and record its compatibility in the adapter.

## Acceptance before enabling real matching

- Exercise propose → match → resolve → claim with two wallets and exact token balance assertions.
- Race two takers against one proposal: exactly one succeeds and exactly one taker's funds move.
- Reject self-matching, partial matching, post-cutoff funding, unauthorized question creation/resolution, substituted accounts/mints, and second claims.
- Exercise unmatched cancellation, post-cutoff unmatched refund, explicit void, resolution expiry, and refunds claimed independently by each participant.
- Recover after signature rejection, failed simulation, blockhash expiry, RPC timeout after submission, and browser reload with a pending signature.
- Verify buy → propose → match → win → claim → redeem on devnet with the real configured vault.
