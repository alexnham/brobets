use anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use token_vault::{accounts, instruction};

fn address(key: anchor_lang::prelude::Pubkey) -> Address {
    Address::new_from_array(key.to_bytes())
}
fn pubkey(key: Address) -> anchor_lang::prelude::Pubkey {
    anchor_lang::prelude::Pubkey::new_from_array(key.to_bytes())
}
fn ix(metas: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction {
        program_id: address(token_vault::ID),
        accounts: metas
            .to_account_metas(None)
            .into_iter()
            .map(|m| AccountMeta {
                pubkey: address(m.pubkey),
                is_signer: m.is_signer,
                is_writable: m.is_writable,
            })
            .collect(),
        data: data.data(),
    }
}
fn send(svm: &mut LiteSVM, user: &Keypair, instruction: Instruction) -> bool {
    svm.expire_blockhash();
    svm.send_transaction(Transaction::new_signed_with_payer(
        &[instruction],
        Some(&user.pubkey()),
        &[user],
        svm.latest_blockhash(),
    ))
    .is_ok()
}
fn token_account(svm: &mut LiteSVM, key: Address, mint: Address, owner: Address, amount: u64) {
    let mut data = vec![0; 165];
    data[..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1;
    svm.set_account(
        key,
        Account {
            lamports: 10_000_000,
            data,
            owner: address(anchor_spl::token::ID),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}
fn balance(svm: &LiteSVM, key: Address) -> u64 {
    u64::from_le_bytes(
        svm.get_account(&key).unwrap().data[64..72]
            .try_into()
            .unwrap(),
    )
}

#[test]
fn trades_and_invalid_accounts_are_atomic() {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(
        address(token_vault::ID),
        "../../target/deploy/token_vault.so",
    )
    .unwrap();
    let user = Keypair::new();
    svm.airdrop(&user.pubkey(), 1_000_000_000).unwrap();
    let quote = Address::new_unique();
    let mut mint_data = vec![0; 82];
    mint_data[36..44].copy_from_slice(&10_000_000_u64.to_le_bytes());
    mint_data[44] = 6;
    mint_data[45] = 1;
    svm.set_account(
        quote,
        Account {
            lamports: 10_000_000,
            data: mint_data,
            owner: address(anchor_spl::token::ID),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    let (vault, _) = anchor_lang::prelude::Pubkey::find_program_address(
        &[b"vault", quote.as_ref()],
        &token_vault::ID,
    );
    let (mint, _) = anchor_lang::prelude::Pubkey::find_program_address(
        &[b"token", vault.as_ref()],
        &token_vault::ID,
    );
    let (reserve, _) = anchor_lang::prelude::Pubkey::find_program_address(
        &[b"reserve", vault.as_ref()],
        &token_vault::ID,
    );
    let init = accounts::Initialize {
        payer: pubkey(user.pubkey()),
        usdc_mint: pubkey(quote),
        vault,
        token_mint: mint,
        reserve,
        token_program: anchor_spl::token::ID,
        system_program: anchor_lang::system_program::ID,
    };
    assert!(send(&mut svm, &user, ix(init, instruction::Initialize {})));
    let user_usdc = Address::new_unique();
    let user_token = Address::new_unique();
    token_account(&mut svm, user_usdc, quote, user.pubkey(), 10_000_000);
    token_account(&mut svm, user_token, address(mint), user.pubkey(), 0);
    let trade = || accounts::Trade {
        user: pubkey(user.pubkey()),
        vault,
        usdc_mint: pubkey(quote),
        token_mint: mint,
        reserve,
        user_usdc: pubkey(user_usdc),
        user_token: pubkey(user_token),
        token_program: anchor_spl::token::ID,
    };
    assert!(!send(
        &mut svm,
        &user,
        ix(trade(), instruction::Buy { amount: 0 })
    ));
    assert!(!send(
        &mut svm,
        &user,
        ix(trade(), instruction::Buy { amount: 10_000_001 })
    ));
    assert_eq!(balance(&svm, user_usdc), 10_000_000);
    assert!(send(
        &mut svm,
        &user,
        ix(trade(), instruction::Buy { amount: 2_500_001 })
    ));
    assert_eq!(balance(&svm, user_usdc), 7_499_999);
    assert_eq!(balance(&svm, user_token), 2_500_001);
    assert_eq!(balance(&svm, address(reserve)), 2_500_001);
    let empty_token = Address::new_unique();
    token_account(&mut svm, empty_token, address(mint), user.pubkey(), 0);
    let mut bad = trade();
    bad.user_token = pubkey(empty_token);
    assert!(!send(
        &mut svm,
        &user,
        ix(bad, instruction::Sell { amount: 1 })
    ));
    assert_eq!(balance(&svm, address(reserve)), 2_500_001);
    assert_eq!(balance(&svm, user_token), 2_500_001);
    let wrong = Address::new_unique();
    token_account(&mut svm, wrong, quote, Address::new_unique(), 10_000_000);
    let mut bad = trade();
    bad.user_usdc = pubkey(wrong);
    assert!(!send(
        &mut svm,
        &user,
        ix(bad, instruction::Buy { amount: 1 })
    ));
    let mut bad = trade();
    bad.user_token = pubkey(user_usdc);
    assert!(!send(
        &mut svm,
        &user,
        ix(bad, instruction::Buy { amount: 1 })
    ));
    let mut bad = trade();
    bad.reserve = pubkey(user_usdc);
    assert!(!send(
        &mut svm,
        &user,
        ix(bad, instruction::Sell { amount: 1 })
    ));
    assert!(!send(
        &mut svm,
        &user,
        ix(trade(), instruction::Sell { amount: 2_500_002 })
    ));
    assert!(send(
        &mut svm,
        &user,
        ix(trade(), instruction::Sell { amount: 2_500_001 })
    ));
    assert_eq!(balance(&svm, user_usdc), 10_000_000);
    assert_eq!(balance(&svm, user_token), 0);
    assert_eq!(balance(&svm, address(reserve)), 0);
    let supply = u64::from_le_bytes(
        svm.get_account(&address(mint)).unwrap().data[36..44]
            .try_into()
            .unwrap(),
    );
    assert_eq!(supply, 0);
    // Escrow is independent of the USDC reserve and only accepts this vault token.
    assert!(send(
        &mut svm,
        &user,
        ix(trade(), instruction::Buy { amount: 10_000_000 })
    ));
    let other = Keypair::new();
    svm.airdrop(&other.pubkey(), 1_000_000_000).unwrap();
    let other_token = Address::new_unique();
    token_account(
        &mut svm,
        other_token,
        address(mint),
        other.pubkey(),
        10_000_000,
    );
    let start = svm.get_sysvar::<solana_clock::Clock>().unix_timestamp;
    for bet_id in 0_u64..3 {
        let (bet, _) = anchor_lang::prelude::Pubkey::find_program_address(
            &[b"bet", user.pubkey().as_ref(), &bet_id.to_le_bytes()],
            &token_vault::ID,
        );
        let (escrow, _) = anchor_lang::prelude::Pubkey::find_program_address(
            &[b"escrow", bet.as_ref()],
            &token_vault::ID,
        );
        let closes_at = start + 100 + bet_id as i64 * 100;
        let resolve_by = closes_at + 50;
        assert!(send(
            &mut svm,
            &user,
            ix(
                accounts::CreateBet {
                    oracle: pubkey(user.pubkey()),
                    vault,
                    token_mint: mint,
                    bet,
                    escrow,
                    token_program: anchor_spl::token::ID,
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::CreateBet {
                    bet_id,
                    closes_at,
                    resolve_by
                }
            )
        ));
        let position_for = |who: Address| {
            anchor_lang::prelude::Pubkey::find_program_address(
                &[b"position", bet.as_ref(), who.as_ref()],
                &token_vault::ID,
            )
            .0
        };
        let place = |who: Address, account: Address| accounts::PlaceBet {
            user: pubkey(who),
            bet,
            token_mint: mint,
            position: position_for(who),
            escrow,
            user_token: pubkey(account),
            token_program: anchor_spl::token::ID,
        };
        let claim = |who: Address, account: Address| accounts::Claim {
            user: pubkey(who),
            bet,
            token_mint: mint,
            position: position_for(who),
            escrow,
            user_token: pubkey(account),
            token_program: anchor_spl::token::ID,
        };
        for who in [&user, &other] {
            assert!(send(
                &mut svm,
                who,
                ix(
                    accounts::OpenPosition {
                        user: pubkey(who.pubkey()),
                        bet,
                        position: position_for(who.pubkey()),
                        system_program: anchor_lang::system_program::ID,
                    },
                    instruction::OpenPosition {}
                )
            ));
        }
        let before_user = balance(&svm, user_token);
        let before_other = balance(&svm, other_token);
        assert!(!send(
            &mut svm,
            &user,
            ix(
                place(user.pubkey(), user_token),
                instruction::PlaceBet { side: 3, amount: 1 }
            )
        ));
        assert!(send(
            &mut svm,
            &user,
            ix(
                place(user.pubkey(), user_token),
                instruction::PlaceBet {
                    side: 1,
                    amount: 2_000_000
                }
            )
        ));
        assert!(send(
            &mut svm,
            &other,
            ix(
                place(other.pubkey(), other_token),
                instruction::PlaceBet {
                    side: 1,
                    amount: 1_000_000
                }
            )
        ));
        if bet_id == 0 {
            assert!(send(
                &mut svm,
                &user,
                ix(
                    place(user.pubkey(), user_token),
                    instruction::PlaceBet {
                        side: 2,
                        amount: 3_000_000
                    }
                )
            ));
        }
        assert!(!send(
            &mut svm,
            &user,
            ix(claim(user.pubkey(), user_token), instruction::Claim {})
        ));
        let resolve = accounts::ResolveBet {
            oracle: pubkey(user.pubkey()),
            bet,
        };
        assert!(!send(
            &mut svm,
            &user,
            ix(resolve, instruction::ResolveBet { winning_side: 1 })
        ));
        let mut clock = svm.get_sysvar::<solana_clock::Clock>();
        clock.unix_timestamp = closes_at;
        svm.set_sysvar(&clock);
        assert!(!send(
            &mut svm,
            &user,
            ix(
                place(user.pubkey(), user_token),
                instruction::PlaceBet { side: 1, amount: 1 }
            )
        ));
        assert!(!send(
            &mut svm,
            &other,
            ix(
                accounts::ResolveBet {
                    oracle: pubkey(other.pubkey()),
                    bet
                },
                instruction::ResolveBet { winning_side: 1 }
            )
        ));
        if bet_id == 2 {
            assert!(!send(
                &mut svm,
                &other,
                ix(
                    accounts::RefundExpired { bet },
                    instruction::RefundExpired {}
                )
            ));
            clock.unix_timestamp = resolve_by;
            svm.set_sysvar(&clock);
            assert!(!send(
                &mut svm,
                &user,
                ix(
                    accounts::ResolveBet {
                        oracle: pubkey(user.pubkey()),
                        bet
                    },
                    instruction::ResolveBet { winning_side: 1 }
                )
            ));
            assert!(send(
                &mut svm,
                &other,
                ix(
                    accounts::RefundExpired { bet },
                    instruction::RefundExpired {}
                )
            ));
        } else {
            let winning_side = if bet_id == 0 { 1 } else { 2 };
            assert!(send(
                &mut svm,
                &user,
                ix(
                    accounts::ResolveBet {
                        oracle: pubkey(user.pubkey()),
                        bet
                    },
                    instruction::ResolveBet { winning_side }
                )
            ));
        }
        assert!(!send(
            &mut svm,
            &user,
            ix(
                accounts::ResolveBet {
                    oracle: pubkey(user.pubkey()),
                    bet
                },
                instruction::ResolveBet { winning_side: 2 }
            )
        ));
        let mut stolen = claim(other.pubkey(), other_token);
        stolen.position = position_for(user.pubkey());
        assert!(!send(&mut svm, &other, ix(stolen, instruction::Claim {})));
        assert!(send(
            &mut svm,
            &user,
            ix(claim(user.pubkey(), user_token), instruction::Claim {})
        ));
        assert!(!send(
            &mut svm,
            &user,
            ix(claim(user.pubkey(), user_token), instruction::Claim {})
        ));
        assert!(send(
            &mut svm,
            &other,
            ix(claim(other.pubkey(), other_token), instruction::Claim {})
        ));
        assert_eq!(balance(&svm, address(escrow)), 0);
        assert_eq!(
            balance(&svm, user_token),
            before_user - if bet_id == 0 { 1_000_000 } else { 0 }
        );
        assert_eq!(
            balance(&svm, other_token),
            before_other + if bet_id == 0 { 1_000_000 } else { 0 }
        );
        assert_eq!(balance(&svm, address(reserve)), 10_000_000);
    }
    // Use the actual devnet Metaplex binary, with test-only signature checking disabled
    // to model the pinned authority without loading a real wallet's private key.
    svm.add_program_from_file(
        address(anchor_spl::metadata::ID),
        "../../target/deploy/mpl_token_metadata.so",
    )
    .unwrap();
    let (metadata, _) = anchor_lang::prelude::Pubkey::find_program_address(
        &[
            b"metadata",
            anchor_spl::metadata::ID.as_ref(),
            mint.as_ref(),
        ],
        &anchor_spl::metadata::ID,
    );
    let metadata_accounts = |authority| accounts::CreateTokenMetadata {
        authority,
        vault,
        token_mint: mint,
        metadata,
        metadata_program: anchor_spl::metadata::ID,
        system_program: anchor_lang::system_program::ID,
        rent: anchor_lang::pubkey!("SysvarRent111111111111111111111111111111111"),
    };
    assert!(!send(
        &mut svm,
        &user,
        ix(
            metadata_accounts(pubkey(user.pubkey())),
            instruction::CreateTokenMetadata {}
        )
    ));
    assert!(svm.get_account(&address(metadata)).is_none());
    let authority = token_vault::METADATA_AUTHORITY;
    svm.airdrop(&address(authority), 1_000_000_000).unwrap();
    svm = svm.with_sigverify(false);
    let metadata_blockhash = svm.latest_blockhash();
    let unsigned = |instruction| {
        let mut transaction =
            Transaction::new_with_payer(&[instruction], Some(&address(authority)));
        transaction.message.recent_blockhash = metadata_blockhash;
        transaction
    };
    let mut wrong = metadata_accounts(authority);
    wrong.metadata = pubkey(Address::new_unique());
    assert!(svm
        .send_transaction(unsigned(ix(wrong, instruction::CreateTokenMetadata {})))
        .is_err());
    let result = svm.send_transaction(unsigned(ix(
        metadata_accounts(authority),
        instruction::CreateTokenMetadata {},
    )));
    assert!(result.is_ok(), "metadata creation: {result:?}");
    let account = svm.get_account(&address(metadata)).unwrap();
    assert_eq!(account.owner, address(anchor_spl::metadata::ID));
    let data = anchor_spl::metadata::mpl_token_metadata::accounts::Metadata::safe_deserialize(
        &account.data,
    )
    .unwrap();
    assert_eq!(data.update_authority.to_bytes(), authority.to_bytes());
    assert_eq!(data.mint.to_bytes(), mint.to_bytes());
    assert_eq!(data.name.trim_end_matches('\0'), token_vault::TOKEN_NAME);
    assert_eq!(
        data.symbol.trim_end_matches('\0'),
        token_vault::TOKEN_SYMBOL
    );
    assert_eq!(data.uri.trim_end_matches('\0'), token_vault::TOKEN_URI);
    assert!(data.is_mutable);
    assert_eq!(data.seller_fee_basis_points, 0);
    svm.expire_blockhash();
    let mut repeat = Transaction::new_with_payer(
        &[ix(
            metadata_accounts(authority),
            instruction::CreateTokenMetadata {},
        )],
        Some(&address(authority)),
    );
    repeat.message.recent_blockhash = svm.latest_blockhash();
    assert!(svm.send_transaction(repeat).is_err());
}
