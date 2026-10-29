// Read-only preparation: never loads keys, signs, or broadcasts a transaction.
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const path = require('node:path');
const webRequire = createRequire(path.resolve(__dirname, '../web/package.json'));
const { Connection, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } = webRequire('@solana/web3.js');
const { getMint, TOKEN_PROGRAM_ID } = webRequire('@solana/spl-token');

async function main() {
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const programId = new PublicKey('AVnHeHrsjCdY55sygvLMmehrZHLBZknEZL1BnEPP5tKs');
  const usdcMint = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  const payer = new PublicKey('GbDLTR4JK4EdZAtjXqAVDx3vWg2BwwEiESxsLqhDNEiG');
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault'), usdcMint.toBuffer()], programId);
  const [tokenMint] = PublicKey.findProgramAddressSync([Buffer.from('token'), vault.toBuffer()], programId);
  const [reserve] = PublicKey.findProgramAddressSync([Buffer.from('reserve'), vault.toBuffer()], programId);
  const program = await connection.getAccountInfo(programId);
  if (!program?.executable || !program.owner.equals(new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))) throw Error('Expected upgradeable program is not deployed on devnet.');
  const quote = await getMint(connection, usdcMint, 'confirmed', TOKEN_PROGRAM_ID);
  if (quote.decimals !== 6 || !quote.isInitialized) throw Error('Quote mint must be initialized with six decimals.');
  const existing = await connection.getMultipleAccountsInfo([vault, tokenMint, reserve]);
  if (existing.some(Boolean)) throw Error('A derived account already exists. Inspect existing vault state before initializing.');
  const instruction = new TransactionInstruction({ programId, keys: [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: usdcMint, isSigner: false, isWritable: false },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: tokenMint, isSigner: false, isWritable: true },
    { pubkey: reserve, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data: createHash('sha256').update('global:initialize').digest().subarray(0, 8) });
  // v0 is compatible with the existing web wallet client.
  const lifetime = await connection.getLatestBlockhash();
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: payer,
    recentBlockhash: lifetime.blockhash, instructions: [instruction] }).compileToV0Message());
  const simulation = await connection.simulateTransaction(transaction, { sigVerify: false, commitment: 'confirmed' });
  if (simulation.value.err) throw Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}\n${simulation.value.logs?.join('\n')}`);
  const fee = (await connection.getFeeForMessage(transaction.message)).value;
  if (fee === null) throw Error('Fee estimate unavailable. Retry.');
  const rents = await Promise.all([73, 82, 165].map(size => connection.getMinimumBalanceForRentExemption(size)));
  const rent = rents.reduce((sum, value) => sum + value, 0);
  const balance = await connection.getBalance(payer);
  if (balance < rent + fee) throw Error('Payer has insufficient SOL for rent and transaction fee.');
  console.log(JSON.stringify({ cluster: 'devnet', programId: programId.toBase58(), payer: payer.toBase58(),
    usdcMint: usdcMint.toBase58(), vault: vault.toBase58(), tokenMint: tokenMint.toBase58(), reserve: reserve.toBase58(),
    usdcTransferred: '0', rentLamports: rent, feeLamports: fee, payerBalanceLamports: balance,
    simulation: 'passed', unitsConsumed: simulation.value.unitsConsumed,
    transactionVersion: 0, lastValidBlockHeight: lifetime.lastValidBlockHeight,
    unsignedTransactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
    nextStep: 'Review and sign with the payer wallet. Re-run preparation if the blockhash expires.' }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
