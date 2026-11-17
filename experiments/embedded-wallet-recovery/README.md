# Embedded wallet recovery feasibility checkpoint

Checked November 17, 2026 for [issue #1](https://github.com/alexnham/brobets/issues/1).

**Result: the existing email wallet works in the app, and its identity and
displayed balances persist after a page reload. Shielded-key recovery has not
been tested.** The encoding checks below concern a proposed shielded derivation
integration; they are not evidence that the working email-wallet recovery is
broken or needs replacement.

## Live app observation

On November 17, 2026, the user signed in through the existing Helius email flow
at localhost:3000. Browser inspection confirmed a connected devnet wallet with
nonzero SOL, USDC and vault-token balances. Reloading the page restored the same
full wallet address and all three displayed balances without another login.
No signature, trade, seed export, or app change was needed. Account identifiers
are deliberately omitted from this report.

This establishes successful login and session persistence. It does not establish
logout/relogin recovery, recovery after clearing browser data, a fresh browser,
or shielded/private funds access. The inspected panel displays public associated
token-account balances. Those additional cases were not exercised.

## What already exists

- Brobets uses Helius Wallet Kit email login on devnet, with a user-approved
  message signature for its separate server session (`web/components/brobets.tsx`).
- The installed wallet kit is 1.1.1, backed by Turnkey React Wallet Kit 1.11.1
  and Turnkey Core 1.14.1. npm's latest wallet-kit version was also 1.1.1 at this check.
- Helius documents dedicated embedded wallets under Turnkey sub-organizations,
  with signing initiated from the browser. This is an existing capability, not
  something this experiment needs to rebuild:
  [WaaS overview](https://www.helius.dev/docs/waas/overview).
- The app already verifies player signatures before adding sponsor signatures
  for allowed public wager transactions (`web/lib/sponsor.ts`). That does not
  by itself prove the equivalent boundary for shielded spending.

## Reproducible compatibility finding

From the repo root after installing the existing web dependencies:

```sh
node experiments/embedded-wallet-recovery/check-compatibility.mjs
node experiments/embedded-wallet-recovery/check-raw-payload.mjs
```

The script checks the installed SDK source chain and asserts the binary/text
mismatch. It makes no network calls, requests no signatures, reads no secrets,
and does not derive real user keys. `compatibility-results.json` records the
versions and inspected source hashes from the successful run.

The [documented shielded derivation](https://www.helius.dev/docs/privacy/integration/wallet)
uses an Ed25519 signature over the Solana off-chain v0 envelope containing
`TSPP/derive/v1`. That envelope begins with byte `0xff` and includes binary
domain and public-key fields. The signature supplies the derivation seed for
nullifier and viewing keys; recovering the same signing wallet and signing the
same exact bytes should reproduce those additional keys.

The installed `useHeliusWallet().signMessage` accepts a string and forwards
it through Turnkey's message approval modal. Turnkey Core converts that string
with `ethers.toUtf8Bytes` before signing. No UTF-8 string can encode a lone
`0xff` byte. Passing Latin-1 text, decoded UTF-8, hex text, or just the payload
would change what is signed. The public Helius hook does not expose a raw-byte
signing option or shielded key interface. See the
[public API reference](https://www.helius.dev/docs/waas/api-reference).

Separately, the full [embedded private wallet page](https://www.helius.dev/docs/privacy/integration/embedded-wallet)
explicitly labels that product as not live yet. Its capability table alone is
not evidence that the installed wallet kit exposes those features.

## Raw-byte path: locally verified, integration still unverified

Turnkey's [raw payload API](https://docs.turnkey.com/api-reference/activities/sign-raw-payload)
accepts hex-encoded bytes. For Ed25519, its
[hashing guidance](https://docs.turnkey.com/api-reference/overview/raw-payload-signing)
requires `HASH_FUNCTION_NOT_APPLICABLE`; pass the protocol message rather than
an ECDSA-style digest.

`check-raw-payload.mjs` exercises the installed Turnkey Core 1.14.1 HTTP client's
actual `signRawPayload` serialization with a mocked fetch and fake request
stamper. The successful run in `raw-payload-results.json` establishes:

- All 256 possible byte values survive hex serialization unchanged.
- The active session's user sub-organization takes precedence over the parent
  organization when no explicit organization override is supplied.
- The serialized request body matches what the request stamper receives.
- A simulated HTTP 403 policy denial rejects the call.

No real signature is generated. Mock success does not establish real project
permission, signature determinism, recovery, approval UX, private balance
access, or sponsor spending restrictions.

The Helius provider wraps Turnkey's provider, so its context is technically
reachable. However, Turnkey marks both `useTurnkey` and its context's
`httpClient` as `@internal`; `TurnkeySDKClientBase` is exported as a type, not a
runtime constructor, at the package root. This test imports the installed
generated client solely to inspect transport behavior. It is not a supported
Helius application integration. Raw signing also skips the existing
`handleSignMessage` approval modal. Nothing was wired into Brobets.

## Next gate and unverified behavior

Keep Helius as agreed. Establish a supported, user-approved signing path for
the exact derivation bytes, or supported native shielded-key provisioning and
recovery. The underlying raw-payload transport passes the local check above.
A supported Helius-facing binary signing API, explicit user approval, and the
project's actual access policies remain the gate. No provider contact was
authorized or sent. This finding does not require changing wallet providers
or exporting a seed.

After that prerequisite is met, test the same account through logout/login,
cleared site data, and a fresh browser; compare recovered shielded public
identity and access to a known private balance. Keep derivation signatures,
viewing/nullifier secrets and private associations out of logs and APIs.
Then test that viewing-only or sponsor-only authority cannot spend, and that
altered or missing player authorization fails on the real private route.

None of those additional recovery scenarios was run here. No signing, transactions, provider
contact, app integration, or issue updates were performed. Issue #1's recovery
criterion remains incomplete; this result supports reporting the agreed
compatibility blocker rather than adding an unverified recovery flow.
