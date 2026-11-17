# No-connect USDC funding proof

Local experiment for [issue #1](https://github.com/alexnham/brobets/issues/1).
**Passed November 17, 2026:** latest real-proof local test, 47.03 seconds.
`results.json` records the source pins, binary/fixture hashes, local signatures
and assertions; `test-output.txt` contains the sanitized test result. This does
not change the app or establish a working hosted payment service.

The same run now records fee payer debits, compute units, token-account rent
and local proof timings. See [the cost baseline](COSTS.md) and its explicit
price/usage assumptions; unmeasured hosted and lifecycle costs remain excluded.

The agreed route is an ordinary external USDC transfer to a **separate
user-controlled receiving wallet**, followed by a user-approved anonymous Ring
deposit and a sponsored BB purchase. The receiving key, private identity and
betting key are distinct. No company key owns the user's transit funds.

```text
external sender --11 public USDC--> receiving token account
receiving owner + sponsor -------> anonymous Ring (hidden private recipient)
private owner + betting owner + sponsor
    --> Ring withdrawal + buy in one transaction
    --> 10 USDC reserve + 1 USDC canonical treasury + 10 BB betting wallet
betting owner + sponsor --> burn 10 BB, receive 10 public USDC
betting owner + sponsor --> deposit 10 USDC to hidden Ring identity
private owner + sponsor --> withdraw 10 USDC to a new public destination ATA
```

`no_connect.rs` extends the existing pinned custom-Ring validator harness. It
uses local test keys in place of the three user wallet keys; it does not
integrate or prove Helius email-wallet provisioning of those separate keys.
Ordinary email-wallet recovery is an accepted user assumption, not new evidence
of shielded-key recovery.

## Checks

- External payment is an ordinary SPL transfer, signed and fee-paid by the
  external sender. It needs no Ring instruction or Brobets connection.
- The receiving owner authorizes the Ring deposit; a separate sponsor pays.
  A sponsor-only attempt to transfer the receiving account's tokens fails.
- The real token-vault program enforces the purchase premium and canonical
  treasury. Reserve, treasury, BB and public-USDC balances are checked.
- A failing companion instruction rolls back the private proof. Reusing the
  spent purchase proof cannot mint a second batch of BB.
- Receiving and betting wallets never have a SOL account. The sponsor creates
  required token accounts and pays the deposit and purchase fees.
- Landed transaction account lists, including loaded addresses, are inspected:
  the deposit must not name the betting wallet; the purchase must not name the
  source, receiving wallet/token account or private owner.
- Full redemption returns 10 USDC for 10 BB; the separate shielding step and
  final withdrawal are sponsored. The cashout destination's ATA is sponsored,
  and neither its owner nor the betting wallet holds SOL.
- The landed withdrawal names its destination token account but not the
  betting wallet, receiving wallet, funder or private owner.

All checks above passed. After purchase the reserve holds 10 test USDC and the
betting wallet holds 10 BB. After full exit those balances and the private
balance are zero; the public cashout account holds 10 USDC and the canonical
treasury retains the original 1 USDC premium. No extra BB is issued by replay.

## Reproduce

Use `helius-labs/custom-privacy-rings` at
`cc21e141c65e845e61dca3418f2b1be3815f51f7` with its `zolana` submodule at
`b99ba45aa76029f8e89a4004725b9b3a6580a1ab`. Follow its local build/key setup.
Copy `no_connect.rs` to `program-tests/custom-ring/tests/ring/no_connect.rs`
and add the following to `program-tests/custom-ring/tests/ring.rs`:

```rust
#[path = "ring/no_connect.rs"]
mod no_connect;
```

From that clone, using a reviewed current Brobets program build:

```sh
export BROBETS_VAULT_SO=/absolute/path/to/Brobets/target/deploy/token_vault.so
NO_DNA=1 just test-custom-ring-validator 'test(brobets_no_connect_payment_buys_bb)' --features proofs
```

The test loads that binary using a Surfpool cheatcode, not a real deployment.
It also patches the suite's test-USDC mint from nine to six decimals. This is
test USDC, not Circle-issued USDC. Use only a local isolated harness.

## Limits

The public sender, receiving account, USDC amount and deposit timing remain
visible. The public purchase exposes the betting wallet and exact reserve and
premium movements. Account-list separation alone does not rule out linkage
through logs, instruction data, funding/setup transactions, timing or amounts.
The fixture sponsor funds test setup, so its setup is not an anonymity set.
This is a narrow mechanics test, not proof of production unlinkability.
Redemption uses two transactions and temporarily credits public USDC to the
betting account; atomic private redemption and recovery from an interrupted
shielding step were not tested. Local destination-creation costs are measured,
but existing-destination costs are modeled by omitting that transaction.

Hosted anonymous-Ring availability, separate user-key provisioning, embedded
approval UX, relayer policy, payment reconciliation, exchange withdrawals and
safe refunds remain outside this test. A local key's signature does not prove
an embedded user approved it. No default confidential-Ring fallback or
app-controlled transit balance is introduced.
