# Brobets web

Next.js App Router, TypeScript, Helius embedded wallets, PostgreSQL/Prisma, and a courtside basketball board. The Anchor workspace is unchanged.

## Run

```sh
cd web
npm ci
cp .env.example .env
npm run db:generate
npm run dev
```

Open http://localhost:3000. The board shows only published on-chain questions and wagers. Without configuration it displays setup guidance and an empty board. There are no sample games, local wager simulations, or browser-storage account data.

For the backend, set `DATABASE_URL` to a PostgreSQL database, then run `npm run db:migrate`. The checked-in initial migration creates challenges, sessions, question drafts, and transaction references.

## Helius and admin setup

1. Obtain Helius WaaS access on a paid Helius project. Enable email one-time codes in its WaaS configuration and register your app domain.
2. Set **server-only** `HELIUS_API_KEY`. Never prefix it with `NEXT_PUBLIC_`. The SDK uses `/api/helius/[...path]` for bootstrap and RPC.
3. Set `APP_ORIGIN` to the exact browser origin, e.g. `http://localhost:3000` or your deployed HTTPS origin.
4. The configured admin wallet is **`ERsc4ugZCfht4joqXWgVqtb222KUorwTuoD4Nc17wsB8`**, pinned in server-only `ADMIN_WALLET_ADDRESS`. Sign in to that wallet through Helius, then restart the server after any configuration change.
5. Use “Verify wallet for backend access.” Signing the single-use message establishes a one-day backend session. After matching initialization, the pinned wallet sees “Create question” and can publish on-chain questions. Arbitrary email fields and client roles cannot grant backend access.

Admin ownership is established by the operator pinning the wallet from the correct email account. The app does not trust the SDK's client-side email as a server-verified claim. Switching that pinned address deliberately transfers admin authority. Do not use the deterministic test wallet in real configuration.

Challenges expire after five minutes and are atomically deleted on verification, including invalid attempts. Sessions store a hash of a random token and use HTTP-only, SameSite=Strict cookies, Secure over production HTTPS. Mutations check the exact configured Origin. Run scheduled cleanup of expired Challenge and Session rows, and apply rate limits to auth and Helius proxy routes at your deployment edge before public launch.

## Vault trading

Set the public, **devnet** `NEXT_PUBLIC_USDC_MINT` to your intended six-decimal original SPL quote mint and `NEXT_PUBLIC_VAULT_PROGRAM_ID` to your initialized vault deployment. These are addresses, not secrets. The app derives the vault, reserve, and vault-token mint; it checks account ownership, decimals, reserve mint/authority, and vault-token mint authority.

The wallet panel reads SOL, USDC, and vault-token associated-account balances. Buy/redeem creates missing associated accounts idempotently, simulates the existing program's `buy`/`sell` transaction, and displays rate, network fee, rent, and fee payer before explicit signing. Submitted signatures are saved locally for recovery; uncertain confirmations instruct the user to inspect the signature before retrying. No trades or deployments were performed during implementation. Balances refresh after a confirmed trade and through the wallet panel’s refresh button.

The configured quote mint must be pinned intentionally: the vault permits any six-decimal original SPL mint, and a ticker cannot establish that it is Circle USDC.

## Matched-wager escrow

The matching program and frontend adapter are implemented. With Helius configured, the board reads confirmed on-chain questions, wagers, and escrow balances via `/api/market`; it never loads local sample data. Without Helius credentials it shows configuration guidance.

**The deployed program must be upgraded before new matching instructions can run.** Follow [MATCHING_DEPLOYMENT.md](docs/MATCHING_DEPLOYMENT.md). The app detects readiness by reading and validating the canonical `matching_v1` market account, not by an environment toggle. An uninitialized or old deployment shows a setup notice and no funded proposals. After upgrading, the configured Helius admin signs “Review initialization” once, then publishes questions and resolves results through the UI.

The admin wallet pinned on-chain is `ERsc4ugZCfht4joqXWgVqtb222KUorwTuoD4Nc17wsB8`; it must also match `ADMIN_WALLET_ADDRESS` on the server. Changing this admin requires a deliberate program upgrade. Question text, outcomes, and deadlines are immutable on-chain. The older pooled-betting instructions and account layouts remain compatible.

Users propose a side with a positive six-decimal stake; creation immediately deposits that amount. Another wallet matches the entire amount on the opposite side. Matching is atomic and has one taker. Only the proposer can cancel an unmatched wager. After close, the admin declares the winner or voids the question before the resolution deadline. The winner claims exactly both stakes. Voided or expired unresolved questions return each user's own stake independently; unmatched deposits are refundable after cutoff. No platform fee or partial matches.

Every action is simulated before the transaction review. Users explicitly approve a Helius signature before broadcast. Signed message bytes are checked against the reviewed transaction; the transaction signature is saved before submission, so uncertain sends can be recovered rather than repeated. The wallet panel's “Check pending betting transaction” reconciles confirmations, failures, and finalized blockhash expiry. Balances refresh after confirmation; the board polls confirmed chain state every 15 seconds and on focus.

Backend sessions are required before preparing wallet actions; the first action may request a sign-in message. `/api/escrow` only records confirmed matching transactions after checking the signed fee payer, canonical program/instruction, target question, and chain account state. Transaction references are supplemental: even if database recording fails after confirmation, the on-chain wager is authoritative and the UI reloads chain state. No server signs transactions or holds wallet keys.

## Checks

```sh
npm run test
npm run typecheck
npm run build
npx playwright install chromium
npm run test:e2e
```

Playwright covers live-board rendering with isolated server-response mocks, empty states, unavailable RPC/deployment states, signed-out funding restrictions, closed-question restrictions, search, details, dialogs, overflow, and automated axe accessibility checks. Local Solana VM and transaction-builder tests cover monetary transitions. API checks verify forged admin denial and cross-origin denial.

For database-backed API tests, use a **dedicated disposable database**, migrate it, and run:

```sh
DATABASE_URL='postgresql://USER@localhost:PORT/DISPOSABLE_DB' \
ADMIN_WALLET_ADDRESS='2iXtA8oeZqUU5pofxK971TCEvFGfems2AcDRaZHKD2pQ' \
BROBETS_TEST_DATABASE=1 npm run test:e2e
```

The deterministic test wallet is public test data, not a funded wallet. These tests cover concurrent replay attempts, expiration, signed sessions, admin draft authorization, deadline validation, and logout. They create and remove test question content and leave expired auth rows in the disposable database. Do not run against a production database.

Live Helius email delivery, funded devnet vault trades, and a full two-wallet devnet escrow run require the upgraded deployment and user wallet signatures. Local LiteSVM tests cover matching conflicts, both winning sides, cancellation, refunds, and invalid accounts. Automated accessibility checks supplement manual screen-reader and real-device review.

## Dependency notes

Helius wallet-kit currently requires Solana web3.js 1.x. Its dependency graph and the SPL-token/Prisma tooling graph contain upstream npm advisories (including high-severity `bigint-buffer` and `deepmerge-ts` entries at implementation time). Do not blindly apply `npm audit fix --force`, which proposes incompatible package downgrades. Recheck `npm audit` and upgrade compatible upstream releases before production use. The app has not received an independent security audit.

References: [Helius quickstart](https://www.helius.dev/docs/waas/quickstart), [email configuration](https://www.helius.dev/docs/waas/configuration).
