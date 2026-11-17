# Privacy Rings feasibility checkpoint

Stopped at the user's request on November 16, 2026. Ticket: https://github.com/alexnham/brobets/issues/1.

## Completed

- Isolated managed worktree and `codex/private-funding-feasibility` branch.
- Installed `@heliuslabs/spr@0.9.0-alpha` and `@solana/kit@8.3.0` here only (`npm ci --ignore-scripts --no-audit --no-fund` restores dependencies).
- Read-only devnet RPC, privacy program, registry, state tree and indexer checks succeeded using existing server configuration; no credentials were copied into this worktree or saved in evidence.
- Read-only protocol config decoding reported permissionless Ring activation and SPL-interface creation. Four activated Ring configs were observed. This is not proof that those Rings support our anonymous flow.
- Official SDK `SprClient.attestProver` succeeded with `SignedTeePolicy.forNetwork("devnet")`; AWS Nitro attestation was verified. `checkProverProvingKeys` succeeded for 136 catalogue entries over the attested channel.
- Public custom-Ring source and a concrete local anonymous-transfer test recipe were found; see the source findings document.

The JSON files contain sanitized results from ad-hoc read-only probes, not a reusable probe runner. They contain no API keys, user private state, or cryptographic secrets. Key-catalogue readiness does not prove proof generation or on-chain anonymous settlement. The confidential-only optional runtime key-set metadata must not be mistaken for absence of pinned anonymous circuits.

## Not done

No transactions signed, simulated, or sent; no wallets created; no new Ring deployed; no anonymous proof generated; no local validator/prover stack started; no USDC/BB purchase or redemption flow tested. Brobets app code, contracts, and runtime dependencies were not changed. Ticket #1 remains incomplete. No GitHub issue/comment changes were made during this feasibility pass.

## Claude pickup, 2026-11-16

- Cloned `custom-privacy-rings` at `cc21e14` (submodule `zolana` at `b99ba45`, both matching the pins) to `../../../custom-privacy-rings` (beside this worktree, outside the repo).
- Installed `just` 1.59.0 and arm64 Go 1.27.4 with Homebrew (`/opt/homebrew/bin`; the old `/usr/local/bin/go` is amd64 1.23 and too old for the prover's `go 1.27.3`).
- Download sizing: 26 custom-ring keys, 3.9 GiB, plus two SPP transfer keys. The full SPP key set (84 GiB) is not needed for this test.
- Ran on a local validator with real proofs (`--features proofs`), all passing:
  - upstream `a_relayed_anonymous_payment_reaches_its_recipient`
  - upstream `an_anonymous_ring_hides_owners_and_preserves_auditor_access`
  - upstream `usdc_crosses_the_ring_boundary_and_withdraws_through_a_ring_transact`
  - ours, `brobets_private_usdc_buys_redeems_and_withdraws` (`brobets.rs` here)
  - ours, `brobets_public_reserve_buys_and_redeems_from_private_usdc` (same file, matches the custody decision)
- Results and go/no-go: `web/docs/PRIVATE_FUNDING_FEASIBILITY_REPORT.md`.

To rerun ours: copy `brobets.rs` to `program-tests/custom-ring/tests/ring/` in the clone, add `#[path = "ring/brobets.rs"] mod brobets;` to `program-tests/custom-ring/tests/ring.rs`, then

  `PATH=/opt/homebrew/bin:$PATH just test-custom-ring-validator 'test(brobets_private_usdc_buys_redeems_and_withdraws)' --features proofs`

Still nothing signed or sent on devnet. Codex's "Not done" section above and "Resume here" below are superseded by the report.

## Resume here

1. Read `web/docs/PRIVATE_FUNDING_SOURCE_FINDINGS.md` for pinned public repositories and their compatibility requirements.
2. Prepare the custom repo's narrow local validator test for a relayed anonymous payment, using its pinned submodule/toolchain and proving keys. Review disk/build requirements before starting; around 45 GiB was free at checkpoint.
3. Run the local anonymous-transfer experiment and inspect its actual on-chain visibility; then extend to an SPL test mint and evaluate the USDC/BB backing/premium/redemption integration.
4. Keep embedded-wallet shielded-key recovery, no-connect ingress, source-link protection, and hosted custom-Ring RPC/relay access explicitly unverified until tested.
5. Before any real devnet signing/broadcast, prepare and simulate the concrete transaction and obtain wallet approval with cluster, fee payer, accounts, amounts, and fees displayed.

Existing instructions and prior feature notes were copied into this worktree because they were uncommitted in the original checkout. Their originals remain untouched. Credentials stay in the original server config and must never be printed or committed.
