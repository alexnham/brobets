use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, TransferChecked};

declare_id!("AVnHeHrsjCdY55sygvLMmehrZHLBZknEZL1BnEPP5tKs");

pub mod betting;
pub use betting::*;

pub const DECIMALS: u8 = 6;

#[program]
pub mod token_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        ctx.accounts.vault.usdc_mint = ctx.accounts.usdc_mint.key();
        ctx.accounts.vault.token_mint = ctx.accounts.token_mint.key();
        ctx.accounts.vault.bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn create_bet(
        ctx: Context<CreateBet>,
        bet_id: u64,
        closes_at: i64,
        resolve_by: i64,
    ) -> Result<()> {
        betting::handle_create_bet(ctx, bet_id, closes_at, resolve_by)
    }
    pub fn open_position(ctx: Context<OpenPosition>) -> Result<()> {
        betting::handle_open_position(ctx)
    }
    pub fn place_bet(ctx: Context<PlaceBet>, side: u8, amount: u64) -> Result<()> {
        betting::handle_place_bet(ctx, side, amount)
    }
    pub fn resolve_bet(ctx: Context<ResolveBet>, winning_side: u8) -> Result<()> {
        betting::handle_resolve_bet(ctx, winning_side)
    }
    pub fn refund_expired(ctx: Context<RefundExpired>) -> Result<()> {
        betting::handle_refund_expired(ctx)
    }
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        betting::handle_claim(ctx)
    }

    /// Amount is in millionths: 1_000_000 buys one token for one USDC.
    pub fn buy(ctx: Context<Trade>, amount: u64) -> Result<()> {
        validate_amount(amount)?;
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.reserve.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            DECIMALS,
        )?;
        let mint = ctx.accounts.usdc_mint.key();
        let seeds: &[&[u8]] = &[b"vault", mint.as_ref(), &[ctx.accounts.vault.bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.user_token.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )
    }

    pub fn sell(ctx: Context<Trade>, amount: u64) -> Result<()> {
        validate_amount(amount)?;
        require!(
            ctx.accounts.reserve.amount >= amount,
            VaultError::InsufficientReserve
        );
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.token_mint.to_account_info(),
                    from: ctx.accounts.user_token.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;
        let mint = ctx.accounts.usdc_mint.key();
        let seeds: &[&[u8]] = &[b"vault", mint.as_ref(), &[ctx.accounts.vault.bump]];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.reserve.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            DECIMALS,
        )
    }
}

fn validate_amount(amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    // One vault per quote mint; select the canonical USDC mint for the cluster.
    #[account(mint::decimals = DECIMALS)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(init, payer = payer, space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", usdc_mint.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    #[account(init, payer = payer, seeds = [b"token", vault.key().as_ref()], bump,
        mint::decimals = DECIMALS, mint::authority = vault)]
    pub token_mint: Account<'info, Mint>,
    #[account(init, payer = payer, seeds = [b"reserve", vault.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = vault)]
    pub reserve: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [b"vault", usdc_mint.key().as_ref()], bump = vault.bump,
        has_one = usdc_mint, has_one = token_mint)]
    pub vault: Account<'info, Vault>,
    #[account(mint::decimals = DECIMALS)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"token", vault.key().as_ref()], bump,
        mint::decimals = DECIMALS, mint::authority = vault)]
    pub token_mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"reserve", vault.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = vault)]
    pub reserve: Account<'info, TokenAccount>,
    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Account<'info, TokenAccount>,
    #[account(mut, token::mint = token_mint, token::authority = user)]
    pub user_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub usdc_mint: Pubkey,
    pub token_mint: Pubkey,
    pub bump: u8,
}

#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("The vault does not have enough USDC for this redemption")]
    InsufficientReserve,
    #[msg("Side must be 1 or 2")]
    InvalidSide,
    #[msg("Betting is closed")]
    Closed,
    #[msg("Deadlines must be in the future and resolution must follow closing")]
    InvalidDeadline,
    #[msg("Oracle must resolve after closing and before the resolution deadline")]
    InvalidResolutionTime,
    #[msg("Bet already resolved")]
    AlreadyResolved,
    #[msg("Bet has not resolved")]
    Unresolved,
    #[msg("Position already claimed")]
    AlreadyClaimed,
    #[msg("Amount overflow")]
    Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amount_boundaries() {
        assert!(validate_amount(0).is_err());
        assert!(validate_amount(1).is_ok());
        assert!(validate_amount(1_000_000).is_ok());
        assert!(validate_amount(u64::MAX).is_ok());
    }
}
