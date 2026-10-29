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

Open http://localhost:3000. The board works without credentials or a database. It is explicitly a **demo court**: sample questions and wagers live in browser session storage, with no funds or wallet signatures involved. Reloading restores the demo; “Reset demo” restores the initial fixtures. Demo admin controls have no server authority.

For the backend, set `DATABASE_URL` to a PostgreSQL database, then run `npm run db:migrate`. The checked-in initial migration creates challenges, sessions, question drafts, and transaction references.

## Helius and admin setup

1. Obtain Helius WaaS access on a paid Helius project. Enable email one-time codes in its WaaS configuration and register your app domain.
2. Set **server-only** `HELIUS_API_KEY`. Never prefix it with `NEXT_PUBLIC_`. The SDK uses `/api/helius/[...path]` for bootstrap and RPC.
3. Set `APP_ORIGIN` to the exact browser origin, e.g. `http://localhost:3000` or your deployed HTTPS origin.
4. Sign in through Helius using **alexnham11@gmail.com**. Copy the resulting embedded wallet's address from the wallet panel into **server-only** `ADMIN_WALLET_ADDRESS`, then restart.
5. Use “Verify wallet for backend access.” Signing the single-use message establishes a one-day backend session. The pinned wallet sees “Create question” and can save database drafts. Arbitrary email fields, client roles, and demo admin controls cannot grant backend access.

Admin ownership is established by the operator pinning the wallet from the correct email account. The app does not trust the SDK's client-side email as a server-verified claim. Switching that pinned address deliberately transfers admin authority. Do not use the deterministic test wallet in real configuration.

Challenges expire after five minutes and are atomically deleted on verification, including invalid attempts. Sessions store a hash of a random token and use HTTP-only, SameSite=Strict cookies, Secure over production HTTPS. Mutations check the exact configured Origin. Run scheduled cleanup of expired Challenge and Session rows, and apply rate limits to auth and Helius proxy routes at your deployment edge before public launch.

## Vault trading

Set the public, **devnet** `NEXT_PUBLIC_USDC_MINT` to your intended six-decimal original SPL quote mint and `NEXT_PUBLIC_VAULT_PROGRAM_ID` to your initialized vault deployment. These are addresses, not secrets. The app derives the vault, reserve, and vault-token mint; it checks account ownership, decimals, reserve mint/authority, and vault-token mint authority.

The wallet panel reads SOL, USDC, and vault-token associated-account balances. Buy/redeem creates missing associated accounts idempotently, simulates the existing program's `buy`/`sell` transaction, and displays rate, network fee, rent, and fee payer before explicit signing. Submitted signatures are saved locally for recovery; uncertain confirmations instruct the user to inspect the signature before retrying. No trades or deployments were performed during implementation. Balances refresh when the wallet panel is reopened after a confirmed trade.

The configured quote mint must be pinned intentionally: the vault permits any six-decimal original SPL mint, and a ticker cannot establish that it is Circle USDC.

## Matching escrow integration status

**Real wager funding and publishing are disabled.** `/api/escrow` fails closed with HTTP 503. A valid transaction signature supplied by a browser does not enable funding. No chain verification or matching settlement is fabricated.

The current Anchor program pools stakes, permits top-ups, and pays proportionally. It cannot implement exact peer matching, cancellation, or explicit voiding. The other builder must provide the matching contract described in [ESCROW_HANDOFF.md](docs/ESCROW_HANDOFF.md). `lib/escrow.ts` defines the frontend boundary; `MATCHING_ESCROW_CONNECTED` is false. Adding environment variables alone never enables matching.

The demo supports equal full stakes, opposite sides, no self-matching, cancellation, winning claims, void refunds, deadline refunds, and resolution after close. Demo transitions are UI simulations, **not proof of on-chain concurrency guarantees**. The board remains a demo even when Helius is configured; wallet operations are separately labeled devnet transactions. Database question drafts are stored separately from demo fixtures.

## Checks

```sh
npm run test
npm run typecheck
npm run build
npx playwright install chromium
npm run test:e2e
```

Playwright covers desktop/mobile flows, proposal validation, matching, persisted demo state, cancellation, claims, rejection, admin deadline controls, dialogs, overflow, and automated axe accessibility checks. API checks verify fail-closed funding, forged admin denial, and cross-origin denial without a database.

For database-backed API tests, use a **dedicated disposable database**, migrate it, and run:

```sh
DATABASE_URL='postgresql://USER@localhost:PORT/DISPOSABLE_DB' \
ADMIN_WALLET_ADDRESS='2iXtA8oeZqUU5pofxK971TCEvFGfems2AcDRaZHKD2pQ' \
BROBETS_TEST_DATABASE=1 npm run test:e2e
```

The deterministic test wallet is public test data, not a funded wallet. These tests cover concurrent replay attempts, expiration, signed sessions, admin draft authorization, deadline validation, and logout. They create and remove test question content and leave expired auth rows in the disposable database. Do not run against a production database.

Live Helius email delivery, funded devnet vault trades, and matched escrow concurrency require external credentials/deployments and remain integration checks. Automated accessibility checks supplement manual screen-reader and real-device review.

## Dependency notes

Helius wallet-kit currently requires Solana web3.js 1.x. Its dependency graph and the SPL-token/Prisma tooling graph contain upstream npm advisories (including high-severity `bigint-buffer` and `deepmerge-ts` entries at implementation time). Do not blindly apply `npm audit fix --force`, which proposes incompatible package downgrades. Recheck `npm audit` and upgrade compatible upstream releases before production use. The app has not received an independent security audit.

References: [Helius quickstart](https://www.helius.dev/docs/waas/quickstart), [email configuration](https://www.helius.dev/docs/waas/configuration).
