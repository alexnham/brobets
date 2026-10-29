const { createRequire } = require('node:module');
const path = require('node:path');
const webRequire = createRequire(path.resolve(__dirname, '../web/package.json'));
const { Keypair } = webRequire('@solana/web3.js');

function signInitialization(transaction, secret, expectedPayer) {
  let signer;
  try {
    signer = Keypair.fromSecretKey(secret);
    if (signer.publicKey.toBase58() !== expectedPayer) throw Error('Wallet changed. Nothing sent.');
    transaction.sign([signer]);
    const valid = webRequire('tweetnacl').sign.detached.verify(
      transaction.message.serialize(), transaction.signatures[0], signer.publicKey.toBytes(),
    );
    if (!valid) throw Error('Local signature verification failed. Nothing sent.');
  } finally {
    // Keypair retains this buffer: clear it only after signing and verification.
    secret.fill(0);
    if (signer) signer.secretKey.fill(0);
  }
}

module.exports = { signInitialization };
