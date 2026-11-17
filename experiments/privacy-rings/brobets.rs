//! Brobets feasibility (alexnham/brobets#1), not upstream code. One anonymous ring carries
//! USDC from an external funder to a hidden player, settles collateral + premium + BB mint
//! in one transaction, redeems BB into private USDC, and withdraws to a public account.

use solana_instruction::AccountMeta;
use spr_test_utils::spl::create_mint;
use zolana_ring_keys::ListSaltHolder;

use super::*;

const FUND: u64 = 22_000_000;
const COLLATERAL: u64 = 10_000_000;
const PREMIUM: u64 = COLLATERAL / 10;
const REDEEM: u64 = 4_000_000;
const WITHDRAW: u64 = 3_000_000;

/// SPL token mint_to (7) and burn (8) share one layout, `authority` signs.
fn token_ix(tag: u8, amount: u64, a: Address, b: Address, authority: Address) -> Instruction {
    let mut data = vec![tag];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: pda::spl_token_program_id(),
        accounts: vec![
            AccountMeta::new(a, false),
            AccountMeta::new(b, false),
            AccountMeta::new_readonly(authority, true),
        ],
        data,
    }
}

fn anonymous<'a>(
    ring: CustomRing,
    sender: &'a ShieldedKeypair,
    transaction: ConfidentialTransaction,
    exits: Vec<TransactInterfaceTransferAccounts>,
) -> AnonymousTransfer<'a> {
    CustomRingTransfer::new(CustomRingTransferInput {
        ring,
        sender,
        nullifier_key: Some(&sender.nullifier_key),
        transaction,
    })
    .with_interface_transfer_accounts(exits)
    .with_anonymous_signer(&sender.signing_key)
}

fn pay(to: &ShieldedKeypair, ring: Address, usdc: Mint, amount: u64) -> Result<custom_ring_sdk::AnonymousPayment> {
    Ok(custom_ring_sdk::AnonymousPayment {
        to: ring_address(to, ring)?,
        asset: usdc,
        amount,
        reply: None,
        data: custom_ring_sdk::NoteData::default(),
    })
}

fn usdc_notes(wallet: &RingWallet<'_>) -> Vec<u64> {
    let mut amounts: Vec<u64> = wallet.unspent().map(|held| held.utxo.amount).collect();
    amounts.sort_unstable();
    amounts
}

#[test]
fn brobets_private_usdc_buys_redeems_and_withdraws() -> Result<()> {
    let env = setup()?;
    let rpc = env.client.rpc();
    let ring_program = custom_ring_program_id()?;
    let ring = CustomRing::new(ring_program);
    let auditor = X25519Keypair::new();
    let auditor_tag = auditor_view_tag(&auditor.pubkey());
    RegisterRing {
        ring,
        payer: &env.payer,
        auditor_pubkey: auditor.pubkey(),
        tier: Tier::AnonymousAuditOnly,
    }
    .send(&env.client)?;
    let player = &env.sender.keypair;
    let vault = &env.recipient.keypair;
    let treasury = ShieldedKeypair::new_ed25519()?;
    EnrollOwners {
        ring,
        owners: &[player, vault, &treasury],
        env: &env,
    }
    .send()?;
    let usdc = env.usdc_mint;
    let usdc_asset = Mint::new(usdc, USDC_ASSET_ID);
    let payer = env.payer.pubkey();
    let indexed = |signature| {
        wait_for_indexed_transaction(env.client.indexer(), auditor_tag, signature);
    };

    // 1. Public ingress: an external funder's token account pays the player's hidden identity.
    let funder = env.funded_keypair()?;
    let funder_usdc = create_token_account(rpc, &env.payer, &usdc, &funder.pubkey())?;
    mint_to(rpc, &env.payer, &usdc, &funder_usdc, FUND)?;
    let deposited = RingNotes {
        ring,
        owner: player,
        amount: FUND,
        asset: DepositAsset::Spl(DepositSplAccounts {
            mint: usdc,
            user_token: funder_usdc,
            token_program: pda::spl_token_program_id(),
        }),
        count: 1,
        env: &env,
    }
    .deposit_hidden_from(&funder)?
    .remove(0);
    assert_eq!(token_amount(&fetch_account(rpc, &funder_usdc)?), 0);

    // 2. Purchase: collateral and premium leave the hidden player in one ring transact,
    //    the BB mint to the public betting wallet rides the same transaction.
    let bb = create_mint(rpc, &env.payer)?;
    let bettor = env.funded_keypair()?;
    let bettor_bb = create_token_account(rpc, &env.payer, &bb, &bettor.pubkey())?;
    let input = indexed_note(deposited, player, &env, env.tree)?;
    let purchase = anonymous(
        ring,
        player,
        ConfidentialTransaction::new_with_ring(vec![input], payer, ring_program)?,
        Vec::new(),
    )
    .with_payment(pay(vault, ring_program, usdc_asset, COLLATERAL)?)?
    .with_payment(pay(&treasury, ring_program, usdc_asset, PREMIUM)?)?
    .with_shape(canonical_shape(1, 3)?)?;
    let transact = env.run(purchase.prove(env.client.ring_client()))?.instruction()?;
    for hidden in [player.pubkey(), vault.pubkey(), treasury.pubkey(), funder.pubkey()] {
        assert!(
            transact.accounts.iter().all(|meta| meta.pubkey != hidden),
            "the purchase names no ring owner or the funder"
        );
    }
    //    A failing BB leg reverts the private payment: nothing is nullified or appended.
    let tree_before = fetch_account(rpc, &env.tree)?;
    ExpectRejection {
        payer: &env.payer,
        instructions: &[transact.clone(), token_ix(7, COLLATERAL, usdc, bettor_bb, payer)],
    }
    .send(rpc)?;
    assert_account_unchanged(rpc, &env.tree, &tree_before)?;
    let bought = send(rpc, &env.payer, &[transact, token_ix(7, COLLATERAL, bb, bettor_bb, payer)])?;
    println!("BROBETS purchase {bought}");
    indexed(bought);
    assert_eq!(token_amount(&fetch_account(rpc, &bettor_bb)?), COLLATERAL);

    let wallet = |keys| -> Result<RingWallet<'_>> {
        let mut wallet = RingWallet::new(keys, env.ring_assets()?, ring_program);
        wallet.sync(&env)?;
        Ok(wallet)
    };
    assert_eq!(usdc_notes(&wallet(vault)?), [COLLATERAL]);
    assert_eq!(usdc_notes(&wallet(&treasury)?), [PREMIUM]);
    assert_eq!(usdc_notes(&wallet(player)?), [FUND - COLLATERAL - PREMIUM]);

    // 3. Redemption: the betting wallet burns BB and the vault pays the hidden player
    //    private USDC in the same transaction, no public USDC account moves.
    let collateral = held_note(&wallet(vault)?, &env, COLLATERAL)?;
    let redemption = anonymous(
        ring,
        vault,
        ConfidentialTransaction::new_with_ring(vec![collateral], payer, ring_program)?,
        Vec::new(),
    )
    .with_payment(pay(player, ring_program, usdc_asset, REDEEM)?)?
    .with_shape(canonical_shape(1, 2)?)?;
    let transact = env.run(redemption.prove(env.client.ring_client()))?.instruction()?;
    let redeemed = SendAs {
        rpc,
        payer: &env.payer,
        holder: &bettor,
    }
    .send(&[transact, token_ix(8, REDEEM, bettor_bb, bb, bettor.pubkey())])?;
    println!("BROBETS redemption {redeemed}");
    indexed(redeemed);
    assert_eq!(token_amount(&fetch_account(rpc, &bettor_bb)?), COLLATERAL - REDEEM);
    assert_eq!(usdc_notes(&wallet(vault)?), [COLLATERAL - REDEEM]);
    let player_wallet = wallet(player)?;
    assert_eq!(usdc_notes(&player_wallet), [REDEEM, FUND - COLLATERAL - PREMIUM]);

    // 4. Withdrawal: the hidden player exits to a public token account it never signed for.
    let cashout = Keypair::new();
    let (_, cashout_usdc) = spr_test_utils::wallet::create_associated_token_account(
        rpc,
        &env.payer,
        &cashout.pubkey(),
        &usdc,
    )?;
    let mut exit = ConfidentialTransaction::new_with_ring(
        vec![held_note(&player_wallet, &env, REDEEM)?],
        payer,
        ring_program,
    )?;
    exit.withdraw(usdc, WITHDRAW, cashout_usdc)?;
    let exits = vec![TransactInterfaceTransferAccounts::SplWithdrawal(
        TransactSplWithdrawalAccounts {
            mint: usdc,
            spl_interface: pda::spl_interface(&usdc),
            user_token_account: cashout_usdc,
            token_program: pda::spl_token_program_id(),
        },
    )];
    let withdrawn = land(&env, anonymous(ring, player, exit, exits), &env.payer, &[])?;
    println!("BROBETS withdrawal {withdrawn}");
    indexed(withdrawn);
    assert_eq!(token_amount(&fetch_account(rpc, &cashout_usdc)?), WITHDRAW);
    assert_eq!(
        usdc_notes(&wallet(player)?),
        [REDEEM - WITHDRAW, FUND - COLLATERAL - PREMIUM]
    );
    Ok(())
}

/// Custody decision 2026-11-16: the reserve stays public. Raw SPL instructions stand in for
/// token-vault `buy` (user USDC -> reserve, mint BB) and `sell` (burn BB, reserve -> user USDC).
/// The betting wallet holds zero SOL throughout, the test payer sponsors every fee.
#[test]
fn brobets_public_reserve_buys_and_redeems_from_private_usdc() -> Result<()> {
    let env = setup()?;
    let rpc = env.client.rpc();
    let ring_program = custom_ring_program_id()?;
    let ring = CustomRing::new(ring_program);
    let auditor = X25519Keypair::new();
    let auditor_tag = auditor_view_tag(&auditor.pubkey());
    RegisterRing {
        ring,
        payer: &env.payer,
        auditor_pubkey: auditor.pubkey(),
        tier: Tier::AnonymousAuditOnly,
    }
    .send(&env.client)?;
    let player = &env.sender.keypair;
    EnrollOwners {
        ring,
        owners: &[player, &env.recipient.keypair],
        env: &env,
    }
    .send()?;
    let usdc = env.usdc_mint;
    let payer = env.payer.pubkey();
    let token = |owner: Address, mint: Address| create_token_account(rpc, &env.payer, &mint, &owner);
    let balance = |account: Address| -> Result<u64> { Ok(token_amount(&fetch_account(rpc, &account)?)) };
    let deposit = |from: &Keypair, user_token: Address, amount: u64| -> Result<Utxo> {
        let deposit = RingDeposit {
            ring,
            payer: from,
            recipient: DepositRecipient::Anonymous { keys: player },
            tree: env.tree,
            asset: DepositAsset::Spl(DepositSplAccounts {
                mint: usdc,
                user_token,
                token_program: pda::spl_token_program_id(),
            }),
            amount,
            cosigner: None,
            list_salt: player.list_salt(&ring_program).ok(),
        };
        let RingDepositReceipt { signature, utxo } =
            env.run(deposit.send_with_fee_payer(env.client.ring_client(), &env.payer))?;
        custom_ring_cli::wait_for_indexed_transaction(&env.client, signature)?;
        Ok(utxo)
    };
    let exit_accounts = |user_token_account| {
        vec![TransactInterfaceTransferAccounts::SplWithdrawal(
            TransactSplWithdrawalAccounts {
                mint: usdc,
                spl_interface: pda::spl_interface(&usdc),
                user_token_account,
                token_program: pda::spl_token_program_id(),
            },
        )]
    };

    // 1. Public ingress, as before.
    let funder = Keypair::new();
    let funder_usdc = token(funder.pubkey(), usdc)?;
    mint_to(rpc, &env.payer, &usdc, &funder_usdc, FUND)?;
    let funded = deposit(&funder, funder_usdc, FUND)?;

    // 2. Purchase in one transaction: the hidden player exits collateral + premium to the
    //    betting wallet, which pays the public reserve and treasury and receives BB.
    let bb = create_mint(rpc, &env.payer)?;
    let bettor = Keypair::new();
    let (_, bettor_usdc) = spr_test_utils::wallet::create_associated_token_account(
        rpc,
        &env.payer,
        &bettor.pubkey(),
        &usdc,
    )?;
    let bettor_bb = token(bettor.pubkey(), bb)?;
    let reserve = token(payer, usdc)?;
    let treasury = token(payer, usdc)?;
    let mut exit = ConfidentialTransaction::new_with_ring(
        vec![indexed_note(funded, player, &env, env.tree)?],
        payer,
        ring_program,
    )?;
    exit.withdraw(usdc, COLLATERAL + PREMIUM, bettor_usdc)?;
    let transact = env
        .run(anonymous(ring, player, exit, exit_accounts(bettor_usdc)).prove(env.client.ring_client()))?
        .instruction()?;
    assert!(
        transact.accounts.iter().all(|meta| meta.pubkey != player.pubkey() && meta.pubkey != funder.pubkey()),
        "the purchase names neither the player nor the funder"
    );
    let tree_before = fetch_account(rpc, &env.tree)?;
    ExpectRejection {
        payer: &env.payer,
        instructions: &[transact.clone(), token_ix(7, COLLATERAL, usdc, bettor_bb, payer)],
    }
    .send(rpc)?;
    assert_account_unchanged(rpc, &env.tree, &tree_before)?;
    let sponsored = SendAs {
        rpc,
        payer: &env.payer,
        holder: &bettor,
    };
    let bought = sponsored.send(&[
        transact,
        token_ix(3, COLLATERAL, bettor_usdc, reserve, bettor.pubkey()),
        token_ix(3, PREMIUM, bettor_usdc, treasury, bettor.pubkey()),
        token_ix(7, COLLATERAL, bb, bettor_bb, payer),
    ])?;
    println!("BROBETS reserve purchase {bought}");
    wait_for_indexed_transaction(env.client.indexer(), auditor_tag, bought);
    assert_eq!(
        (balance(reserve)?, balance(treasury)?, balance(bettor_bb)?, balance(bettor_usdc)?),
        (COLLATERAL, PREMIUM, COLLATERAL, 0)
    );

    // 3. Redemption: sell is public, then the betting wallet deposits the proceeds to the
    //    hidden player in a second transaction. That deposit names the betting wallet's account.
    let sponsored = SendAs {
        rpc,
        payer: &env.payer,
        holder: &bettor,
    };
    let sold = sponsored.send(&[
        token_ix(8, REDEEM, bettor_bb, bb, bettor.pubkey()),
        token_ix(3, REDEEM, reserve, bettor_usdc, payer),
    ])?;
    println!("BROBETS reserve sale {sold}");
    deposit(&bettor, bettor_usdc, REDEEM)?;
    assert_eq!(
        (balance(reserve)?, balance(bettor_bb)?, balance(bettor_usdc)?),
        (COLLATERAL - REDEEM, COLLATERAL - REDEEM, 0)
    );
    assert!(rpc.get_account(bettor.pubkey())?.is_none(), "the betting wallet never held SOL");
    let mut wallet = RingWallet::new(player, env.ring_assets()?, ring_program);
    wallet.sync(&env)?;
    assert_eq!(usdc_notes(&wallet), [REDEEM, FUND - COLLATERAL - PREMIUM]);
    Ok(())
}
