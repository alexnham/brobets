use anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
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

fn act(svm: &mut LiteSVM, user: Address, instruction: Instruction) -> bool {
    svm.expire_blockhash();
    let mut tx = Transaction::new_with_payer(&[instruction], Some(&user));
    tx.message.recent_blockhash = svm.latest_blockhash();
    tx.signatures = vec![Default::default(); tx.message.header.num_required_signatures as usize];
    svm.send_transaction(tx).is_ok()
}
#[test]
fn matched_wagers_enforce_authority_atomic_matching_and_exact_payouts() {
    // Only cryptographic verification is disabled to represent the existing Helius admin
    // without possessing its key. Runtime signer/account constraints remain enforced.
    let mut svm = LiteSVM::new().with_sigverify(false);
    svm.add_program_from_file(
        address(token_vault::ID),
        "../../target/deploy/token_vault.so",
    )
    .unwrap();
    let admin = address(token_vault::MATCH_ADMIN);
    let maker = Address::new_unique();
    let taker = Address::new_unique();
    let rival = Address::new_unique();
    for user in [admin, maker, taker, rival] {
        svm.airdrop(&user, 10_000_000_000).unwrap();
    }
    let quote = Address::new_unique();
    let mut data = vec![0; 82];
    data[44] = 6;
    data[45] = 1;
    svm.set_account(
        quote,
        Account {
            lamports: 10_000_000,
            data,
            owner: address(anchor_spl::token::ID),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    let pda = |seeds: &[&[u8]]| {
        anchor_lang::prelude::Pubkey::find_program_address(seeds, &token_vault::ID).0
    };
    let vault = pda(&[b"vault", quote.as_ref()]);
    let mint = pda(&[b"token", vault.as_ref()]);
    let reserve = pda(&[b"reserve", vault.as_ref()]);
    let market = pda(&[b"matching_v1"]);
    assert!(act(
        &mut svm,
        maker,
        ix(
            accounts::Initialize {
                payer: pubkey(maker),
                usdc_mint: pubkey(quote),
                vault,
                token_mint: mint,
                reserve,
                token_program: anchor_spl::token::ID,
                system_program: anchor_lang::system_program::ID
            },
            instruction::Initialize {}
        )
    ));
    let init = |user| accounts::InitializeMatching {
        admin: pubkey(user),
        vault,
        market,
        system_program: anchor_lang::system_program::ID,
    };
    assert!(!act(
        &mut svm,
        rival,
        ix(init(rival), instruction::InitializeMatching {})
    ));
    assert!(act(
        &mut svm,
        admin,
        ix(init(admin), instruction::InitializeMatching {})
    ));
    let ma = Address::new_unique();
    let ta = Address::new_unique();
    let ra = Address::new_unique();
    for (a, u) in [(ma, maker), (ta, taker), (ra, rival)] {
        token_account(&mut svm, a, address(mint), u, 100_000_000);
    }
    let start = svm.get_sysvar::<solana_clock::Clock>().unix_timestamp;
    for case in 0u64..6 {
        let q = pda(&[b"question_v1", &case.to_le_bytes()]);
        let close = start + 100 + case as i64 * 200;
        let deadline = close + 100;
        let create = |user| accounts::CreateQuestion {
            admin: pubkey(user),
            market,
            question: q,
            system_program: anchor_lang::system_program::ID,
        };
        let data = || instruction::CreateQuestion {
            question_id: case,
            title: "Who wins the basketball game?".into(),
            side_a: "Lakers".into(),
            side_b: "Warriors".into(),
            closes_at: close,
            resolve_by: deadline,
        };
        assert!(!act(&mut svm, rival, ix(create(rival), data())));
        assert!(act(&mut svm, admin, ix(create(admin), data())));
        let w = pda(&[b"wager_v1", q.as_ref(), maker.as_ref(), &0u64.to_le_bytes()]);
        let e = pda(&[b"wager_escrow_v1", w.as_ref()]);
        let propose = || accounts::ProposeWager {
            maker: pubkey(maker),
            question: q,
            token_mint: mint,
            wager: w,
            escrow: e,
            maker_token: pubkey(ma),
            token_program: anchor_spl::token::ID,
            system_program: anchor_lang::system_program::ID,
        };
        let before = balance(&svm, ma);
        for (side, amount) in [(0, 5_123_456), (1, 0), (1, u64::MAX)] {
            assert!(!act(
                &mut svm,
                maker,
                ix(
                    propose(),
                    instruction::ProposeWager {
                        proposal_id: 0,
                        side,
                        amount
                    }
                )
            ));
        }
        assert!(act(
            &mut svm,
            maker,
            ix(
                propose(),
                instruction::ProposeWager {
                    proposal_id: 0,
                    side: 1,
                    amount: 5_123_456
                }
            )
        ));
        assert_eq!(balance(&svm, ma), before - 5_123_456);
        assert_eq!(balance(&svm, address(e)), 5_123_456);
        let take = |user, token| accounts::MatchWager {
            taker: pubkey(user),
            question: q,
            token_mint: mint,
            wager: w,
            escrow: e,
            taker_token: pubkey(token),
            token_program: anchor_spl::token::ID,
        };
        let withdraw = |user, token| accounts::WithdrawWager {
            user: pubkey(user),
            question: q,
            token_mint: mint,
            wager: w,
            escrow: e,
            user_token: pubkey(token),
            token_program: anchor_spl::token::ID,
        };
        assert!(!act(
            &mut svm,
            maker,
            ix(take(maker, ma), instruction::MatchWager {})
        ));
        assert!(!act(
            &mut svm,
            rival,
            ix(withdraw(rival, ra), instruction::CancelWager {})
        ));
        if case == 1 {
            assert!(act(
                &mut svm,
                maker,
                ix(withdraw(maker, ma), instruction::CancelWager {})
            ));
            assert!(!act(
                &mut svm,
                taker,
                ix(take(taker, ta), instruction::MatchWager {})
            ));
            assert!(!act(
                &mut svm,
                maker,
                ix(withdraw(maker, ma), instruction::CancelWager {})
            ));
            assert_eq!(balance(&svm, ma), before);
            continue;
        }
        if case == 5 {
            let mut clock = svm.get_sysvar::<solana_clock::Clock>();
            clock.unix_timestamp = close;
            svm.set_sysvar(&clock);
            assert!(!act(
                &mut svm,
                taker,
                ix(take(taker, ta), instruction::MatchWager {})
            ));
            assert!(act(
                &mut svm,
                maker,
                ix(withdraw(maker, ma), instruction::ClaimWager {})
            ));
            assert_eq!(balance(&svm, ma), before);
            continue;
        }
        let empty = Address::new_unique();
        token_account(&mut svm, empty, address(mint), rival, 0);
        assert!(!act(
            &mut svm,
            rival,
            ix(take(rival, empty), instruction::MatchWager {})
        ));
        assert_eq!(balance(&svm, address(e)), 5_123_456);
        let tb = balance(&svm, ta);
        let rb = balance(&svm, ra);
        assert!(act(
            &mut svm,
            taker,
            ix(take(taker, ta), instruction::MatchWager {})
        ));
        assert!(!act(
            &mut svm,
            rival,
            ix(take(rival, ra), instruction::MatchWager {})
        ));
        assert_eq!(balance(&svm, ra), rb);
        assert_eq!(balance(&svm, ta), tb - 5_123_456);
        assert_eq!(balance(&svm, address(e)), 10_246_912);
        assert!(!act(
            &mut svm,
            maker,
            ix(withdraw(maker, ma), instruction::CancelWager {})
        ));
        let resolve = |user| accounts::ResolveQuestion {
            admin: pubkey(user),
            question: q,
        };
        assert!(!act(
            &mut svm,
            admin,
            ix(resolve(admin), instruction::ResolveQuestion { outcome: 1 })
        ));
        let mut clock = svm.get_sysvar::<solana_clock::Clock>();
        clock.unix_timestamp = if case == 3 { deadline } else { close };
        svm.set_sysvar(&clock);
        assert!(!act(
            &mut svm,
            rival,
            ix(resolve(rival), instruction::ResolveQuestion { outcome: 1 })
        ));
        if case == 3 {
            assert!(!act(
                &mut svm,
                admin,
                ix(resolve(admin), instruction::ResolveQuestion { outcome: 1 })
            ));
            assert!(act(
                &mut svm,
                rival,
                ix(
                    accounts::ExpireQuestion { question: q },
                    instruction::ExpireQuestion {}
                )
            ));
        } else {
            assert!(act(
                &mut svm,
                admin,
                ix(
                    resolve(admin),
                    instruction::ResolveQuestion {
                        outcome: if case == 2 {
                            3
                        } else if case == 4 {
                            2
                        } else {
                            1
                        }
                    }
                )
            ));
        }
        assert!(!act(
            &mut svm,
            admin,
            ix(resolve(admin), instruction::ResolveQuestion { outcome: 2 })
        ));
        let mut substituted = withdraw(maker, ma);
        substituted.user_token = pubkey(ta);
        assert!(!act(
            &mut svm,
            maker,
            ix(substituted, instruction::ClaimWager {})
        ));
        if case == 4 {
            assert!(!act(
                &mut svm,
                maker,
                ix(withdraw(maker, ma), instruction::ClaimWager {})
            ));
            assert!(act(
                &mut svm,
                taker,
                ix(withdraw(taker, ta), instruction::ClaimWager {})
            ));
            assert_eq!(balance(&svm, ta), tb + 5_123_456);
        } else if case == 0 {
            assert!(!act(
                &mut svm,
                taker,
                ix(withdraw(taker, ta), instruction::ClaimWager {})
            ));
            assert!(act(
                &mut svm,
                maker,
                ix(withdraw(maker, ma), instruction::ClaimWager {})
            ));
            assert_eq!(balance(&svm, ma), before + 5_123_456);
        } else {
            assert!(act(
                &mut svm,
                maker,
                ix(withdraw(maker, ma), instruction::ClaimWager {})
            ));
            assert!(!act(
                &mut svm,
                maker,
                ix(withdraw(maker, ma), instruction::ClaimWager {})
            ));
            assert!(act(
                &mut svm,
                taker,
                ix(withdraw(taker, ta), instruction::ClaimWager {})
            ));
            assert_eq!(balance(&svm, ma), before);
            assert_eq!(balance(&svm, ta), tb);
        }
        assert!(!act(
            &mut svm,
            maker,
            ix(withdraw(maker, ma), instruction::ClaimWager {})
        ));
        assert_eq!(balance(&svm, address(e)), 0);
    }
}
