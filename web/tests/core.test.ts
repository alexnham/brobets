import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  challengeMessage,
  verifySignature,
  isAdmin,
  hashToken,
} from "../lib/auth-core";
import { parseAmount, formatAmount } from "../lib/money";
test("exact fractional amounts and u64 pot boundary", () => {
  for (const amount of ["0.000001", "5", "5.123456", "9007199254.123456"])
    assert.equal(formatAmount(parseAmount(amount)), amount);
  for (const amount of [
    "0",
    "-5",
    "1e3",
    "01",
    "1.0000001",
    "NaN",
    "18446744073709.551615",
  ])
    assert.throws(() => parseAmount(amount));
});
test("Helius hexadecimal signatures verify and cannot cross wallets or challenges", () => {
  const keys = nacl.sign.keyPair();
  const wallet = bs58.encode(keys.publicKey);
  const message = challengeMessage(
    wallet,
    "nonce",
    "https://brobets.example",
    new Date(),
  );
  const sig = Buffer.from(
    nacl.sign.detached(new TextEncoder().encode(message), keys.secretKey),
  ).toString("hex");
  assert.equal(verifySignature(message, sig, wallet), true);
  assert.equal(verifySignature(message + "other", sig, wallet), false);
  assert.equal(
    verifySignature(message, sig, bs58.encode(nacl.sign.keyPair().publicKey)),
    false,
  );
  assert.equal(verifySignature(message, "invalid", wallet), false);
  assert.equal(isAdmin(wallet, wallet), true);
  assert.equal(isAdmin(wallet, ""), false);
  assert.equal(isAdmin("attacker", wallet), false);
  assert.notEqual(hashToken("a"), hashToken("b"));
});
