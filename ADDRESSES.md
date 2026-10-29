# Brobets address registry

Network: **Solana devnet**. RPC: `https://api.devnet.solana.com`.
Recorded October 28, 2026 (America/Toronto). This file contains public addresses only.

## Core accounts

| Role | Public address | Purpose |
| --- | --- | --- |
| App admin wallet | `ERsc4ugZCfht4joqXWgVqtb222KUorwTuoD4Nc17wsB8` | Server-side admin access after wallet signature verification |
| Payer / local CLI wallet | `GbDLTR4JK4EdZAtjXqAVDx3vWg2BwwEiESxsLqhDNEiG` | Pays transaction fees and account rent |
| Vault and betting program | `AVnHeHrsjCdY55sygvLMmehrZHLBZknEZL1BnEPP5tKs` | Deployed Anchor program |
| ProgramData | `JCnkbUMKsQVgoAhiuJ9n9o1kNKUnagNF7rK6FF5EMCQC` | Upgradeable program code and upgrade authority record |
| USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Six-decimal devnet USDC quote token |
| Vault state PDA | `7mCh2MGKTEYFrMb7u9FjxWYnuT7qtzhfUnh6JGwLRPAY` | Links USDC and vault token; controls minting and reserve transfers |
| Vault token mint PDA | `yU47auGVnuqUqYACt8u3388nfP29mTWQcLRgAHPAjMC` | New six-decimal token, bought/redeemed at 1 USDC |
| USDC reserve PDA | `AefhcK8bHKXxGyfTSbUtb9VmuVYHStx6H1EBFdVE8iRg` | SPL token account holding the backing USDC |

Explorer: `https://explorer.solana.com/address/<ADDRESS>?cluster=devnet`.

## Authority assignments

| Permission | Controller / status |
| --- | --- |
| App admin | `ERsc4ugZCfht4joqXWgVqtb222KUorwTuoD4Nc17wsB8` — configured in `web/.env.local` |
| Program upgrades | `GbDLTR4JK4EdZAtjXqAVDx3vWg2BwwEiESxsLqhDNEiG` — verified using `solana program show` |
| Vault token mint authority | Vault state PDA: `7mCh2MGKTEYFrMb7u9FjxWYnuT7qtzhfUnh6JGwLRPAY` |
| USDC reserve token authority | Vault state PDA: `7mCh2MGKTEYFrMb7u9FjxWYnuT7qtzhfUnh6JGwLRPAY` |
| Vault token freeze authority | None in the current initialization code |
| Betting oracle | Set separately on each bet to the wallet signing `create_bet`; not assigned by vault initialization |
| Betting escrow token authority | That escrow's bet PDA |
| Metaplex metadata update authority | `GbDLTR4JK4EdZAtjXqAVDx3vWg2BwwEiESxsLqhDNEiG` — verified from the devnet metadata account |

The upgrade authority can replace the program code. The payer role alone does not grant oracle or reserve withdrawal permissions.

## Derived wallet addresses not yet created

These addresses were derived and checked on devnet when recorded; no account existed at them. Re-check before use.

| Role | Derived address |
| --- | --- |

| Payer's USDC associated token account | `5ogKx3ySrUhW4WWxiU7fuK5Xgy5xb3MLfSeBDNyGsfXu` |
| Payer's vault-token associated token account | `5udZrvHVU5sN1A3zcZVCU2nnGniqtzbq4tWoJn14pXU5` |

An associated token account is a wallet's token holding account; it is distinct from the mint and the vault reserve. A wallet may also use non-associated token accounts.

## Supporting programs

| Program | Address |
| --- | --- |
| SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| System | `11111111111111111111111111111111` |
| Upgradeable BPF loader | `BPFLoaderUpgradeab1e11111111111111111111111` |
| Metaplex Token Metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` |

## PDA derivation

Use the Brobets program ID above, except for Metaplex metadata:

| Account | Seeds, in order |
| --- | --- |
| Vault state | UTF-8 `vault`, USDC mint bytes |
| Vault token mint | UTF-8 `token`, vault state bytes |
| USDC reserve | UTF-8 `reserve`, vault state bytes |
| Bet | UTF-8 `bet`, oracle public-key bytes, bet ID as eight little-endian bytes (`u64`) |
| Bet escrow | UTF-8 `escrow`, bet PDA bytes |
| Bettor position | UTF-8 `position`, bet PDA bytes, bettor public-key bytes |
| Metaplex metadata | UTF-8 `metadata`, Metaplex Token Metadata program ID bytes, vault token mint bytes; derive under the Metaplex program ID |

## Bet registry

No specific bet addresses have been recorded yet. Add a row after each `create_bet` transaction confirms.

| Bet ID | Oracle | Bet PDA | Escrow PDA | Creation transaction |
| --- | --- | --- | --- | --- |

Bet IDs are unique within an oracle's namespace. Pin the intended oracle public key in the client.

## Transaction notes

Vault initialization succeeded according to the user's transaction output. The successful signature has not been provided in this chat.

The previously reported signature `5Z2M84RzsuBho6DwExaauoktjuDGRMj4HEaFmiinBaXBqJAYFASnaQNWjez6aLe3FgLEYCyTYBzfkMkCf1oHqME2` belongs to the failed signing attempt; do not use it as proof of initialization.

## Re-check deployment

```sh
solana program show AVnHeHrsjCdY55sygvLMmehrZHLBZknEZL1BnEPP5tKs --url devnet
```

Update this registry after authority changes, new deployments, metadata creation, or new bets. Keep devnet and mainnet addresses separate.

## Token branding configuration

- Name: **BROBETS**
- Symbol: **BB**
- Metadata URI: `https://alexnham.github.io/storage/brobets.json`
- Image: `https://alexnham.github.io/storage/brobets.jpg`
- Metadata PDA: `9XuardGkf2UxULbiMVLgwvWPXp1hmE48HsnRFR1TwCe6`
- Update authority: `GbDLTR4JK4EdZAtjXqAVDx3vWg2BwwEiESxsLqhDNEiG`
- Mutable: yes; royalties: zero.
- Status: metadata account exists on devnet and its owner, mint, name, symbol, URI, mutability, zero royalties, and update authority have been verified. Creation transaction signature is not recorded.
