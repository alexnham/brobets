# Local funding, redemption and withdrawal costs

Measured November 17, 2026; partial evidence for [issue #9](https://github.com/alexnham/brobets/issues/9).

**Tested exit funding: 0.00207928 SOL** for redeeming 10 BB, shielding the
10 USDC and withdrawing it to a new destination token account. That includes
2,039,280 lamports of destination rent, paid once. Omitting that separate
account-creation transaction for an existing destination models an exit cost
of **0.00003500 SOL**; the existing-account variant was not separately run.

The known fresh-user funding floor for the full tested journey is
**0.00822712 SOL**, including four token accounts and the measured
payer debits. This excludes private registration/enrollment, initial token
account creation transaction fees, hosted proving/relay, embedded signatures,
wagers, failed landed transactions, refunds and operational overhead. It is a
lower bound, not a sufficient production exit reserve or minimum-purchase policy.

## Measured transactions

The real-proof local test passed in 47.03 seconds. [results.json](results.json)
records hashes and local signatures; [cost-results.json](cost-results.json)
records the same run's measurements. Priority fee requested: zero.

| Action | Fee payer | Network fee (lamports) | Payer net debit (lamports) | Compute units |
|---|---|---:|---:|---:|
| external_payment | External sender | 5,000 | 5,000 | 76 |
| anonymous_deposit | Sponsor | 10,000 | 15,000 | 359,604 |
| bb_purchase | Sponsor | 10,000 | 15,000 | 452,330 |
| public_redemption | Sponsor | 10,000 | 10,000 | 18,805 |
| redemption_anonymous_deposit | Sponsor | 10,000 | 15,000 | 359,977 |
| cashout_ata_creation | Sponsor | 5,000 | 2,044,280 | 13,525 |
| private_withdrawal | Sponsor | 5,000 | 10,000 | 425,770 |

The first public payment's fee is paid by the external sender. Test setup funds
that sender and creates other accounts; that setup is not a production payment flow.

Sponsor network fees total 50,000 lamports. The sponsor's total transaction
debit is 2,109,280, including destination rent. Excluding that rent leaves
70,000 lamports of transaction-related sponsor debit. The four
5,000-lamport non-network debits are consistent with the pinned default tree
fee: [schedule](https://github.com/helius-labs/zolana/blob/b99ba45aa76029f8e89a4004725b9b3a6580a1ab/program-libs/interface/src/state/tree.rs),
[payer-to-tree collection](https://github.com/helius-labs/zolana/blob/b99ba45aa76029f8e89a4004725b9b3a6580a1ab/programs/shielded-pool/src/instructions/nullifier_pda/create.rs).
That attribution is inferred from source and net debits; receiving-tree balance
deltas were not separately recorded.

## Redemption and privacy boundaries

The real vault burns all 10 BB and pays 10 public USDC to the betting account.
A second sponsored, user-key-authorized transaction deposits it into the hidden
Ring identity. A later anonymous transaction withdraws 10 USDC to a new public ATA.
Final BB, reserve and private balances are zero; the canonical treasury retains
the 1 USDC purchase premium. No additional redemption percentage is charged.

This is **two-step redemption with a public intermediate balance**, not an atomic
private redemption. A failed second step would require recovery from that public
balance; that recovery is untested. The withdrawal shows the public destination,
asset and amount. Account-list checks exclude the betting and funding keys from
the withdrawal, but do not establish production unlinkability through all metadata.

## Rent still locked after exit

| Account | Allocation | Data bytes | Locked lamports |
|---|---|---:|---:|
| receiving_usdc | Per user | 165 | 2,039,280 |
| betting_usdc | Per user | 165 | 2,039,280 |
| betting_bb | Per user | 165 | 2,039,280 |
| cashout_usdc | Per user | 165 | 2,039,280 |
| canonical_treasury_usdc | Shared | 165 | 2,039,280 |
| reserve_usdc | Shared | 165 | 2,039,280 |
| vault | Shared | 73 | 1,398,960 |
| bb_mint | Shared | 82 | 1,461,600 |

The four per-user token accounts retain 8,157,120 lamports after exit,
including the funded cashout token account. Rent is a funded deposit, not a
burned fee; reclaiming it and who receives it were not tested. The listed shared
accounts retain 6,939,120 lamports once per isolated protocol instance.
Ring trees, enrollment and deployed program rent are not included.

No double counting: the 2,039,280-lamport destination rent is already in
the account-creation transaction debit. Thus the round-trip floor is
`initial three account rents + funding payer debits + all exit payer debits`
= `6,117,840 + 30,000 + 2,079,280 = 8,227,120` lamports.
The setup transaction fees for the initial three accounts remain excluded.

## Explicit price and usage assumptions

Each sample purchases 10 BB for 11 USDC, earns 1 USDC premium, then fully redeems
and withdraws. The 10 USDC reserve is an obligation, not income. These are
illustrative **USDC per SOL** assumptions, not market quotes. Formula:
`known SOL funding × assumed USDC/SOL`; rent counts as required SOL funding.

| Assumed USDC/SOL | New-user funding floor (USDC) | Exit, new destination | Round-trip floor | 1 USDC premium minus round-trip floor |
|---|---:|---:|---:|---:|
| 100 | 0.614784 | 0.207928 | 0.822712 | 0.177288 |
| 250 | 1.536960 | 0.519820 | 2.056780 | -1.056780 |
| 500 | 3.073920 | 1.039640 | 4.113560 | -3.113560 |
| 1000 | 6.147840 | 2.079280 | 8.227120 | -7.227120 |

Every column excludes the unmeasured costs above. Positive headroom does not
prove profitability, and USDC premium does not automatically replenish sponsor SOL.
At 250 USDC/SOL, the known round-trip funding alone exceeds the purchase premium.
If all listed user accounts already exist, omitting their creation transactions
models 0.00006500 SOL of funding-plus-exit debit. A fresh receiving
account for a later purchase adds rent plus an unmeasured creation fee; repeated
cashouts to new destinations add the measured ATA creation debit each time.
No account-reuse policy or activity limit is selected here.

## Timing and remaining budget evidence

- Funding deposit SDK proof + submission + indexing: 9,687 ms.
- Purchase SDK proof: 5,982 ms.
- Redemption deposit SDK proof + submission + indexing: 4,404 ms.
- Withdrawal SDK proof: 5,298 ms.

These are single local samples, not service SLAs or hosted proof prices. Negative
tests cover authority, rollback and replay but do not measure failed transactions
that land. Priority fees, relayer policies, capacity under load, refunds and
embedded approvals remain unmeasured. Ordinary email recovery is accepted as a
user assumption; shielded recovery is not newly verified.

Before enforcing budgets, add funded claim/refund/exit capacity with a margin
based on those measurements. Stop new activity before it consumes that capacity;
existing holders' exits must remain funded. New-wallet and transferred-BB
eligibility also need validation against account-creation subsidy abuse.
Issues #1 and #9 remain incomplete. No app pricing, limits or sponsor policy changed.
