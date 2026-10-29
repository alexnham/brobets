# Matching escrow deployment

The implementation has been built and tested locally. This document is not proof of a devnet upgrade. Existing deployment addresses stay the same; no mainnet action is included.

## Review

- Network: Solana devnet.
- Program: `AVnHeHrsjCdY55sygvLMmehrZHLBZknEZL1BnEPP5tKs`.
- ProgramData: `JCnkbUMKsQVgoAhiuJ9n9o1kNKUnagNF7rK6FF5EMCQC`.
- Upgrade authority / fee payer: `GbDLTR4JK4EdZAtjXqAVDx3vWg2BwwEiESxsLqhDNEiG` (existing local CLI wallet).
- Matching admin: `ERsc4ugZCfht4joqXWgVqtb222KUorwTuoD4Nc17wsB8` (configured Helius email wallet).
- Tokens moved by the upgrade: none. SOL pays program storage and transaction fees.
- Current compiled program: 522,088 bytes. Devnet RPC estimated 2.65304524 SOL temporary upload-buffer rent and 0.74399648 SOL additional program storage at preparation time, plus network fees. Buffer funds are ordinarily recovered during upgrade; failed uploads may leave a buffer to inspect and close. Recheck balances, rent, binary size/hash, and authority immediately before approval.

## Build and verify

From the repository root:

```sh
NO_DNA=1 anchor build
NO_DNA=1 cargo test --workspace
cd web
npm run idl:sync
npm run test
npm run typecheck
npm run build
```

The web ABI is generated from the built Anchor IDL. Review `programs/token-vault/src/matching.rs`, `web/lib/matching.ts`, and the release manifest alongside test results before upgrading.

## Upgrade (requires wallet authorization)

After approval, from the repository root, with the existing CLI wallet configured and its public address confirmed as the upgrade authority:

```sh
NO_DNA=1 solana program deploy target/deploy/token_vault.so \
  --program-id AVnHeHrsjCdY55sygvLMmehrZHLBZknEZL1BnEPP5tKs \
  --url devnet --use-rpc --with-compute-unit-price 0
```

This command signs transactions and spends devnet SOL. Do not run it as a read-only check. Do not change the program ID, revoke upgrade authority, initialize a new vault, or transfer funds out of existing reserves. If deployment is interrupted, inspect its buffer and transaction signatures before restarting; do not print or share any buffer recovery seed shown by the CLI.

After completion, read back ProgramData, compare the deployed ELF bytes to the reviewed local artifact, record the confirmed signature/slot in `ADDRESSES.md`, and restart the built frontend.

## Initialize the market through Helius

1. Sign in to the app using the admin email wallet above. It needs devnet SOL for fees and rent; do not confuse the CLI upgrade wallet with this embedded wallet.
2. Click “Review initialization.” The app verifies the backend wallet session, constructs `initialize_matching`, and simulates it on devnet.
3. Review the fee payer, rent, cluster, and account address. Approve the wallet signature to create the canonical market account.
4. Confirm `/api/market` reports `ready: true` and its admin, vault, mint, and version match the expected deployment.
5. Publish an actual basketball question. Only published on-chain questions appear on the board.

## Two-wallet devnet acceptance

With separate Helius user wallets funded with test SOL and Brobets tokens, propose 5 tokens, match exactly 5 from the opposite side, resolve after cutoff, and claim 10 as the winner. Read token accounts and escrow balances after every confirmation. Exercise both winning sides, unmatched cancellation, void and deadline refunds, and confirmation recovery. Submit two taker transactions against one proposal and confirm only one taker's stake moves. Check unauthorized publication/resolution and duplicate claims fail.

The agent's local tests do not substitute for this wallet-authorized devnet run. No wagers should be represented as tested on devnet until their actual signatures and balances are recorded.
