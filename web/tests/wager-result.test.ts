import { test } from "node:test";
import assert from "node:assert/strict";
import { wagerResult, type Question, type Wager } from "../lib/escrow";
const q: Question = { id: "q", title: "Who wins the game?", sideA: "A", sideB: "B", closesAt: new Date(0).toISOString(), resolveBy: new Date(1000).toISOString(), matchup: "A / B", category: "Game winner", result: "a" };
const w: Wager = { id: "w", questionId: q.id, maker: "maker", taker: "taker", side: "a", units: "5000000", state: "matched" };

test("winners remain recognizable after claiming, from either side of the wager", () => {
  assert.equal(wagerResult(q, w, "maker"), "won");
  assert.equal(wagerResult(q, w, "taker"), "lost");
  assert.equal(wagerResult({ ...q, result: "b" }, w, "taker"), "won");
  assert.equal(wagerResult(q, { ...w, state: "claimed", claimedBy: ["maker"] }, "maker"), "won");
  assert.equal(wagerResult(q, { ...w, state: "claimed", claimedBy: ["maker"] }, "taker"), "lost");
});

test("refunds, unmatched proposals, cancelled bets, and pending results are never wins", () => {
  assert.equal(wagerResult({ ...q, result: "void" }, w, "maker"), undefined);
  assert.equal(wagerResult({ ...q, result: undefined }, w, "maker"), undefined);
  assert.equal(wagerResult(q, { ...w, state: "open", taker: undefined }, "maker"), undefined);
  assert.equal(wagerResult(q, { ...w, state: "cancelled" }, "maker"), undefined);
  assert.equal(wagerResult(q, w, "stranger"), undefined);
  assert.equal(wagerResult(q, w, null), undefined);
});
