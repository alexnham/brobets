import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, TransactionInstruction } from "@solana/web3.js";
import { getMint, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export const INITIALIZE_PAYER = "GbDLTR4JK4EdZAtjXqAVDx3vWg2BwwEiESxsLqhDNEiG";
export const INITIALIZE_PROGRAM = new PublicKey("AVnHeHrsjCdY55sygvLMmehrZHLBZknEZL1BnEPP5tKs");
export const INITIALIZE_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const [vault, bump] = PublicKey.findProgramAddressSync([Buffer.from("vault"), INITIALIZE_USDC.toBuffer()], INITIALIZE_PROGRAM);
const [tokenMint] = PublicKey.findProgramAddressSync([Buffer.from("token"), vault.toBuffer()], INITIALIZE_PROGRAM);
const [reserve] = PublicKey.findProgramAddressSync([Buffer.from("reserve"), vault.toBuffer()], INITIALIZE_PROGRAM);
export const INITIALIZE_ACCOUNTS = { vault, tokenMint, reserve };

export async function verifyVaultInitialized(connection: Connection) {
  const info = await connection.getAccountInfo(vault, "confirmed");
  if (!info || !info.owner.equals(INITIALIZE_PROGRAM) || info.data.length !== 73 ||
      !info.data.subarray(0, 8).equals(Buffer.from([211, 8, 232, 43, 2, 152, 117, 119])) ||
      !info.data.subarray(8, 40).equals(INITIALIZE_USDC.toBuffer()) ||
      !info.data.subarray(40, 72).equals(tokenMint.toBuffer()) || info.data[72] !== bump) {
    throw Error("Vault state does not match the expected configuration.");
  }
  const [mint, account] = await Promise.all([
    getMint(connection, tokenMint, "confirmed"), getAccount(connection, reserve, "confirmed"),
  ]);
  if (mint.decimals !== 6 || !mint.mintAuthority?.equals(vault) || mint.freezeAuthority !== null ||
      !account.mint.equals(INITIALIZE_USDC) || !account.owner.equals(vault) || account.isFrozen ||
      account.delegate !== null || account.closeAuthority !== null) {
    throw Error("Unexpected vault token or reserve configuration.");
  }
}

export function initializeInstruction(address: string) {
  if (address !== INITIALIZE_PAYER) throw Error(`Connect the payer wallet ${INITIALIZE_PAYER}.`);
  return new TransactionInstruction({ programId: INITIALIZE_PROGRAM, keys: [
    { pubkey: new PublicKey(address), isSigner: true, isWritable: true },
    { pubkey: INITIALIZE_USDC, isSigner: false, isWritable: false },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: tokenMint, isSigner: false, isWritable: true },
    { pubkey: reserve, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data: Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]) });
}

export async function prepareVaultInitialize(connection: Connection, address: string) {
  const instruction = initializeInstruction(address);
  if (await connection.getGenesisHash() !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw Error("Devnet is required.");
  const program = await connection.getAccountInfo(INITIALIZE_PROGRAM, "confirmed");
  if (!program?.executable || !program.owner.equals(new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))) throw Error("Program is not deployed on devnet.");
  const quote = await getMint(connection, INITIALIZE_USDC, "confirmed");
  if (quote.decimals !== 6 || !quote.isInitialized) throw Error("Unexpected USDC mint.");
  const existing = await connection.getMultipleAccountsInfo([vault, tokenMint, reserve], "confirmed");
  if (existing.some(Boolean)) {
    await verifyVaultInitialized(connection);
    throw Error("Vault is already initialized. You can buy or redeem tokens.");
  }
  const lifetime = await connection.getLatestBlockhash("confirmed");
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(address), recentBlockhash: lifetime.blockhash, instructions: [instruction] }).compileToV0Message());
  const simulation = await connection.simulateTransaction(transaction, { sigVerify: false, commitment: "confirmed" });
  if (simulation.value.err) throw Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
  const fee = (await connection.getFeeForMessage(transaction.message, "confirmed")).value;
  if (fee === null) throw Error("Fee estimate unavailable. Try again.");
  const rents = await Promise.all([73, 82, 165].map(size => connection.getMinimumBalanceForRentExemption(size)));
  const rentLamports = rents.reduce((sum, value) => sum + value, 0);
  if (await connection.getBalance(new PublicKey(address), "confirmed") < rentLamports + fee) throw Error("Insufficient SOL for fees and rent.");
  return { transaction, lifetime, feeLamports: fee, rentLamports, payer: address };
}
