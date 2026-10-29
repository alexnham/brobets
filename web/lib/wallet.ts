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
export async function prepareVaultTrade(
  connection: Connection,
  address: string,
  action: "buy" | "sell",
  value: string,
) {
  const units = parseAmount(value),
    user = new PublicKey(address);
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
    userToken = getAssociatedTokenAddressSync(token, user);
  const data = Buffer.alloc(16);
  data.set(
    action === "buy"
      ? [102, 6, 61, 18, 1, 218, 235, 234]
      : [51, 230, 133, 164, 1, 127, 131, 173],
  );
  new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(8, units, true);
  const transaction = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userUsdc,
      user,
      usdc,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userToken,
      user,
      token,
    ),
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
      ],
      data,
    }),
  );
  const lifetime = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = lifetime.blockhash;
  transaction.feePayer = user;
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
  ]);
  const rent =
    missing.filter((a) => !a).length *
    (await connection.getMinimumBalanceForRentExemption(165));
  return { transaction, feeLamports: fee.value, rentLamports: rent, lifetime };
}
