use crate::*;

pub fn handle_create_bet(
    ctx: Context<CreateBet>,
    bet_id: u64,
    closes_at: i64,
    resolve_by: i64,
) -> Result<()> {
    require!(
        closes_at > Clock::get()?.unix_timestamp && resolve_by > closes_at,
        VaultError::InvalidDeadline
    );
    ctx.accounts.bet.set_inner(Bet {
        oracle: ctx.accounts.oracle.key(),
        token_mint: ctx.accounts.token_mint.key(),
        bet_id,
        closes_at,
        resolve_by,
        totals: [0; 2],
        outcome: 0,
        bump: ctx.bumps.bet,
    });
    Ok(())
}

pub fn handle_open_position(ctx: Context<OpenPosition>) -> Result<()> {
    require!(
        ctx.accounts.bet.outcome == 0 && Clock::get()?.unix_timestamp < ctx.accounts.bet.closes_at,
        VaultError::Closed
    );
    ctx.accounts.position.set_inner(Position {
        bet: ctx.accounts.bet.key(),
        user: ctx.accounts.user.key(),
        stakes: [0; 2],
        claimed: false,
    });
    Ok(())
}

pub fn handle_place_bet(ctx: Context<PlaceBet>, side: u8, amount: u64) -> Result<()> {
    let index = side_index(side)?;
    validate_amount(amount)?;
    let bet = &mut ctx.accounts.bet;
    require!(
        bet.outcome == 0 && Clock::get()?.unix_timestamp < bet.closes_at,
        VaultError::Closed
    );
    bet.totals[index] = bet.totals[index]
        .checked_add(amount)
        .ok_or(VaultError::Overflow)?;
    // Bound the combined pot as well as each side to the SPL token amount range.
    bet.totals[0]
        .checked_add(bet.totals[1])
        .ok_or(VaultError::Overflow)?;
    let position = &mut ctx.accounts.position;
    position.stakes[index] = position.stakes[index]
        .checked_add(amount)
        .ok_or(VaultError::Overflow)?;
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.user_token.to_account_info(),
                mint: ctx.accounts.token_mint.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        DECIMALS,
    )
}

pub fn handle_resolve_bet(ctx: Context<ResolveBet>, winning_side: u8) -> Result<()> {
    let index = side_index(winning_side)?;
    let bet = &mut ctx.accounts.bet;
    let now = Clock::get()?.unix_timestamp;
    require!(bet.outcome == 0, VaultError::AlreadyResolved);
    require!(
        now >= bet.closes_at && now < bet.resolve_by,
        VaultError::InvalidResolutionTime
    );
    // A result with no winning stake refunds everyone instead of trapping the pool.
    bet.outcome = if bet.totals[index] == 0 {
        3
    } else {
        winning_side
    };
    Ok(())
}

pub fn handle_refund_expired(ctx: Context<RefundExpired>) -> Result<()> {
    require!(ctx.accounts.bet.outcome == 0, VaultError::AlreadyResolved);
    require!(
        Clock::get()?.unix_timestamp >= ctx.accounts.bet.resolve_by,
        VaultError::InvalidResolutionTime
    );
    ctx.accounts.bet.outcome = 3;
    Ok(())
}

pub fn handle_claim(ctx: Context<Claim>) -> Result<()> {
    let bet = &ctx.accounts.bet;
    let position = &mut ctx.accounts.position;
    require!(!position.claimed, VaultError::AlreadyClaimed);
    let amount = payout(bet.totals, position.stakes, bet.outcome)?;
    position.claimed = true;
    if amount == 0 {
        return Ok(());
    }
    let id = bet.bet_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"bet", bet.oracle.as_ref(), &id, &[bet.bump]];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.escrow.to_account_info(),
                mint: ctx.accounts.token_mint.to_account_info(),
                to: ctx.accounts.user_token.to_account_info(),
                authority: bet.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        DECIMALS,
    )
}

fn side_index(side: u8) -> Result<usize> {
    require!(side == 1 || side == 2, VaultError::InvalidSide);
    Ok((side - 1) as usize)
}

fn payout(totals: [u64; 2], stakes: [u64; 2], outcome: u8) -> Result<u64> {
    require!(outcome != 0, VaultError::Unresolved);
    if outcome == 3 {
        return stakes[0]
            .checked_add(stakes[1])
            .ok_or_else(|| error!(VaultError::Overflow));
    }
    let index = side_index(outcome)?;
    let total = totals[0]
        .checked_add(totals[1])
        .ok_or(VaultError::Overflow)?;
    require!(totals[index] > 0, VaultError::Unresolved);
    Ok(((stakes[index] as u128 * total as u128) / totals[index] as u128) as u64)
}

#[derive(Accounts)]
#[instruction(bet_id: u64)]
pub struct CreateBet<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(seeds = [b"vault", vault.usdc_mint.as_ref()], bump = vault.bump, has_one = token_mint)]
    pub vault: Account<'info, Vault>,
    pub token_mint: Account<'info, Mint>,
    #[account(init, payer = oracle, space = 8 + Bet::INIT_SPACE,
        seeds = [b"bet", oracle.key().as_ref(), &bet_id.to_le_bytes()], bump)]
    pub bet: Account<'info, Bet>,
    #[account(init, payer = oracle, seeds = [b"escrow", bet.key().as_ref()], bump,
        token::mint = token_mint, token::authority = bet)]
    pub escrow: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    pub bet: Account<'info, Bet>,
    #[account(init, payer = user, space = 8 + Position::INIT_SPACE,
        seeds = [b"position", bet.key().as_ref(), user.key().as_ref()], bump)]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    pub user: Signer<'info>,
    #[account(mut, has_one = token_mint)]
    pub bet: Account<'info, Bet>,
    pub token_mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"position", bet.key().as_ref(), user.key().as_ref()], bump,
        has_one = bet, has_one = user, constraint = !position.claimed @ VaultError::AlreadyClaimed)]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [b"escrow", bet.key().as_ref()], bump,
        token::mint = token_mint, token::authority = bet)]
    pub escrow: Account<'info, TokenAccount>,
    #[account(mut, token::mint = token_mint, token::authority = user)]
    pub user_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ResolveBet<'info> {
    pub oracle: Signer<'info>,
    #[account(mut, has_one = oracle)]
    pub bet: Account<'info, Bet>,
}

#[derive(Accounts)]
pub struct RefundExpired<'info> {
    #[account(mut)]
    pub bet: Account<'info, Bet>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [b"bet", bet.oracle.as_ref(), &bet.bet_id.to_le_bytes()], bump = bet.bump,
        has_one = token_mint)]
    pub bet: Account<'info, Bet>,
    pub token_mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"position", bet.key().as_ref(), user.key().as_ref()], bump, has_one = bet, has_one = user)]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [b"escrow", bet.key().as_ref()], bump,
        token::mint = token_mint, token::authority = bet)]
    pub escrow: Account<'info, TokenAccount>,
    #[account(mut, token::mint = token_mint, token::authority = user)]
    pub user_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Bet {
    pub oracle: Pubkey,
    pub token_mint: Pubkey,
    pub bet_id: u64,
    pub closes_at: i64,
    pub resolve_by: i64,
    pub totals: [u64; 2],
    /// 0 = open/unresolved, 1/2 = winner, 3 = refund.
    pub outcome: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub bet: Pubkey,
    pub user: Pubkey,
    pub stakes: [u64; 2],
    pub claimed: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proportional_payouts_and_refunds() {
        assert_eq!(payout([30, 70], [10, 20], 1).unwrap(), 33);
        assert_eq!(payout([30, 70], [20, 0], 1).unwrap(), 66);
        assert_eq!(payout([30, 70], [0, 70], 1).unwrap(), 0);
        assert_eq!(payout([30, 70], [10, 20], 3).unwrap(), 30);
        assert_eq!(
            payout([u64::MAX - 1, 1], [u64::MAX - 1, 0], 1).unwrap(),
            u64::MAX
        );
        assert!(payout([1, 1], [1, 0], 0).is_err());
        assert!(side_index(0).is_err());
        assert!(side_index(3).is_err());
    }
}
