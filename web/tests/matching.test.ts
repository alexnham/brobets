import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Connection,
  PublicKey,
  Keypair,
  type AccountInfo,
  type VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import idl from "../lib/matching-idl.json";
import {
  deployment,
  u64,
  MATCH_ADMIN,
  decodeQuestion,
  decodeWager,
  readMatching,
  prepareMatching,
  claimAmount,
} from "../lib/matching";
function fixture() {
  process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID = idl.address;
  process.env.NEXT_PUBLIC_USDC_MINT =
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const d = deployment(),
    maker = Keypair.generate().publicKey,
    taker = Keypair.generate().publicKey;
  const disc = (name: string) =>
    Buffer.from(idl.accounts.find((a) => a.name === name)!.discriminator);
  const txt = (v: string) => {
    const b = Buffer.from(v),
      len = Buffer.alloc(4);
    new DataView(len.buffer, len.byteOffset, 4).setUint32(0, b.length, true);
    return Buffer.concat([len, b]);
  };
  const now = Math.floor(Date.now() / 1000),
    qid = 42n,
    pid = 7n;
  const qkey = d.derive(Buffer.from("question_v1"), u64(qid)),
    wkey = d.derive(
      Buffer.from("wager_v1"),
      qkey.toBytes(),
      maker.toBytes(),
      u64(pid),
    );
  const qdata = Buffer.alloc(502);
  Buffer.concat([
    disc("MatchQuestion"),
    new PublicKey(MATCH_ADMIN).toBuffer(),
    d.market.toBuffer(),
    d.mint.toBuffer(),
    u64(qid),
    u64(BigInt(now + 3600)),
    u64(BigInt(now + 7200)),
    Buffer.from([0, 255]),
    txt("Who wins this basketball game?"),
    txt("Lakers"),
    txt("Warriors"),
  ]).copy(qdata);
  const wdata = Buffer.concat([
    disc("MatchedWager"),
    qkey.toBuffer(),
    maker.toBuffer(),
    PublicKey.default.toBuffer(),
    u64(pid),
    u64(5123456n),
    Buffer.from([1, 0, 0, 0, 255]),
  ]);
  const market = Buffer.concat([
    disc("MatchMarket"),
    new PublicKey(MATCH_ADMIN).toBuffer(),
    d.vault.toBuffer(),
    d.mint.toBuffer(),
    Buffer.from([1, 255]),
  ]);
  const account = (data: Buffer, owner = d.program): AccountInfo<Buffer> => ({
    data,
    owner,
    lamports: 10000000,
    executable: false,
    rentEpoch: 0,
  });
  const escrow = d.derive(Buffer.from("wager_escrow_v1"), wkey.toBytes());
  const escrowData = Buffer.alloc(165);
  d.mint.toBuffer().copy(escrowData);
  wkey.toBuffer().copy(escrowData, 32);
  u64(5123456n).copy(escrowData, 64);
  escrowData[108] = 1;
  const records = new Map([
    [d.market.toBase58(), account(market)],
    [qkey.toBase58(), account(qdata)],
    [wkey.toBase58(), account(wdata)],
    [escrow.toBase58(), account(escrowData, TOKEN_PROGRAM_ID)],
  ]);
  let simulateError = false;
  const connection = {
    getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    getAccountInfo: async (key: PublicKey) =>
      records.get(key.toBase58()) ?? null,
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((k) => records.get(k.toBase58()) ?? null),
    getProgramAccounts: async (
      _: PublicKey,
      config: { filters: { memcmp: { offset: number; bytes: string } }[] },
    ) =>
      config.filters[0].memcmp.bytes ===
      (await import("bs58")).default.encode(disc("MatchQuestion"))
        ? [{ pubkey: qkey, account: account(qdata) }]
        : [{ pubkey: wkey, account: account(wdata) }],
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1000,
    }),
    simulateTransaction: async (_: VersionedTransaction) => ({
      value: {
        err: simulateError
          ? { InstructionError: [0, "InvalidInstructionData"] }
          : null,
        logs: [],
      },
    }),
    getFeeForMessage: async () => ({ value: 5000 }),
    getMinimumBalanceForRentExemption: async (n: number) => n * 10,
  } as unknown as Connection;
  return {
    d,
    maker,
    taker,
    qkey,
    wkey,
    qdata,
    wdata,
    account,
    records,
    escrowData,
    escrow,
    connection,
    setFailure: () => {
      simulateError = true;
    },
  };
}
test("matching codecs reject noncanonical addresses and owners and read escrow backing", async () => {
  const f = fixture();
  const q = decodeQuestion(f.qkey, f.account(f.qdata)),
    w = decodeWager(f.wkey, f.account(f.wdata));
  assert.equal(q.sideA, "Lakers");
  assert.equal(w.units, "5123456");
  assert.throws(
    () => decodeQuestion(Keypair.generate().publicKey, f.account(f.qdata)),
    /Noncanonical/,
  );
  assert.throws(
    () => decodeWager(f.wkey, f.account(f.wdata, TOKEN_PROGRAM_ID)),
    /owner/,
  );
  assert.equal((await readMatching(f.connection)).wagers[0].id, w.id);
  u64(0n).copy(f.escrowData, 64);
  await assert.rejects(readMatching(f.connection), /below/);
  f.records.delete(f.d.market.toBase58());
  assert.equal((await readMatching(f.connection)).ready, false);
});
test("preparation encodes exact stakes, validates full matching and rejects self-matching", async (t) => {
  const f = fixture(),
    q = decodeQuestion(f.qkey, f.account(f.qdata)),
    w = decodeWager(f.wkey, f.account(f.wdata));
  t.mock.method(Buffer.prototype, "writeBigUInt64LE", () => {
    throw Error("No Node bigint writer in browsers");
  });
  const p = await prepareMatching(f.connection, f.maker.toBase58(), "propose", {
    question: q,
    side: "a",
    amount: "5.123456",
  });
  const ix = p.transaction.instructions.at(-1)!;
  assert.equal(
    new DataView(ix.data.buffer, ix.data.byteOffset + 17, 8).getBigUint64(
      0,
      true,
    ),
    5123456n,
  );
  assert.equal(p.stake, "5123456");
  assert.equal(p.payout, "10246912");
  assert.equal(p.rentLamports, 2900);
  await assert.rejects(
    prepareMatching(f.connection, f.maker.toBase58(), "match", {
      question: q,
      wager: w,
    }),
    /cannot be matched/,
  );
  const m = await prepareMatching(f.connection, f.taker.toBase58(), "match", {
    question: q,
    wager: w,
  });
  assert.equal(m.stake, w.units);
  const expected = idl.instructions.find((i) => i.name === "match_wager")!;
  assert.deepEqual(
    [...m.transaction.instructions[0].data],
    expected.discriminator,
  );
  assert.equal(
    m.transaction.instructions[0].keys[5].pubkey.toBase58(),
    getAssociatedTokenAddressSync(f.d.mint, f.taker).toBase58(),
  );
  f.setFailure();
  await assert.rejects(
    prepareMatching(f.connection, f.taker.toBase58(), "match", {
      question: q,
      wager: w,
    }),
    /Simulation failed/,
  );
});
test("admin-only immutable question content and explicit winner or refund amounts", async () => {
  const f = fixture(),
    q = decodeQuestion(f.qkey, f.account(f.qdata)),
    w = decodeWager(f.wkey, f.account(f.wdata));
  const draft = {
    title: q.title,
    sideA: q.sideA,
    sideB: q.sideB,
    closesAt: q.closesAt,
    resolveBy: q.resolveBy,
  };
  await assert.rejects(
    prepareMatching(f.connection, f.maker.toBase58(), "create", { draft }),
    /admin/,
  );
  const p = await prepareMatching(f.connection, MATCH_ADMIN, "create", {
    draft,
  });
  assert.equal(p.question?.title, q.title);
  assert.equal(p.rentLamports, 5020);
  await assert.rejects(
    prepareMatching(f.connection, MATCH_ADMIN, "create", {
      draft: { ...draft, title: "🏀".repeat(60) },
    }),
    /200 bytes/,
  );
  const matched = {
    ...w,
    state: "matched" as const,
    taker: f.taker.toBase58(),
  };
  assert.equal(
    claimAmount({ ...q, result: "a" }, matched, f.maker.toBase58()),
    10246912n,
  );
  assert.equal(
    claimAmount({ ...q, result: "a" }, matched, f.taker.toBase58()),
    0n,
  );
  assert.equal(
    claimAmount({ ...q, result: "void" }, matched, f.taker.toBase58()),
    5123456n,
  );
  assert.equal(
    claimAmount(
      { ...q, result: "void" },
      { ...matched, claimedBy: [f.taker.toBase58()] },
      f.taker.toBase58(),
    ),
    0n,
  );
  assert.equal(
    claimAmount(q, matched, f.taker.toBase58(), Date.parse(q.resolveBy)),
    5123456n,
  );
});
