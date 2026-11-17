//! Local-only no-connect ingress proof. Test keys stand in for distinct user wallets.
use super::*;
use solana_instruction::AccountMeta;
use zolana_ring_keys::ListSaltHolder;
const FUND: u64 = 11_000_000;
const COLLATERAL: u64 = 10_000_000;
const PREMIUM: u64 = 1_000_000;
/// Test-only SPL transfer (3) and mint_to (7) share this binary layout.
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

const VAULT_PROGRAM: &str = "AVnHeHrsjCdY55sygvLMmehrZHLBZknEZL1BnEPP5tKs";
// Anchor discriminators, sha256("global:<name>")[..8].
const INITIALIZE: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];
const BUY: [u8; 8] = [102, 6, 61, 18, 1, 218, 235, 234];
const SELL: [u8; 8] = [51, 230, 133, 164, 1, 127, 131, 173];

/// The suite has no hook to load another program at genesis, surfpool writes it directly.
fn set_account(env: &TestEnv, address: Address, fields: serde_json::Value) -> Result<()> {
    let request = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "surfnet_setAccount",
        "params": [address.to_string(), fields],
    });
    let reply: serde_json::Value = env.client.block_on(async {
        anyhow::Ok(
            reqwest::Client::new()
                .post(&env.rpc_url)
                .json(&request)
                .send()
                .await?
                .json()
                .await?,
        )
    })?;
    ensure!(
        reply.get("error").is_none(),
        "surfnet_setAccount refused {reply}"
    );
    Ok(())
}

#[test]
fn brobets_no_connect_payment_buys_bb() -> Result<()> {
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
    let vault_program: Address = VAULT_PROGRAM.parse()?;
    let program = std::fs::read(
        std::env::var("BROBETS_VAULT_SO")
            .context("set BROBETS_VAULT_SO to a reviewed local program build")?,
    )?;
    set_account(
        &env,
        vault_program,
        serde_json::json!({
            "lamports": rpc.get_minimum_balance_for_rent_exemption(program.len())?,
            "owner": "BPFLoader2111111111111111111111111111111111",
            "executable": true,
            "data": hex::encode(&program),
        }),
    )?;
    // The vault demands a 6-decimal quote mint, the suite's USDC mint is created with 9.
    let mut mint = fetch_account(rpc, &usdc)?.data;
    mint[44] = 6;
    set_account(
        &env,
        usdc,
        serde_json::json!({ "data": hex::encode(&mint) }),
    )?;
    let vault = Address::find_program_address(&[b"vault", usdc.as_ref()], &vault_program).0;
    let bb = Address::find_program_address(&[b"token", vault.as_ref()], &vault_program).0;
    let reserve = Address::find_program_address(&[b"reserve", vault.as_ref()], &vault_program).0;
    send(
        rpc,
        &env.payer,
        &[Instruction {
            program_id: vault_program,
            accounts: vec![
                AccountMeta::new(payer, true),
                AccountMeta::new_readonly(usdc, false),
                AccountMeta::new(vault, false),
                AccountMeta::new(bb, false),
                AccountMeta::new(reserve, false),
                AccountMeta::new_readonly(pda::spl_token_program_id(), false),
                AccountMeta::new_readonly(Address::default(), false),
            ],
            data: INITIALIZE.to_vec(),
        }],
    )?;
    let token =
        |owner: Address, mint: Address| create_token_account(rpc, &env.payer, &mint, &owner);
    let balance =
        |account: Address| -> Result<u64> { Ok(token_amount(&fetch_account(rpc, &account)?)) };
    let deposit = |from: &Keypair, user_token: Address, amount: u64| -> Result<(Signature, Utxo)> {
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
        Ok((signature, utxo))
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

    // 1. Ordinary external payment, with no Ring instruction or Brobets signer.
    let funder = env.funded_keypair()?;
    let funder_usdc = token(funder.pubkey(), usdc)?;
    mint_to(rpc, &env.payer, &usdc, &funder_usdc, FUND)?;
    let receiver = Keypair::new();
    let (_, receiver_usdc) = spr_test_utils::wallet::create_associated_token_account(
        rpc,
        &env.payer,
        &receiver.pubkey(),
        &usdc,
    )?;
    let incoming_ix = token_ix(3, FUND, funder_usdc, receiver_usdc, funder.pubkey());
    assert_eq!(incoming_ix.program_id, pda::spl_token_program_id());
    let incoming = send(rpc, &funder, &[incoming_ix])?;
    assert_eq!((balance(funder_usdc)?, balance(receiver_usdc)?), (0, FUND));
    // A sponsor's own signature cannot spend the receiving account's tokens.
    let unauthorized = ExpectRejection {
        payer: &env.payer,
        instructions: &[token_ix(3, FUND, receiver_usdc, funder_usdc, payer)],
    }
    .send(rpc)?;
    Rejection::custom(4).assert_client(&unauthorized); // SPL OwnerMismatch.
    assert_eq!(balance(receiver_usdc)?, FUND);
    // 2. The receiver authorizes shielding; the sponsor pays its fees.
    let deposit_started = std::time::Instant::now();
    let (shielded, funded) = deposit(&receiver, receiver_usdc, FUND)?;
    let deposit_wall_ms = deposit_started.elapsed().as_millis();
    assert_eq!(balance(receiver_usdc)?, 0);

    // 3. Purchase in one transaction: the hidden player exits collateral + premium to the
    //    betting wallet, which pays the public reserve and treasury and receives BB.
    let bettor = Keypair::new();
    let (_, bettor_usdc) = spr_test_utils::wallet::create_associated_token_account(
        rpc,
        &env.payer,
        &bettor.pubkey(),
        &usdc,
    )?;
    let bettor_bb = token(bettor.pubkey(), bb)?;
    let treasury_owner: Address = "ERsc4ugZCfht4joqXWgVqtb222KUorwTuoD4Nc17wsB8".parse()?;
    let (_, treasury) = spr_test_utils::wallet::create_associated_token_account(
        rpc,
        &env.payer,
        &treasury_owner,
        &usdc,
    )?;
    let trade = |tag: [u8; 8], amount: u64| Instruction {
        program_id: vault_program,
        accounts: vec![
            AccountMeta::new_readonly(bettor.pubkey(), true),
            AccountMeta::new_readonly(vault, false),
            AccountMeta::new_readonly(usdc, false),
            AccountMeta::new(bb, false),
            AccountMeta::new(reserve, false),
            AccountMeta::new(bettor_usdc, false),
            AccountMeta::new(bettor_bb, false),
            AccountMeta::new_readonly(pda::spl_token_program_id(), false),
            AccountMeta::new(treasury, false),
        ],
        data: [tag.as_slice(), &amount.to_le_bytes()].concat(),
    };
    let mut exit = ConfidentialTransaction::new_with_ring(
        vec![indexed_note(funded, player, &env, env.tree)?],
        payer,
        ring_program,
    )?;
    exit.withdraw(usdc, COLLATERAL + PREMIUM, bettor_usdc)?;
    let purchase_proof_started = std::time::Instant::now();
    let transact = env
        .run(
            anonymous(ring, player, exit, exit_accounts(bettor_usdc))
                .prove(env.client.ring_client()),
        )?
        .instruction()?;
    let purchase_proof_wall_ms = purchase_proof_started.elapsed().as_millis();
    assert!(
        transact
            .accounts
            .iter()
            .all(|meta| meta.pubkey != player.pubkey() && meta.pubkey != funder.pubkey()),
        "the purchase names neither the player nor the funder"
    );
    let tree_before = fetch_account(rpc, &env.tree)?;
    ExpectRejection {
        payer: &env.payer,
        instructions: &[
            transact.clone(),
            token_ix(7, COLLATERAL, usdc, bettor_bb, payer),
        ],
    }
    .send(rpc)?;
    assert_account_unchanged(rpc, &env.tree, &tree_before)?;
    let sponsored = SendAs {
        rpc,
        payer: &env.payer,
        holder: &bettor,
    };
    let purchase_ixs = [transact, trade(BUY, COLLATERAL)];
    let bought = sponsored.send(&purchase_ixs)?;
    println!("BROBETS reserve purchase {bought}");
    wait_for_indexed_transaction(env.client.indexer(), auditor_tag, bought);
    assert_eq!(
        (
            balance(reserve)?,
            balance(treasury)?,
            balance(bettor_bb)?,
            balance(bettor_usdc)?
        ),
        (COLLATERAL, PREMIUM, COLLATERAL, 0)
    );

    // A different transaction using the spent proof must fail on-chain, not
    // merely return the original purchase's cached signature or a transport error.
    let replay = send_expecting_rejection(rpc, &env.payer, purchase_ixs[0].clone())?;
    let spr_client::ClientError::SolanaRpcTransaction { source, .. } = &replay else {
        bail!("expected a transaction rejection, got {replay:?}");
    };
    ensure!(
        source.get_transaction_error().is_some(),
        "replay failed without a typed transaction error: {replay:?}"
    );
    assert_eq!(
        (balance(reserve)?, balance(treasury)?, balance(bettor_bb)?),
        (COLLATERAL, PREMIUM, COLLATERAL)
    );
    assert!(
        rpc.get_account(receiver.pubkey())?.is_none(),
        "receiver held no SOL"
    );
    assert!(
        rpc.get_account(bettor.pubkey())?.is_none(),
        "bettor held no SOL"
    );
    let mut wallet = RingWallet::new(player, env.ring_assets()?, ring_program);
    wallet.sync(&env)?;
    let amounts: Vec<_> = wallet.unspent().map(|note| note.utxo.amount).collect();
    assert_eq!(amounts.iter().sum::<u64>(), FUND - COLLATERAL - PREMIUM);
    // 4. Existing public-reserve redemption: sell first, then shield. This is
    // deliberately two transactions; the public intermediate balance is checked.
    let mut sell_ix = trade(SELL, COLLATERAL);
    sell_ix.accounts.pop(); // Sell has no treasury account or percentage fee.
    let sold = SendAs {
        rpc,
        payer: &env.payer,
        holder: &bettor,
    }
    .send(&[sell_ix])?;
    assert_eq!(
        (
            balance(reserve)?,
            balance(bettor_bb)?,
            balance(bettor_usdc)?
        ),
        (0, 0, COLLATERAL)
    );
    let redemption_deposit_started = std::time::Instant::now();
    let (redemption_deposit, redeemed) = deposit(&bettor, bettor_usdc, COLLATERAL)?;
    let redemption_deposit_wall_ms = redemption_deposit_started.elapsed().as_millis();
    assert_eq!(balance(bettor_usdc)?, 0);

    // 5. New public destination: sponsor pays for its ATA and anonymous exit.
    let cashout = Keypair::new();
    let (cashout_created, cashout_usdc) = spr_test_utils::wallet::create_associated_token_account(
        rpc,
        &env.payer,
        &cashout.pubkey(),
        &usdc,
    )?;
    let mut withdrawal = ConfidentialTransaction::new_with_ring(
        vec![indexed_note(redeemed, player, &env, env.tree)?],
        payer,
        ring_program,
    )?;
    withdrawal.withdraw(usdc, COLLATERAL, cashout_usdc)?;
    let withdrawal_proof_started = std::time::Instant::now();
    let withdrawal_ix = env
        .run(
            anonymous(ring, player, withdrawal, exit_accounts(cashout_usdc))
                .prove(env.client.ring_client()),
        )?
        .instruction()?;
    let withdrawal_proof_wall_ms = withdrawal_proof_started.elapsed().as_millis();
    let withdrawn = send(rpc, &env.payer, &[withdrawal_ix])?;
    wait_for_indexed_transaction(env.client.indexer(), auditor_tag, withdrawn);
    assert_eq!(
        (
            balance(cashout_usdc)?,
            balance(reserve)?,
            balance(treasury)?
        ),
        (COLLATERAL, 0, PREMIUM)
    );
    wallet.sync(&env)?;
    assert_eq!(
        wallet.unspent().map(|note| note.utxo.amount).sum::<u64>(),
        0
    );
    assert!(rpc.get_account(bettor.pubkey())?.is_none());
    assert!(rpc.get_account(cashout.pubkey())?.is_none());

    // Inspect landed public account lists, including address-table loaded keys.
    let transaction = |signature: Signature| -> Result<serde_json::Value> {
        let request = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"getTransaction",
            "params":[signature.to_string(), {"encoding":"json","commitment":"confirmed",
                "maxSupportedTransactionVersion":1}]});
        let reply: serde_json::Value = env.client.block_on(async {
            anyhow::Ok(
                reqwest::Client::new()
                    .post(&env.rpc_url)
                    .json(&request)
                    .send()
                    .await?
                    .json()
                    .await?,
            )
        })?;
        ensure!(
            reply.get("error").is_none(),
            "getTransaction failed: {reply}"
        );
        ensure!(!reply["result"].is_null(), "landed transaction missing");
        ensure!(
            reply["result"]["meta"]["err"].is_null(),
            "transaction failed"
        );
        Ok(reply["result"].clone())
    };
    let public_keys = |signature: Signature| -> Result<Vec<String>> {
        let result = transaction(signature)?;
        let keys = result["transaction"]["message"]["accountKeys"]
            .as_array()
            .context("landed transaction account keys missing")?;
        let mut keys: Vec<String> = keys
            .iter()
            .map(|key| {
                key.as_str()
                    .context("expected JSON account key")
                    .map(str::to_owned)
            })
            .collect::<Result<_>>()?;
        for kind in ["writable", "readonly"] {
            if let Some(loaded) = result["meta"]["loadedAddresses"][kind].as_array() {
                for key in loaded {
                    keys.push(key.as_str().context("loaded key")?.to_owned());
                }
            }
        }
        Ok(keys)
    };
    let incoming_keys = public_keys(incoming)?;
    assert!(!incoming_keys.contains(&bettor.pubkey().to_string()));
    let deposit_keys = public_keys(shielded)?;
    assert!(deposit_keys.contains(&receiver.pubkey().to_string()));
    assert!(!deposit_keys.contains(&bettor.pubkey().to_string()));
    assert!(!deposit_keys.contains(&bettor_usdc.to_string()));
    assert!(!deposit_keys.contains(&player.pubkey().to_string()));
    let purchase_keys = public_keys(bought)?;
    for excluded in [
        funder.pubkey(),
        funder_usdc,
        receiver.pubkey(),
        receiver_usdc,
        player.pubkey(),
    ] {
        assert!(
            !purchase_keys.contains(&excluded.to_string()),
            "purchase exposes {excluded}"
        );
    }
    let withdrawal_keys = public_keys(withdrawn)?;
    assert!(withdrawal_keys.contains(&cashout_usdc.to_string()));
    for excluded in [
        funder.pubkey(),
        receiver.pubkey(),
        bettor.pubkey(),
        bettor_usdc,
        player.pubkey(),
    ] {
        assert!(
            !withdrawal_keys.contains(&excluded.to_string()),
            "withdrawal names {excluded}"
        );
    }
    let mut transaction_costs = Vec::new();
    for (action, signature, sponsor_pays) in [
        ("external_payment", incoming, false),
        ("anonymous_deposit", shielded, true),
        ("bb_purchase", bought, true),
        ("public_redemption", sold, true),
        ("redemption_anonymous_deposit", redemption_deposit, true),
        ("cashout_ata_creation", cashout_created, true),
        ("private_withdrawal", withdrawn, true),
    ] {
        let tx = transaction(signature)?;
        let meta = &tx["meta"];
        let fee = meta["fee"].as_u64().context("fee metadata missing")?;
        let before = meta["preBalances"][0]
            .as_u64()
            .context("payer pre-balance missing")?;
        let after = meta["postBalances"][0]
            .as_u64()
            .context("payer post-balance missing")?;
        transaction_costs.push(serde_json::json!({
            "action": action, "sponsorPays": sponsor_pays,
            "feeLamports": fee,
            "computeUnitsConsumed": meta["computeUnitsConsumed"],
            "feePayerNetLamportsSpent": i64::try_from(before)? - i64::try_from(after)?,
        }));
    }
    let mut account_rent = Vec::new();
    for (role, address, per_user) in [
        ("receiving_usdc", receiver_usdc, true),
        ("betting_usdc", bettor_usdc, true),
        ("betting_bb", bettor_bb, true),
        ("cashout_usdc", cashout_usdc, true),
        ("canonical_treasury_usdc", treasury, false),
        ("reserve_usdc", reserve, false),
        ("vault", vault, false),
        ("bb_mint", bb, false),
    ] {
        let account = fetch_account(rpc, &address)?;
        let minimum = rpc.get_minimum_balance_for_rent_exemption(account.data.len())?;
        ensure!(account.lamports >= minimum, "account is not rent exempt");
        account_rent.push(serde_json::json!({
            "role": role, "perUser": per_user, "dataBytes": account.data.len(),
            "lockedLamports": account.lamports, "rentExemptMinimumLamports": minimum,
        }));
    }
    println!(
        "COST_EVIDENCE {}",
        serde_json::json!({
            "transactions": transaction_costs, "accountRent": account_rent,
            "depositSdkProofSubmissionIndexingWallMs": deposit_wall_ms,
            "purchaseSdkProofWallMs": purchase_proof_wall_ms,
            "redemptionDepositSdkProofSubmissionIndexingWallMs": redemption_deposit_wall_ms,
            "withdrawalSdkProofWallMs": withdrawal_proof_wall_ms,
            "priorityFeeRequestedLamports": 0,
            "hostedProverCost": null, "hostedRelayCost": null,
            "failedBroadcastFee": null, "privateRegistrationRent": null,
        })
    );
    println!("NO_CONNECT payment={incoming} deposit={shielded} purchase={bought}");
    println!("EXIT redemption={sold} deposit={redemption_deposit} ata={cashout_created} withdrawal={withdrawn}");
    println!("EXIT PASS 10 BB burned; 10 public USDC temporarily staged then shielded; 10 USDC withdrawn; reserve and BB zero; 1 USDC premium retained; bettor and destination hold zero SOL; withdrawal account separation");
    println!("NO_CONNECT PASS external SPL payment; receiver-only shielding; sponsored zero-SOL receiver/bettor; canonical 10+1 USDC purchase; sponsor theft rejected; replay rejected; public account separation");
    Ok(())
}
