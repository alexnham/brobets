# Fixed-price token vault (Anchor)

Public account addresses and authority assignments: [ADDRESSES.md](ADDRESSES.md).


An Anchor 1.1.2 program that creates a new SPL token redeemable at **1 token = 1 USDC**. Both mints have six decimals. A purchase of `1_000_000` base units deposits one USDC and mints one token; a sale burns one token and releases one USDC. Fractional trades work down to `0.000001` token. The two operations in each instruction succeed or revert together.

## Instructions

- `initialize()`: anyone can create the single vault for a selected six-decimal quote mint. Creates a zero-supply token mint and an empty reserve. The vault PDA is the sole mint authority. There is no token freeze authority.
- `buy(amount: u64)`: transfers the user's USDC into the reserve, then mints the same number of token base units.
- `sell(amount: u64)`: burns the user's tokens, then transfers the same number of USDC base units from the reserve.

The program supports the original SPL Token program only. Token-2022 extensions, transfer fees, and hooks are excluded. `anchor-spl`'s Token-2022 feature is compiled because Anchor's account initialization macros require it; the account types still enforce the original token program.

There are no trading fees, price updates, admin withdrawals, or external minting paths. Users pay Solana transaction fees and any account rent separately. Token transfers and direct burns are possible through SPL Token; direct burns or USDC donations leave surplus reserves that cannot be withdrawn through this program.

## Account derivation and integration

All PDA seeds use this program's ID:

| Account | Seeds |
| --- | --- |
| Vault state | `"vault", usdc_mint` |
| Token mint | `"token", vault` |
| USDC reserve | `"reserve", vault` |

Initialize accounts: `payer` (signer, writable), `usdc_mint`, `vault` (writable), `token_mint` (writable), `reserve` (writable), `token_program`, `system_program`.

Buy/sell accounts: `user` (signer), `vault`, `usdc_mint`, `token_mint` (writable), `reserve` (writable), `user_usdc` (writable), `user_token` (writable), `token_program`.

Create the user's USDC and vault-token accounts before trading (typically associated token accounts). Their owner must be the signing user. The generated IDL is `target/idl/token_vault.json`; it describes the instruction arguments, accounts, and errors for a client.

**Quote mint selection matters:** initialization accepts any original SPL mint with six decimals so local tests can use mock USDC. It does not certify that a mint is USDC. A client must pin the correct Circle USDC mint for its cluster and derive the vault from that address; never trust a ticker or a caller-supplied mint. The token mint address is then deterministic. An existing externally issued token cannot be substituted.

## Build and test

Requires Anchor 1.1.2, the Solana CLI/SBF build tools, and Rust. From the repository root:

```sh
NO_DNA=1 anchor build
NO_DNA=1 cargo test --workspace
```

The LiteSVM integration test loads `target/deploy/token_vault.so`, creates mock quote and user token accounts, and executes initialization and trades in the Solana VM. It covers exact fractional round trips, reserve and supply balances, zero amounts, insufficient funds, wrong token mints, wrong account owners, and substituted reserves. No RPC connection or funded wallet is needed for these tests.

Anchor creates a local deployment identity on first build. If cloning onto a new machine, run `NO_DNA=1 anchor keys sync` and rebuild to synchronize the new local program ID. Build outputs and local identities are ignored by Git. No deployment is performed by the build or tests.

## Security and scope

USDC deposits back all tokens issued through this program, assuming normal SPL Token behavior and a solvent quote issuer. The rate is fixed in USDC units; it does not guarantee USDC's dollar market value or this token's price on external exchanges. Circle can freeze USDC accounts, which can prevent purchases or redemptions.

The program has no reserve withdrawal instruction, but an upgradeable deployment's upgrade authority can replace the code. Choose upgrade authority custody or immutability deliberately before using real funds. This implementation has not received an independent audit. It includes the on-chain program and tests, without a wallet UI or deployment automation.

References: [Anchor token transfers](https://www.anchor-lang.com/docs/tokens/basics/transfer-tokens), [Anchor account constraints](https://www.anchor-lang.com/docs/references/account-constraints).

## Betting escrow

The original USDC reserve remains separate. Each bet holds **vault tokens**, so escrowed tokens remain backed by the USDC reserve and winners can redeem them through `sell` after claiming.

A bet is identified by `(oracle public key, bet_id: u64)`. The oracle signs creation and is stored permanently on the bet. Only that signer can declare the winning side; signing as a different wallet fails. Anyone can create bets in their own oracle namespace. **Your app must pin your oracle public key** and derive bet addresses using that key: a matching numerical bet ID from a different oracle is a different bet. There is no global owner wallet hardcoded into this version.

### Lifecycle

1. Oracle calls `create_bet(bet_id, closes_at, resolve_by)`. Timestamps are Unix seconds: `now < closes_at < resolve_by`. The token mint must belong to the existing token vault. Creates the bet and its escrow account.
2. Each bettor calls `open_position()` once per bet (can be combined with their first deposit in a transaction).
3. Bettors call `place_bet(side, amount)` with side `1` or `2` and positive token base units. Repeated deposits and staking on both sides are allowed. Stakes cannot be withdrawn or switched. Deposits stop exactly at `closes_at`.
4. During `closes_at <= now < resolve_by`, the creating oracle calls `resolve_bet(winning_side)`. The result is final and cannot be overwritten. An oracle cannot settle early or after its resolution deadline.
5. Each bettor calls `claim()` to their own token account. The position records the claim, preventing repeat withdrawals.

If the selected winning side has no stakes, everyone receives their own deposits back. If the oracle has not resolved by `resolve_by`, **any fee-paying caller** can call `refund_expired()` to permanently enable refunds. This instruction does not select a winner. Bettors then use `claim()` for their refunds; there is no claim expiry.

Payouts are pari-mutuel with no protocol fee:

```text
payout = floor(your winning-side stake × total stakes / winning-side total)
```

Example: side 1 has 30 tokens and side 2 has 70. If side 1 wins, a bettor with 10 tokens on side 1 receives 33.333333 tokens. A stake on the losing side has zero payout. A wallet staking on both sides only earns the winning-side payout. Refunds return both stakes in full.

Payout multiplication uses `u128`; deposits reject amounts that overflow a `u64` pot. Rounding down can leave tiny residual token amounts locked in escrow; no admin can sweep them. Direct token donations are not counted as stakes and also remain locked. Bet and position accounts persist to prevent reinitialization and duplicate claims; account rent is not reclaimed in this version.

### Additional PDAs and accounts

| Account | Seeds |
| --- | --- |
| Bet | `"bet", oracle, bet_id.to_le_bytes()` |
| Escrow token account | `"escrow", bet` |
| Bettor position | `"position", bet, user` |

- `create_bet`: `oracle` (signer, writable, pays rent), `vault`, `token_mint`, `bet` (writable), `escrow` (writable), `token_program`, `system_program`.
- `open_position`: `user` (signer, writable, pays rent), `bet`, `position` (writable), `system_program`.
- `place_bet`: `user` (signer), `bet` (writable), `token_mint`, `position` (writable), `escrow` (writable), `user_token` (writable), `token_program`.
- `resolve_bet`: `oracle` (signer), `bet` (writable).
- `refund_expired`: `bet` (writable); the transaction still needs a fee payer.
- `claim`: `user` (signer), `bet`, `token_mint`, `position` (writable), `escrow` (writable), `user_token` (writable), `token_program`.

The oracle is trusted to report the actual result. The program verifies its signature, deadlines, and payout accounting; it cannot verify an off-chain event. Bet descriptions/event identifiers belong in the app and should be bound to the oracle and bet ID. As with the token vault, a deployment upgrade authority can change program behavior.

Tests also exercise escrow deposits, top-ups across both sides, proportional settlement, unauthorized and premature resolution, deposit cutoff, immutable outcomes, stolen-position claims, duplicate claims, no-winner refunds, deadline refunds, and separation from the USDC reserve.

### Prepare devnet initialization

Run `node scripts/prepare-initialize.cjs` from the repository root (requires the existing `web` dependencies installed with `cd web && npm ci`). This read-only helper uses the configured devnet USDC mint and payer public address in the script, derives the three PDAs, checks account existence and mint ownership, and simulates an unsigned v0 initialization transaction. It prints the account addresses, rent/fee estimate, expiry height, and unsigned transaction as base64. It never loads private keys, signs, or broadcasts. A wallet client must deserialize and review the transaction, verify its connected address matches the payer, then request signing and submit it before expiry. Re-run preparation for a fresh blockhash if needed.

## Brobets frontend

The Next.js app lives in [`web/`](web/README.md). Run `cd web && npm ci && npm run db:generate && npm run dev` for the live devnet frontend. Helius email login, backend wallet sessions, admin question drafts, and devnet vault buy/redeem controls are included; setup is documented in the web README. Individual matched wagers are implemented additively alongside pooled betting. The new code must be deployed before real matching is available; see [`web/docs/MATCHING_DEPLOYMENT.md`](web/docs/MATCHING_DEPLOYMENT.md).

### Sign initialization with the local Solana CLI wallet

For the configured payer `GbDLTR4JK4EdZAtjXqAVDx3vWg2BwwEiESxsLqhDNEiG`, run from the repository root:

```sh
node scripts/initialize.cjs
node scripts/initialize.cjs --send
```

The first command only verifies the configured CLI wallet's public address and simulates initialization on devnet. The second displays the accounts, rent, and network fee, then requires you to type `INITIALIZE DEVNET` in an interactive terminal. It refreshes and simulates the transaction again before signing locally with the existing wallet path from `solana config get`. The key remains on your Mac; no key material is printed or sent to RPC. Only the signed transaction is broadcast. The script prints its signature and Explorer link before submission, confirms the transaction, then verifies the vault accounts. It does not create a new wallet, transfer USDC, or deploy the program. Dependencies come from the existing `web` installation. If confirmation is interrupted, inspect the printed signature on devnet Explorer before retrying. An already initialized vault is detected and not re-created.

## BROBETS token metadata

The `create_token_metadata()` instruction creates Metaplex metadata for an existing vault token, using:

- Name: `BROBETS`
- Symbol: `BB`
- URI: `https://alexnham.github.io/storage/brobets.json`
- Update authority: `GbDLTR4JK4EdZAtjXqAVDx3vWg2BwwEiESxsLqhDNEiG`
- Mutable: yes; royalties: zero; creators: none.

Only that wallet may sign creation. The vault PDA signs the CPI as the existing mint authority. The instruction validates the vault, token mint, canonical metadata PDA, and Metaplex program. It does not change the vault state layout or issue tokens. Metadata creation is one-time; afterward the update authority can update branding directly through Metaplex without a Brobets instruction.

For the existing devnet deployment, upgrade the **same program address**, then create metadata:

```sh
anchor build
cargo test --workspace
anchor deploy --provider.cluster devnet --provider.wallet ~/.config/solana/id.json
node scripts/token-metadata.cjs
node scripts/token-metadata.cjs --send
```

The last command simulates and shows the estimated SOL cost, including rent, network fee, and any Metaplex charge. It requires the configured CLI wallet to match the update authority and asks you to type `CREATE METADATA DEVNET` before signing locally. It refreshes the transaction, verifies the signature, simulates the signed transaction, then broadcasts and verifies the resulting metadata. The script detects matching existing metadata rather than creating it again. An interrupted submission prints its signature for lookup on devnet Explorer before any retry. An on-chain `InstructionFallbackNotFound` simulation error means the old deployment still lacks this instruction: upgrade it first. Do not re-run vault initialization.

The upgrade command signs and uploads code using your local wallet and can incur additional rent if the larger binary requires more program storage. This is separate from metadata creation cost. Check the CLI wallet with `solana address` before running it.

The LiteSVM integration test loads the devnet Metaplex program binary. Download this public executable once before running tests on a fresh checkout:

```sh
solana program dump metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s target/deploy/mpl_token_metadata.so --url devnet
```

The fixture lives under ignored build output. Tests cover unauthorized creation, substituted metadata addresses, actual Metaplex account creation, branding and update authority verification, mutability, and duplicate rejection. The pinned authority is modeled with test-only signature checking disabled; production still requires its signature. CLI tests separately verify real signatures using generated disposable keys.

## Individual matched wagers (v1)

`programs/token-vault/src/matching.rs` adds a separate market, immutable basketball questions, funded proposals, exact one-taker matching, cancellation, resolution/voiding, and independent payout/refund claims. Existing vault, metadata, and pooled-betting layouts and instruction signatures are unchanged. The market and questions require the configured Helius admin signature; each user signs their own token deposits and claims.

New instructions: `initialize_matching`, `create_question`, `propose_wager`, `match_wager`, `cancel_wager`, `claim_wager`, `resolve_question`, `expire_question`. PDA seeds are `matching_v1`; `question_v1, question_id.to_le_bytes()`; `wager_v1, question, maker, proposal_id.to_le_bytes()`; and `wager_escrow_v1, wager`. The global market pins one vault mint, and stakes are bounded to half `u64::MAX` so two stakes cannot overflow. Program accounts remain allocated to prevent replay/reinitialization; unsolicited token donations are not distributed.

Run `NO_DNA=1 anchor build`, `NO_DNA=1 cargo test --workspace`, then `cd web && npm run idl:sync && npm run test && npm run build`. Matching tests use LiteSVM with cryptographic signature verification disabled only to represent the Helius admin without holding its key; signer flags, authority checks, token transfers, and runtime account validation remain active. Original vault tests use real local test signatures.

Deployment and admin initialization are separate wallet-authorized steps. See [`web/docs/MATCHING_DEPLOYMENT.md`](web/docs/MATCHING_DEPLOYMENT.md).
