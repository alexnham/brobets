import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { signInitialization } = require("../../scripts/initialize.cjs");
const { Keypair, TransactionMessage, VersionedTransaction, SystemProgram } = require("@solana/web3.js");
const nacl = require("tweetnacl");

function fixture() {
  const payer = Keypair.generate();
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message());
  return { payer, transaction };
}

test("CLI signatures remain valid after temporary key cleanup", () => {
  const { payer, transaction } = fixture();
  const secret = new Uint8Array(payer.secretKey);
  signInitialization(transaction, secret, payer.publicKey.toBase58());
  assert.ok(secret.every(byte => byte === 0));
  assert.ok(nacl.sign.detached.verify(transaction.message.serialize(), transaction.signatures[0], payer.publicKey.toBytes()));
  transaction.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
  assert.equal(nacl.sign.detached.verify(transaction.message.serialize(), transaction.signatures[0], payer.publicKey.toBytes()), false);
});

test("CLI rejects a different payer and still clears the temporary key", () => {
  const { payer, transaction } = fixture();
  const secret = new Uint8Array(payer.secretKey);
  assert.throws(() => signInitialization(transaction, secret, Keypair.generate().publicKey.toBase58()), /Wallet changed/);
  assert.ok(secret.every(byte => byte === 0));
  assert.ok(transaction.signatures[0].every((byte: number) => byte === 0));
});
