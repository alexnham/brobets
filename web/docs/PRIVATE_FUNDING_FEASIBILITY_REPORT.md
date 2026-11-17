# Private funding feasibility report (ticket #1)

**Date:** 2026-11-16. **Verdict:** the protocol primitives work locally; the release is **not ready to build on yet**. Three things are unproven and one is a design problem (custody). Downstream tickets that assume a hosted devnet anonymous Ring or program-owned private collateral are blocked until those are resolved.

Source pins and devnet read-only checks are in `PRIVATE_FUNDING_SOURCE_FINDINGS.md`. Everything below marked **tested** ran on a local validator (surfpool) with the pinned `custom-privacy-rings@cc21e14` / `zolana@b99ba45`, the locally built Go prover, production ring keys v15, and real proofs. Nothing was signed or sent on devnet.

## Tested locally

Test: `experiments/privacy-rings/brobets.rs`, `brobets_private_usdc_buys_redeems_and_withdraws`, on an anonymous audit-only Ring with an SPL test mint standing in for USDC and a second mint standing in for BB.

| Step | Result |
| --- | --- |
| Public ingress | An external funder's token account deposits 22 USDC to the player's hidden Ring identity. The player signs nothing. |
| Purchase | One Ring transact pays 10 collateral to the vault and 1 premium to the treasury (two private outputs plus change). The BB mint to the public betting wallet is a second instruction in the same transaction. |
| Atomicity | The same proof paired with a failing BB instruction is rejected and the state tree is byte-identical afterwards. Paired with a valid BB mint it lands. |
| Redemption | The betting wallet burns 4 BB and the vault pays the player 4 private USDC in the same transaction. No public USDC account moves. |
| Withdrawal | The hidden player exits 3 USDC to a public token account owned by a key that never signed. |
| Balances | Vault, treasury and player wallets resync from the indexer to the expected notes after every step. |

Upstream tests also run and passing: relayed anonymous payment (relayer pays the fee), anonymous owner hiding with auditor access, and USDC crossing a policy Ring boundary.

## What is public

- **Deposit:** funder token account, USDC mint, amount, time, fee payer, and the Ring program. The recipient is a tag, not the player's key.
- **Purchase:** fee payer, BB mint, betting wallet, BB amount, time. The transaction's Ring instruction names neither the player, vault, treasury nor funder (asserted in the test). USDC amounts are hidden.
- **Redemption:** betting wallet (it signs the burn), BB amount, time. The private credit is hidden.
- **Withdrawal:** destination token account, amount, time. It must be an associated token account or PDA; a keypair-addressed account is refused.
- **Not public but not private from operators:** the Ring auditor can open every transfer by design, and whoever runs the prover and Ring RPC sees proof inputs.

Correlation risk is real. A 22 USDC deposit followed soon after by a 10 BB mint, on a Ring with few users, links funder to betting wallet by timing and amount even though no account is shared. Batching, delays or fixed denominations would be needed; none is designed or tested. Do not promise anonymity on sparse usage.

## Not proven

1. **Hosted devnet anonymous Ring.** Devnet has the shielded pool, registry, indexer and an attested prover, and Ring activation is permissionless. No anonymous custom Ring that accepts USDC, with a ring indexer and Ring RPC, is known to be hosted. Brobets would deploy its own Ring program and run (or get Helius to host) the ring indexer, ring prover and Ring RPC. This is the concrete access gap to raise with Helius; no message has been sent.
2. **Zero-SOL for the player end to end.** In our test the test payer signs and pays every transaction directly. The upstream relay test proves a relayer can pay for an anonymous SOL payment, but relayed USDC purchase, redemption with an extra instruction, and relayed withdrawal are untested. Whether the Ring RPC relay accepts an extra instruction beside the transact is unknown.
3. **No-connect payment route.** The deposit needs someone to sign as token authority of the source account. An external sender paying from an exchange or another wallet cannot make a Ring deposit themselves, so Brobets (or a provider) must receive public USDC at a per-user address and then deposit it. That intermediate hop is public and was not built or tested.
4. **Embedded keys.** Shielded-key provisioning, recovery without seed export, and delegated viewing with an embedded wallet provider were not tested. The test uses raw local keypairs.
5. **Costs.** The whole four-step test, including Ring setup and enrollment, took 79 s on an 8-core laptop. Per-proof time, compute units, rent, relay fees and hosting costs were not measured.

## Custody problem

The Ring program does not check that the BB minted matches the private payment. Atomicity comes only from both instructions being in one transaction, so the BB mint authority must inspect the payment before co-signing. That means a Brobets server key decides issuance.

Private collateral is a note owned by a shielded keypair, not by the token-vault program. A program-owned vault would need the ring-authority rail, which is switched off on all four devnet Ring configs observed. So private collateral is held by a Brobets-controlled key rather than enforced on-chain. This is a change from program-held collateral and needs an explicit decision before tickets #5 and #6.

Refunds are feasible in principle (the vault can pay any Ring address or exit to a public account) but depend on that same key.

### Decision (2026-11-16): keep the reserve public

Collateral stays in the existing token-vault program reserve, and the program keeps sole control of BB minting. Private USDC exits the Ring into the reserve at purchase and returns to the Ring at redemption. Backing stays verifiable on-chain. The accepted cost is that each purchase and redemption shows a public reserve movement equal to the BB change, so privacy covers the funding source and withdrawal destination, not amounts.

**Tested locally under this decision:** `brobets_public_reserve_buys_and_redeems_from_private_usdc` (same file). It loads the real token-vault program (`target/deploy/token_vault.so`, built 2026-11-16 from a working tree with uncommitted `matching.rs` edits; `buy`/`sell` are unchanged), runs `initialize`, and calls the real `buy` and `sell`. Two test-only shortcuts: the program is written into the validator with a surfpool cheatcode rather than deployed, and the suite's USDC mint is patched from 9 to 6 decimals because the vault requires 6.

| Step | Result |
| --- | --- |
| Purchase | One transaction: the hidden player exits 11 USDC to the betting wallet's token account, the betting wallet calls `buy` for 10 (USDC to the program reserve, 10 BB minted by the vault) and transfers 1 premium to the treasury. The Ring instruction names neither player nor funder. |
| Atomicity | The same proof with a failing BB instruction is rejected and the state tree is unchanged. |
| Redemption | Two transactions: the betting wallet calls `sell` for 4 (BB burned, USDC paid from the reserve), then deposits it to the player's hidden identity. |
| Zero SOL | The betting wallet's system account never exists. A sponsor pays every fee, including the Ring deposit, and pre-creates its token accounts. |

Consequences:

- The purchase publicly shows Ring -> betting wallet -> reserve for the exact amount. The betting wallet is linked to the Ring, though not to the funder or the player's Ring identity.
- Redeemed USDC is public in the betting wallet's account until it is deposited, and that deposit publicly names the betting wallet's token account and amount. It lands under the player's hidden identity, so later private transfers and the final withdrawal are not linked to it on-chain.
- The betting wallet signs the purchase and the deposit, so the embedded wallet must sign; it does not need SOL.
- The Ring transact, `buy` and the premium transfer fit one transaction under the suite's default compute limit; compute units and bytes were not measured.
- `buy` has no premium leg, so the premium is a separate transfer the client must add; nothing on-chain enforces it.
- Not tested: the redemption deposit in the same transaction as `sell`, and a relayer rather than a direct sponsor paying.

## Go / no-go

| Requirement | Status |
| --- | --- |
| Anonymous private USDC transfer | Go (local) |
| Public USDC ingress without the player signing | Go (local) |
| Collateral + premium + BB in one transaction | Go (local), issuance trust sits with Brobets |
| Private redemption credit | Go (local) |
| Public withdrawal | Go (local), ATA or PDA only |
| Hosted devnet Ring, indexer, prover, relay | Blocked, needs own deployment or Helius |
| Player holds zero SOL throughout | Go (local) with a direct sponsor; relayer path untested |
| External sender without connecting | Unproven, needs a public intermediate hop |
| Embedded key recovery and delegated viewing | Unproven |
| On-chain enforced collateral | Go (local, real token-vault `buy`/`sell`) |
