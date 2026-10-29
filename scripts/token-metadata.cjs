// User-run devnet metadata creation. Default mode only simulates; --send requires confirmation.
const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createInterface } = require('node:readline/promises');
const path = require('node:path');
const webRequire = createRequire(path.resolve(__dirname, '../web/package.json'));
const { Connection, PublicKey, TransactionMessage, VersionedTransaction, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY } = webRequire('@solana/web3.js');
const { getMint } = webRequire('@solana/spl-token');
const { signInitialization } = require('./sign-transaction.cjs');
const PROGRAM = new PublicKey('AVnHeHrsjCdY55sygvLMmehrZHLBZknEZL1BnEPP5tKs');
const AUTHORITY = new PublicKey('GbDLTR4JK4EdZAtjXqAVDx3vWg2BwwEiESxsLqhDNEiG');
const USDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const MPL = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const [VAULT] = PublicKey.findProgramAddressSync([Buffer.from('vault'), USDC.toBuffer()], PROGRAM);
const [MINT] = PublicKey.findProgramAddressSync([Buffer.from('token'), VAULT.toBuffer()], PROGRAM);
const [METADATA] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), MPL.toBuffer(), MINT.toBuffer()], MPL);
const NAME = 'BROBETS', SYMBOL = 'BB', URI = 'https://alexnham.github.io/storage/brobets.json';

function metadataInstruction() {
  return new TransactionInstruction({ programId: PROGRAM, keys: [
    { pubkey: AUTHORITY, isSigner: true, isWritable: true },
    { pubkey: VAULT, isSigner: false, isWritable: false },
    { pubkey: MINT, isSigner: false, isWritable: false },
    { pubkey: METADATA, isSigner: false, isWritable: true },
    { pubkey: MPL, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ], data: createHash('sha256').update('global:create_token_metadata').digest().subarray(0, 8) });
}

function verifyMetadata(account) {
  if (!account || !account.owner.equals(MPL)) throw Error('Metadata is missing or has the wrong owner.');
  const data = account.data;
  let offset = 0;
  function take(length) {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > data.length) throw Error('Truncated metadata.');
    const bytes = data.subarray(offset, offset + length); offset += length; return bytes;
  }
  function text(max) {
    const length = take(4).readUInt32LE();
    if (length > max) throw Error('Invalid metadata string length.');
    return take(length).toString('utf8').replace(/\0+$/, '');
  }
  if (take(1)[0] !== 4) throw Error('Wrong metadata discriminator.');
  const authority = new PublicKey(take(32)), mint = new PublicKey(take(32));
  const name = text(32), symbol = text(10), uri = text(200);
  const royalties = take(2).readUInt16LE();
  // This project creates metadata with no creators or royalties.
  if (take(1)[0] !== 0) throw Error('Unexpected metadata creators.');
  take(1); // primary_sale_happened
  const mutable = take(1)[0];
  if (!authority.equals(AUTHORITY) || !mint.equals(MINT) || name !== NAME || symbol !== SYMBOL || uri !== URI || royalties !== 0 || mutable !== 1) throw Error('Metadata does not match the requested branding and authority.');
  return { name, symbol, uri, updateAuthority: authority.toBase58(), mutable: true };
}

async function prepare(connection) {
  if (await connection.getGenesisHash() !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw Error('Devnet required.');
  const existing = await connection.getAccountInfo(METADATA, 'confirmed');
  if (existing) { verifyMetadata(existing); return { existing: true }; }
  const mint = await getMint(connection, MINT, 'confirmed');
  if (mint.decimals !== 6 || !mint.mintAuthority?.equals(VAULT)) throw Error('Unexpected token mint configuration.');
  const program = await connection.getAccountInfo(MPL, 'confirmed');
  if (!program?.executable) throw Error('Metaplex program unavailable.');
  const lifetime = await connection.getLatestBlockhash('confirmed');
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: AUTHORITY,
    recentBlockhash: lifetime.blockhash, instructions: [metadataInstruction()] }).compileToV0Message());
  const balance = await connection.getBalance(AUTHORITY, 'confirmed');
  const simulation = await connection.simulateTransaction(transaction, { sigVerify: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [AUTHORITY.toBase58(), METADATA.toBase58()] } });
  if (simulation.value.err) throw Error(`Metadata simulation failed. Upgrade the devnet program first if it does not recognize create_token_metadata.\n${JSON.stringify(simulation.value.err)}\n${simulation.value.logs?.join('\n')}`);
  const fee = (await connection.getFeeForMessage(transaction.message, 'confirmed')).value;
  const simulatedPayer = simulation.value.accounts?.[0];
  const simulatedMetadata = simulation.value.accounts?.[1];
  if (fee === null || !simulatedPayer || !simulatedMetadata) throw Error('Cost estimate unavailable.');
  verifyMetadata({ owner: new PublicKey(simulatedMetadata.owner), data: Buffer.from(simulatedMetadata.data[0], 'base64') });
  // Includes any Metaplex charges in addition to rent and the network fee.
  const estimatedCostLamports = balance - simulatedPayer.lamports;
  if (estimatedCostLamports < fee || balance < estimatedCostLamports) throw Error('Invalid estimate or insufficient SOL.');
  return { existing: false, transaction, lifetime, fee, estimatedCostLamports };
}

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--send')) throw Error('Usage: node scripts/token-metadata.cjs [--send]');
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  console.log(JSON.stringify({ cluster: 'devnet', program: PROGRAM.toBase58(), mint: MINT.toBase58(), metadata: METADATA.toBase58(), name: NAME, symbol: SYMBOL, uri: URI, updateAuthority: AUTHORITY.toBase58(), mutable: true }, null, 2));
  const prepared = await prepare(connection);
  if (prepared.existing) { console.log('Metadata already exists and matches. Nothing sent.'); return; }
  console.log(`Simulation passed. Estimated total cost: ${prepared.estimatedCostLamports / 1e9} SOL (including network fee ${prepared.fee / 1e9} SOL).`);
  if (!process.argv.includes('--send')) { console.log('Review only. Run node scripts/token-metadata.cjs --send to sign locally.'); return; }
  if (!process.stdin.isTTY) throw Error('Signing requires an interactive terminal.');
  const config = execFileSync('solana', ['config', 'get'], { encoding: 'utf8' });
  const walletPath = config.match(/^Keypair Path:\s*(.+)$/m)?.[1]?.trim();
  if (!walletPath || !path.isAbsolute(walletPath)) throw Error('Configure an absolute local CLI wallet path.');
  if (execFileSync('solana', ['address', '--keypair', walletPath], { encoding: 'utf8' }).trim() !== AUTHORITY.toBase58()) throw Error('CLI wallet must match the metadata authority.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try { answer = await prompt.question('Type CREATE METADATA DEVNET to sign and send: '); } finally { prompt.close(); }
  if (answer !== 'CREATE METADATA DEVNET') { console.log('Cancelled. Nothing sent.'); return; }
  const fresh = await prepare(connection);
  if (fresh.existing) { console.log('Metadata already exists. Nothing sent.'); return; }
  if (fresh.estimatedCostLamports !== prepared.estimatedCostLamports) throw Error('Cost changed. Run again to review.');
  signInitialization(fresh.transaction, Uint8Array.from(JSON.parse(readFileSync(walletPath, 'utf8'))), AUTHORITY.toBase58());
  const simulation = await connection.simulateTransaction(fresh.transaction, { sigVerify: true, commitment: 'confirmed' });
  if (simulation.value.err) throw Error(`Signed simulation failed: ${JSON.stringify(simulation.value.err)}. Nothing sent.`);
  const signature = webRequire('bs58').default.encode(fresh.transaction.signatures[0]);
  console.log(`Signature: ${signature}\nExplorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  await connection.sendRawTransaction(fresh.transaction.serialize(), { skipPreflight: false, maxRetries: 3 });
  const confirmation = await connection.confirmTransaction({ ...fresh.lifetime, signature }, 'confirmed');
  if (confirmation.value.err) throw Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  console.log('Metadata created and verified:', verifyMetadata(await connection.getAccountInfo(METADATA, 'confirmed')));
}
module.exports = { metadataInstruction, verifyMetadata, prepare };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
