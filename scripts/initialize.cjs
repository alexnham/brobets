// Run locally by the wallet owner. No key material is printed or transmitted.
const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { createInterface } = require('node:readline/promises');
const webRequire = createRequire(path.resolve(__dirname, '../web/package.json'));
const { Connection } = webRequire('@solana/web3.js');
const { prepareVaultInitialize, verifyVaultInitialized, INITIALIZE_PAYER, INITIALIZE_PROGRAM, INITIALIZE_USDC, INITIALIZE_ACCOUNTS } = webRequire('tsx/cjs/api').require('../web/lib/initialize-vault.ts', __filename);

const { signInitialization } = require('./sign-transaction.cjs');

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--send')) throw Error('Usage: node scripts/initialize.cjs [--send]');
  const send = process.argv.includes('--send');
  const config = execFileSync('solana', ['config', 'get'], { encoding: 'utf8' });
  const walletPath = config.match(/^Keypair Path:\s*(.+)$/m)?.[1]?.trim();
  if (!walletPath || !path.isAbsolute(walletPath)) throw Error('Configure an absolute local Solana CLI keypair path first.');
  const payerAddress = execFileSync('solana', ['address', '--keypair', walletPath], { encoding: 'utf8' }).trim();
  if (payerAddress !== INITIALIZE_PAYER) throw Error(`CLI wallet is ${payerAddress}; expected payer is ${INITIALIZE_PAYER}. No transaction sent.`);
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const prepared = await prepareVaultInitialize(connection, payerAddress);
  console.log('Cluster: devnet');
  console.log(`Program: ${INITIALIZE_PROGRAM}`);
  console.log(`Payer: ${payerAddress}`);
  console.log(`USDC mint: ${INITIALIZE_USDC}`);
  for (const [name, account] of Object.entries(INITIALIZE_ACCOUNTS)) console.log(`${name}: ${account}`);
  console.log('USDC transferred: 0');
  console.log(`Account rent: ${prepared.rentLamports / 1e9} SOL`);
  console.log(`Transaction fee: ${prepared.feeLamports / 1e9} SOL`);
  console.log('Simulation passed.');
  if (!send) { console.log('Review only. To sign and initialize, run: node scripts/initialize.cjs --send'); return; }
  if (!process.stdin.isTTY) throw Error('Signing requires an interactive terminal.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try { answer = await prompt.question('Type INITIALIZE DEVNET to sign and send: '); }
  finally { prompt.close(); }
  if (answer !== 'INITIALIZE DEVNET') { console.log('Cancelled. Nothing signed or sent.'); return; }
  // Refresh and simulate after confirmation so the reviewed blockhash cannot expire while reading.
  const fresh = await prepareVaultInitialize(connection, payerAddress);
  if (fresh.feeLamports !== prepared.feeLamports || fresh.rentLamports !== prepared.rentLamports) throw Error('Cost changed. Run again to review.');
  const secret = Uint8Array.from(JSON.parse(readFileSync(walletPath, 'utf8')));
  signInitialization(fresh.transaction, secret, payerAddress);
  const signedSimulation = await connection.simulateTransaction(fresh.transaction, { sigVerify: true, commitment: 'confirmed' });
  if (signedSimulation.value.err) throw Error(`Signed simulation failed: ${JSON.stringify(signedSimulation.value.err)}. Nothing sent.`);
  // Print the signature before broadcasting so even an interrupted RPC call is recoverable.
  const signatureBytes = fresh.transaction.signatures[0];
  if (!signatureBytes) throw Error('Missing transaction signature.');
  const bs58 = webRequire('bs58').default;
  const signature = bs58.encode(signatureBytes);
  console.log(`Signature: ${signature}`);
  console.log(`Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  await connection.sendRawTransaction(fresh.transaction.serialize(), { skipPreflight: false, maxRetries: 3 });
  const result = await connection.confirmTransaction({ ...fresh.lifetime, signature }, 'confirmed');
  if (result.value.err) throw Error(`Initialization failed: ${JSON.stringify(result.value.err)}`);
  await verifyVaultInitialized(connection);
  console.log('Initialized. Vault accounts verified.');
}
module.exports = { signInitialization };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
