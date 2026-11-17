use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, TransferChecked};

declare_id!("AVnHeHrsjCdY55sygvLMmehrZHLBZknEZL1BnEPP5tKs");

pub mod betting;
pub use betting::*;
pub mod matching;
pub use matching::*;

pub const DECIMALS: u8 = 6;
pub const METADATA_AUTHORITY: Pubkey = pubkey!("GbDLTR4JK4EdZAtjXqAVDx3vWg2BwwEiESxsLqhDNEiG");
// Purchase premiums go only to this wallet's USDC associated token account.
pub const TREASURY_AUTHORITY: Pubkey = pubkey!("ERsc4ugZCfht4joqXWgVqtb222KUorwTuoD4Nc17wsB8");
pub const PREMIUM_DIVISOR: u64 = 10;
pub const TOKEN_NAME: &str = "BROBETS";
pub const TOKEN_SYMBOL: &str = "BB";
pub const TOKEN_URI: &str = "https://alexnham.github.io/storage/brobets.json";

#[program]
pub mod token_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        ctx.accounts.vault.usdc_mint = ctx.accounts.usdc_mint.key();
        ctx.accounts.vault.token_mint = ctx.accounts.token_mint.key();
        ctx.accounts.vault.bump = ctx.bumps.vault;
        Ok(())
    }

    /// One-time metadata creation for the existing mint; the wallet can update it directly afterward.
    pub fn create_token_metadata(ctx: Context<CreateTokenMetadata>) -> Result<()> {
        use anchor_spl::metadata::{
            create_metadata_accounts_v3, mpl_token_metadata::types::DataV2,
            CreateMetadataAccountsV3,
        };
        let seeds: &[&[u8]] = &[
            b"vault",
            ctx.accounts.vault.usdc_mint.as_ref(),
            &[ctx.accounts.vault.bump],
        ];
        create_metadata_accounts_v3(
            CpiContext::new_with_signer(
                ctx.accounts.metadata_program.key(),
                CreateMetadataAccountsV3 {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                    mint_authority: ctx.accounts.vault.to_account_info(),
                    payer: ctx.accounts.authority.to_account_info(),
                    update_authority: ctx.accounts.authority.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
                &[seeds],
            ),
            DataV2 {
                name: TOKEN_NAME.into(),
                symbol: TOKEN_SYMBOL.into(),
                uri: TOKEN_URI.into(),
                seller_fee_basis_points: 0,
                creators: None,
                collection: None,
                uses: None,
            },
            true,
            true,
            None,
        )
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

    pub fn initialize_matching(ctx: Context<InitializeMatching>) -> Result<()> {
        matching::init(ctx)
    }
    pub fn create_question(
        ctx: Context<CreateQuestion>,
        question_id: u64,
        title: String,
        side_a: String,
        side_b: String,
        closes_at: i64,
        resolve_by: i64,
    ) -> Result<()> {
        matching::create(
            ctx,
            question_id,
            title,
            side_a,
            side_b,
            closes_at,
            resolve_by,
        )
    }
    pub fn edit_question(
        ctx: Context<ResolveQuestion>,
        title: String,
        closes_at: i64,
        resolve_by: i64,
    ) -> Result<()> {
        matching::edit(ctx, title, closes_at, resolve_by)
    }
    pub fn propose_wager(
        ctx: Context<ProposeWager>,
        proposal_id: u64,
        side: u8,
        amount: u64,
    ) -> Result<()> {
        matching::propose(ctx, proposal_id, side, amount)
    }
    pub fn match_wager(ctx: Context<MatchWager>) -> Result<()> {
        matching::take(ctx)
    }
    pub fn cancel_wager(ctx: Context<WithdrawWager>) -> Result<()> {
        matching::withdraw(ctx, true)
    }
    pub fn claim_wager(ctx: Context<WithdrawWager>) -> Result<()> {
        matching::withdraw(ctx, false)
    }
    pub fn resolve_question(ctx: Context<ResolveQuestion>, outcome: u8) -> Result<()> {
        matching::resolve(ctx, outcome)
    }
    pub fn expire_question(ctx: Context<ExpireQuestion>) -> Result<()> {
        matching::expire(ctx)
    }

    /// Amount is BB in millionths. Each BB costs 1.10 USDC: 1.00 to the reserve, 0.10 to the treasury.
    pub fn buy(ctx: Context<Buy>, amount: u64) -> Result<()> {
        validate_amount(amount)?;
        let premium = premium(amount)?;
        let trade = &ctx.accounts.trade;
        for (to, units) in [
            (trade.reserve.to_account_info(), amount),
            (ctx.accounts.treasury.to_account_info(), premium),
        ] {
            token::transfer_checked(
                CpiContext::new(
                    trade.token_program.key(),
                    TransferChecked {
                        from: trade.user_usdc.to_account_info(),
                        mint: trade.usdc_mint.to_account_info(),
                        to,
                        authority: trade.user.to_account_info(),
                    },
                ),
                units,
                DECIMALS,
            )?;
        }
        let mint = trade.usdc_mint.key();
        let seeds: &[&[u8]] = &[b"vault", mint.as_ref(), &[trade.vault.bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                trade.token_program.key(),
                MintTo {
                    mint: trade.token_mint.to_account_info(),
                    to: trade.user_token.to_account_info(),
                    authority: trade.vault.to_account_info(),
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

/// 10% of `amount`, rounded up to the next USDC base unit; rejects totals that exceed u64.
pub fn premium(amount: u64) -> Result<u64> {
    let premium = amount.div_ceil(PREMIUM_DIVISOR);
    amount.checked_add(premium).ok_or(VaultError::Overflow)?;
    Ok(premium)
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
pub struct CreateTokenMetadata<'info> {
    #[account(mut, address = METADATA_AUTHORITY)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"vault", vault.usdc_mint.as_ref()], bump = vault.bump, has_one = token_mint)]
    pub vault: Account<'info, Vault>,
    #[account(seeds = [b"token", vault.key().as_ref()], bump,
        mint::decimals = DECIMALS, mint::authority = vault)]
    pub token_mint: Account<'info, Mint>,
    /// CHECK: Canonical Metaplex PDA; the pinned Metaplex program creates and validates its contents.
    #[account(mut, seeds = [b"metadata", metadata_program.key().as_ref(), token_mint.key().as_ref()],
        bump, seeds::program = metadata_program.key())]
    pub metadata: UncheckedAccount<'info>,
    pub metadata_program: Program<'info, anchor_spl::metadata::Metadata>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
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

#[derive(Accounts)]
pub struct Buy<'info> {
    pub trade: Trade<'info>,
    #[account(mut, associated_token::mint = trade.usdc_mint,
        associated_token::authority = TREASURY_AUTHORITY)]
    pub treasury: Account<'info, TokenAccount>,
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
    #[msg("Question text or outcomes are invalid")]
    InvalidQuestion,
    #[msg("This wager is no longer available for this action")]
    Unavailable,
    #[msg("This wallet is not entitled to this action or payout")]
    Unauthorized,
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

    #[test]
    fn premium_rounds_up_and_rejects_overflow() {
        for (amount, expected) in [
            (1, 1),
            (9, 1),
            (10, 1),
            (11, 2),
            (2_500_001, 250_001),
            (10_000_000, 1_000_000),
        ] {
            assert_eq!(premium(amount).unwrap(), expected);
        }
        assert!(premium(u64::MAX).is_err());
        assert!(premium(u64::MAX / 11 * 10).is_ok());
    }
}
