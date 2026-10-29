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
import { fixtures, transition, DEMO_USER } from "../lib/demo";
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
test("funded proposals, exact matching, no self match, no duplicate match", () => {
  let { wagers, questions } = fixtures();
  wagers = transition(
    wagers,
    questions,
    "propose",
    { questionId: questions[0].id, side: "b", amount: "5.123456" },
    DEMO_USER,
  );
  const proposal = wagers.at(-1)!;
  assert.equal(proposal.units, "5123456");
  assert.throws(() =>
    transition(wagers, questions, "match", { wagerId: proposal.id }, DEMO_USER),
  );
  wagers = transition(
    wagers,
    questions,
    "match",
    { wagerId: proposal.id },
    "rival",
  );
  assert.equal(wagers.at(-1)?.taker, "rival");
  assert.equal(wagers.at(-1)?.units, "5123456");
  assert.throws(() =>
    transition(
      wagers,
      questions,
      "match",
      { wagerId: proposal.id },
      "second-rival",
    ),
  );
  assert.throws(() =>
    transition(
      wagers,
      questions,
      "cancel",
      { wagerId: proposal.id },
      DEMO_USER,
    ),
  );
});
test("only maker cancels unmatched, closed questions reject funding", () => {
  const { wagers, questions } = fixtures();
  assert.throws(() =>
    transition(wagers, questions, "cancel", { wagerId: "w1" }, DEMO_USER),
  );
  assert.equal(
    transition(wagers, questions, "cancel", { wagerId: "w4" }, DEMO_USER).find(
      (w) => w.id === "w4",
    )?.state,
    "cancelled",
  );
  assert.throws(() =>
    transition(
      wagers,
      questions,
      "propose",
      { questionId: "nuggets-suns", side: "a", amount: "5" },
      DEMO_USER,
    ),
  );
});
test("settled winners claim once; losers cannot claim; void returns each stake once", () => {
  let { wagers, questions } = fixtures();
  assert.throws(() =>
    transition(wagers, questions, "claim", { wagerId: "w5" }, "demo-book"),
  );
  wagers = transition(wagers, questions, "claim", { wagerId: "w5" }, DEMO_USER);
  assert.throws(() =>
    transition(wagers, questions, "claim", { wagerId: "w5" }, DEMO_USER),
  );
  ({ wagers, questions } = fixtures());
  questions[3].result = "void";
  wagers = transition(wagers, questions, "claim", { wagerId: "w5" }, DEMO_USER);
  assert.throws(() =>
    transition(wagers, questions, "claim", { wagerId: "w5" }, DEMO_USER),
  );
  wagers = transition(
    wagers,
    questions,
    "claim",
    { wagerId: "w5" },
    "demo-book",
  );
  assert.equal(wagers.find((w) => w.id === "w5")?.state, "claimed");
});
test("unmatched and expired wagers can be refunded", () => {
  let { wagers, questions } = fixtures();
  const now = Date.now() + 40 * 3600000;
  wagers = transition(
    wagers,
    questions,
    "claim",
    { wagerId: "w4" },
    DEMO_USER,
    now,
  );
  assert.equal(wagers.find((w) => w.id === "w4")?.state, "claimed");
});
