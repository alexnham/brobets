import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { formatAmount } from "./money";
export async function readBalances(connection: Connection, address: string) {
  const user = new PublicKey(address);
  const sol = ((await connection.getBalance(user, "confirmed")) / 1e9).toFixed(
    4,
  );
  const mint = process.env.NEXT_PUBLIC_USDC_MINT,
    program = process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID;
  if (!mint || !program) return { sol, usdc: "—", tokens: "—" };
  const usdc = new PublicKey(mint),
    pid = new PublicKey(program);
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), usdc.toBuffer()],
    pid,
  );
  const [token] = PublicKey.findProgramAddressSync(
    [Buffer.from("token"), vault.toBuffer()],
    pid,
  );
  const balance = async (m: PublicKey) => {
    const ata = getAssociatedTokenAddressSync(m, user);
    if (!(await connection.getAccountInfo(ata, "confirmed"))) return "0";
    return formatAmount(
      BigInt(
        (await connection.getTokenAccountBalance(ata, "confirmed")).value
          .amount,
      ),
    );
  };
  return { sol, usdc: await balance(usdc), tokens: await balance(token) };
}

import {
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getMint,
  getAccount,
} from "@solana/spl-token";
import { parseAmount } from "./money";
// Must match TREASURY_AUTHORITY in programs/token-vault/src/lib.rs.
export const TREASURY_AUTHORITY = new PublicKey(
  "ERsc4ugZCfht4joqXWgVqtb222KUorwTuoD4Nc17wsB8",
);
// Anchor discriminators for the vault's `buy` and `sell` instructions.
export const TRADE_DISCRIMINATORS = {
  buy: [102, 6, 61, 18, 1, 218, 235, 234],
  sell: [51, 230, 133, 164, 1, 127, 131, 173],
};
/** Buying costs 1.10 USDC per BB; the 10% premium rounds up to the next base unit. */
export function quoteBuy(quantity: bigint) {
  const premium = (quantity + 9n) / 10n;
  return { quantity, backing: quantity, premium, total: quantity + premium };
}
export async function prepareVaultTrade(
  connection: Connection,
  address: string,
  action: "buy" | "sell",
  value: string,
  sponsorAddress?: string,
) {
  const units = parseAmount(value),
    user = new PublicKey(address),
    // The sponsor pays the network fee and account rent; the player still signs.
    payer = sponsorAddress ? new PublicKey(sponsorAddress) : user;
  const pid = new PublicKey(process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID!);
  const usdc = new PublicKey(process.env.NEXT_PUBLIC_USDC_MINT!);
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), usdc.toBuffer()],
    pid,
  );
  const [token] = PublicKey.findProgramAddressSync(
    [Buffer.from("token"), vault.toBuffer()],
    pid,
  );
  const [reserve] = PublicKey.findProgramAddressSync(
    [Buffer.from("reserve"), vault.toBuffer()],
    pid,
  );
  const vaultInfo = await connection.getAccountInfo(vault, "confirmed");
  if (
    !vaultInfo ||
    !vaultInfo.owner.equals(pid) ||
    vaultInfo.data.length !== 73 ||
    !vaultInfo.data
      .subarray(0, 8)
      .equals(Buffer.from([211, 8, 232, 43, 2, 152, 117, 119])) ||
    !vaultInfo.data.subarray(8, 40).equals(usdc.toBuffer()) ||
    !vaultInfo.data.subarray(40, 72).equals(token.toBuffer())
  )
    throw Error(
      "Configured vault is not initialized under the expected program.",
    );
  const [quoteMint, tokenMint, reserveInfo] = await Promise.all([
    getMint(connection, usdc, "confirmed"),
    getMint(connection, token, "confirmed"),
    getAccount(connection, reserve, "confirmed"),
  ]);
  if (
    quoteMint.decimals !== 6 ||
    tokenMint.decimals !== 6 ||
    !tokenMint.mintAuthority?.equals(vault) ||
    !reserveInfo.owner.equals(vault) ||
    !reserveInfo.mint.equals(usdc)
  )
    throw Error("Unexpected vault account configuration.");
  const userUsdc = getAssociatedTokenAddressSync(usdc, user),
    userToken = getAssociatedTokenAddressSync(token, user),
    treasury = getAssociatedTokenAddressSync(usdc, TREASURY_AUTHORITY);
  const buying = action === "buy";
  const data = Buffer.alloc(16);
  data.set(TRADE_DISCRIMINATORS[action]);
  new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(8, units, true);
  const transaction = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      userUsdc,
      user,
      usdc,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      userToken,
      user,
      token,
    ),
    // The first buyer pays the treasury account's rent; later buys skip creation.
    ...(buying
      ? [
          createAssociatedTokenAccountIdempotentInstruction(
            payer,
            treasury,
            TREASURY_AUTHORITY,
            usdc,
          ),
        ]
      : []),
    new TransactionInstruction({
      programId: pid,
      keys: [
        { pubkey: user, isSigner: true, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: false },
        { pubkey: usdc, isSigner: false, isWritable: false },
        { pubkey: token, isSigner: false, isWritable: true },
        { pubkey: reserve, isSigner: false, isWritable: true },
        { pubkey: userUsdc, isSigner: false, isWritable: true },
        { pubkey: userToken, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ...(buying
          ? [{ pubkey: treasury, isSigner: false, isWritable: true }]
          : []),
      ],
      data,
    }),
  );
  const lifetime = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = lifetime.blockhash;
  transaction.feePayer = payer;
  const simulation = await connection.simulateTransaction(
    new VersionedTransaction(transaction.compileMessage()),
    { commitment: "confirmed", sigVerify: false },
  );
  if (simulation.value.err)
    throw Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
  const fee = await connection.getFeeForMessage(
    transaction.compileMessage(),
    "confirmed",
  );
  if (fee.value === null) throw Error("Fee estimate unavailable; retry.");
  const missing = await Promise.all([
    connection.getAccountInfo(userUsdc, "confirmed"),
    connection.getAccountInfo(userToken, "confirmed"),
    buying ? connection.getAccountInfo(treasury, "confirmed") : true,
  ]);
  const rent =
    missing.filter((a) => !a).length *
    (await connection.getMinimumBalanceForRentExemption(165));
  return {
    transaction,
    user: address,
    sponsored: !payer.equals(user),
    feeLamports: fee.value,
    rentLamports: rent,
    lifetime,
    quote: buying ? quoteBuy(units) : null,
  };
}
