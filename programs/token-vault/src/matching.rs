use crate::*;

// The Helius email wallet pinned by the operator for alexnham11@gmail.com.
pub const MATCH_ADMIN: Pubkey = pubkey!("ERsc4ugZCfht4joqXWgVqtb222KUorwTuoD4Nc17wsB8");

pub fn init(ctx: Context<InitializeMatching>) -> Result<()> {
    ctx.accounts.market.set_inner(MatchMarket {
        admin: MATCH_ADMIN,
        vault: ctx.accounts.vault.key(),
        token_mint: ctx.accounts.vault.token_mint,
        version: 1,
        bump: ctx.bumps.market,
    });
    Ok(())
}
pub fn create(
    ctx: Context<CreateQuestion>,
    question_id: u64,
    title: String,
    side_a: String,
    side_b: String,
    closes_at: i64,
    resolve_by: i64,
) -> Result<()> {
    require!(
        (10..=200).contains(&title.len())
            && (1..=80).contains(&side_a.len())
            && (1..=80).contains(&side_b.len())
            && side_a != side_b
            && !side_a.trim().is_empty()
            && !side_b.trim().is_empty(),
        VaultError::InvalidQuestion
    );
    require!(
        closes_at > Clock::get()?.unix_timestamp && resolve_by > closes_at,
        VaultError::InvalidDeadline
    );
    ctx.accounts.question.set_inner(MatchQuestion {
        admin: MATCH_ADMIN,
        market: ctx.accounts.market.key(),
        token_mint: ctx.accounts.market.token_mint,
        question_id,
        closes_at,
        resolve_by,
        outcome: 0,
        bump: ctx.bumps.question,
        title,
        side_a,
        side_b,
    });
    Ok(())
}
pub fn propose(ctx: Context<ProposeWager>, proposal_id: u64, side: u8, amount: u64) -> Result<()> {
    require!(side == 1 || side == 2, VaultError::InvalidSide);
    require!(amount > 0 && amount <= u64::MAX / 2, VaultError::Overflow);
    require!(
        ctx.accounts.question.outcome == 0
            && Clock::get()?.unix_timestamp < ctx.accounts.question.closes_at,
        VaultError::Closed
    );
    ctx.accounts.wager.set_inner(MatchedWager {
        question: ctx.accounts.question.key(),
        maker: ctx.accounts.maker.key(),
        taker: Pubkey::default(),
        proposal_id,
        amount,
        side,
        state: 0,
        maker_claimed: false,
        taker_claimed: false,
        bump: ctx.bumps.wager,
    });
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.maker_token.to_account_info(),
                mint: ctx.accounts.token_mint.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.maker.to_account_info(),
            },
        ),
        amount,
        DECIMALS,
    )
}
pub fn take(ctx: Context<MatchWager>) -> Result<()> {
    let q = &ctx.accounts.question;
    let w = &mut ctx.accounts.wager;
    require!(
        w.state == 0 && w.maker != ctx.accounts.taker.key(),
        VaultError::Unavailable
    );
    require!(
        q.outcome == 0 && Clock::get()?.unix_timestamp < q.closes_at,
        VaultError::Closed
    );
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.taker_token.to_account_info(),
                mint: ctx.accounts.token_mint.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.taker.to_account_info(),
            },
        ),
        w.amount,
        DECIMALS,
    )?;
    w.taker = ctx.accounts.taker.key();
    w.state = 1;
    Ok(())
}
pub fn resolve(ctx: Context<ResolveQuestion>, outcome: u8) -> Result<()> {
    require!((1..=3).contains(&outcome), VaultError::InvalidSide);
    let q = &mut ctx.accounts.question;
    let now = Clock::get()?.unix_timestamp;
    require!(q.outcome == 0, VaultError::AlreadyResolved);
    require!(
        now >= q.closes_at && now < q.resolve_by,
        VaultError::InvalidResolutionTime
    );
    q.outcome = outcome;
    Ok(())
}
pub fn expire(ctx: Context<ExpireQuestion>) -> Result<()> {
    let q = &mut ctx.accounts.question;
    require!(
        q.outcome == 0 && Clock::get()?.unix_timestamp >= q.resolve_by,
        VaultError::InvalidResolutionTime
    );
    q.outcome = 3;
    Ok(())
}
pub fn withdraw(ctx: Context<WithdrawWager>, cancel: bool) -> Result<()> {
    let q = &ctx.accounts.question;
    let w = &mut ctx.accounts.wager;
    let user = ctx.accounts.user.key();
    let now = Clock::get()?.unix_timestamp;
    require!(w.state <= 1, VaultError::Unavailable);
    let maker = user == w.maker;
    require!(
        maker || (w.state == 1 && user == w.taker),
        VaultError::Unauthorized
    );
    require!(
        if maker {
            !w.maker_claimed
        } else {
            !w.taker_claimed
        },
        VaultError::AlreadyClaimed
    );
    let refund = q.outcome == 3
        || (q.outcome == 0 && now >= q.resolve_by)
        || (w.state == 0 && now >= q.closes_at);
    let amount;
    if cancel {
        require!(maker && w.state == 0, VaultError::Unavailable);
        amount = w.amount;
        w.state = 2;
    } else if refund {
        amount = w.amount;
        if maker {
            w.maker_claimed = true;
        } else {
            w.taker_claimed = true;
        }
        if w.state == 0 || (w.maker_claimed && w.taker_claimed) {
            w.state = 3;
        }
    } else {
        require!(
            w.state == 1 && (q.outcome == 1 || q.outcome == 2),
            VaultError::Unresolved
        );
        require!(maker == (q.outcome == w.side), VaultError::Unauthorized);
        amount = w.amount.checked_mul(2).ok_or(VaultError::Overflow)?;
        if maker {
            w.maker_claimed = true;
        } else {
            w.taker_claimed = true;
        }
        w.state = 3;
    }
    let id = w.proposal_id.to_le_bytes();
    let bump = [w.bump];
    let seeds: &[&[u8]] = &[
        b"wager_v1",
        w.question.as_ref(),
        w.maker.as_ref(),
        &id,
        &bump,
    ];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.escrow.to_account_info(),
                mint: ctx.accounts.token_mint.to_account_info(),
                to: ctx.accounts.user_token.to_account_info(),
                authority: w.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        DECIMALS,
    )
}

#[derive(Accounts)]
pub struct InitializeMatching<'info> {
    #[account(mut, address = MATCH_ADMIN)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"vault", vault.usdc_mint.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(init, payer = admin, space = 8 + MatchMarket::INIT_SPACE, seeds = [b"matching_v1"], bump)]
    pub market: Account<'info, MatchMarket>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(question_id: u64)]
pub struct CreateQuestion<'info> {
    #[account(mut, address = MATCH_ADMIN)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"matching_v1"], bump = market.bump, has_one = admin)]
    pub market: Account<'info, MatchMarket>,
    #[account(init, payer = admin, space = 8 + MatchQuestion::INIT_SPACE, seeds = [b"question_v1", question_id.to_le_bytes().as_ref()], bump)]
    pub question: Account<'info, MatchQuestion>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct ProposeWager<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(seeds = [b"question_v1", &question.question_id.to_le_bytes()], bump = question.bump, has_one = token_mint)]
    pub question: Account<'info, MatchQuestion>,
    pub token_mint: Account<'info, Mint>,
    #[account(init, payer = maker, space = 8 + MatchedWager::INIT_SPACE, seeds = [b"wager_v1", question.key().as_ref(), maker.key().as_ref(), &proposal_id.to_le_bytes()], bump)]
    pub wager: Account<'info, MatchedWager>,
    #[account(init, payer = maker, seeds = [b"wager_escrow_v1", wager.key().as_ref()], bump, token::mint = token_mint, token::authority = wager)]
    pub escrow: Account<'info, TokenAccount>,
    #[account(mut, token::mint = token_mint, token::authority = maker)]
    pub maker_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct MatchWager<'info> {
    pub taker: Signer<'info>,
    #[account(seeds = [b"question_v1", &question.question_id.to_le_bytes()], bump = question.bump, has_one = token_mint)]
    pub question: Account<'info, MatchQuestion>,
    pub token_mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"wager_v1", question.key().as_ref(), wager.maker.as_ref(), &wager.proposal_id.to_le_bytes()], bump = wager.bump, has_one = question)]
    pub wager: Account<'info, MatchedWager>,
    #[account(mut, seeds = [b"wager_escrow_v1", wager.key().as_ref()], bump, token::mint = token_mint, token::authority = wager)]
    pub escrow: Account<'info, TokenAccount>,
    #[account(mut, token::mint = token_mint, token::authority = taker)]
    pub taker_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
#[derive(Accounts)]
pub struct ResolveQuestion<'info> {
    #[account(address = MATCH_ADMIN)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"question_v1", &question.question_id.to_le_bytes()], bump = question.bump, has_one = admin)]
    pub question: Account<'info, MatchQuestion>,
}
#[derive(Accounts)]
pub struct ExpireQuestion<'info> {
    #[account(mut, seeds = [b"question_v1", &question.question_id.to_le_bytes()], bump = question.bump)]
    pub question: Account<'info, MatchQuestion>,
}
#[derive(Accounts)]
pub struct WithdrawWager<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [b"question_v1", &question.question_id.to_le_bytes()], bump = question.bump, has_one = token_mint)]
    pub question: Account<'info, MatchQuestion>,
    pub token_mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"wager_v1", question.key().as_ref(), wager.maker.as_ref(), &wager.proposal_id.to_le_bytes()], bump = wager.bump, has_one = question)]
    pub wager: Account<'info, MatchedWager>,
    #[account(mut, seeds = [b"wager_escrow_v1", wager.key().as_ref()], bump, token::mint = token_mint, token::authority = wager)]
    pub escrow: Account<'info, TokenAccount>,
    #[account(mut, token::mint = token_mint, token::authority = user)]
    pub user_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
#[account]
#[derive(InitSpace)]
pub struct MatchMarket {
    pub admin: Pubkey,
    pub vault: Pubkey,
    pub token_mint: Pubkey,
    pub version: u8,
    pub bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct MatchQuestion {
    pub admin: Pubkey,
    pub market: Pubkey,
    pub token_mint: Pubkey,
    pub question_id: u64,
    pub closes_at: i64,
    pub resolve_by: i64,
    pub outcome: u8,
    pub bump: u8,
    #[max_len(200)]
    pub title: String,
    #[max_len(80)]
    pub side_a: String,
    #[max_len(80)]
    pub side_b: String,
}
#[account]
#[derive(InitSpace)]
pub struct MatchedWager {
    pub question: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub proposal_id: u64,
    pub amount: u64,
    pub side: u8,
    /// 0 open, 1 matched, 2 cancelled, 3 paid/refunded.
    pub state: u8,
    pub maker_claimed: bool,
    pub taker_claimed: bool,
    pub bump: u8,
}
