import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  SystemProgram,
  type AccountInfo,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import idl from "./matching-idl.json";
import { parseAmount } from "./money";
import type { Question, Wager, Side } from "./escrow";

export const MATCH_ADMIN = "ERsc4ugZCfht4joqXWgVqtb222KUorwTuoD4Nc17wsB8";
export type QuestionDraft = {
  title: string;
  sideA: string;
  sideB: string;
  closesAt: string;
  resolveBy: string;
};
export type MatchAction =
  | "initialize"
  | "create"
  | "edit"
  | "propose"
  | "match"
  | "cancel"
  | "claim"
  | "resolve"
  | "expire";
export type MatchInput = {
  question?: Question;
  wager?: Wager;
  draft?: QuestionDraft;
  side?: Side;
  amount?: string;
  outcome?: Side | "void";
};
export type MarketSnapshot = {
  ready: boolean;
  admin: string;
  questions: Question[];
  wagers: Wager[];
};
export function deployment() {
  const program = new PublicKey(process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID!);
  const usdc = new PublicKey(process.env.NEXT_PUBLIC_USDC_MINT!);
  const derive = (...seeds: Uint8Array[]) =>
    PublicKey.findProgramAddressSync(seeds, program)[0];
  const vault = derive(Buffer.from("vault"), usdc.toBytes());
  return {
    program,
    vault,
    mint: derive(Buffer.from("token"), vault.toBytes()),
    market: derive(Buffer.from("matching_v1")),
    derive,
  };
}
export function u64(value: bigint) {
  const b = Buffer.alloc(8);
  new DataView(b.buffer, b.byteOffset, 8).setBigUint64(0, value, true);
  return b;
}
function i64(value: number) {
  if (!Number.isSafeInteger(value)) throw Error("Invalid timestamp");
  const b = Buffer.alloc(8);
  new DataView(b.buffer, b.byteOffset, 8).setBigInt64(0, BigInt(value), true);
  return b;
}
function text(value: string, max: number) {
  const bytes = Buffer.from(value);
  if (!value.trim() || bytes.length > max)
    throw Error(`Text exceeds ${max} bytes or is empty`);
  const len = Buffer.alloc(4);
  new DataView(len.buffer, len.byteOffset, 4).setUint32(0, bytes.length, true);
  return Buffer.concat([len, bytes]);
}
function discriminator(name: string, account = false) {
  const row = (account ? idl.accounts : idl.instructions).find(
    (x) => x.name === name,
  );
  if (!row) throw Error("Unknown matching ABI");
  return Buffer.from(row.discriminator);
}
class Reader {
  offset = 8;
  constructor(public data: Buffer) {}
  bytes(n: number) {
    if (this.offset + n > this.data.length)
      throw Error("Truncated matching account");
    const b = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return b;
  }
  key() {
    return new PublicKey(this.bytes(32)).toBase58();
  }
  u64() {
    const b = this.bytes(8);
    return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
  }
  time() {
    const b = this.bytes(8);
    const n = Number(
      new DataView(b.buffer, b.byteOffset, 8).getBigInt64(0, true),
    );
    if (!Number.isSafeInteger(n)) throw Error("Invalid deadline");
    return new Date(n * 1000).toISOString();
  }
  byte() {
    return this.bytes(1)[0];
  }
  string(max: number) {
    const b = this.bytes(4);
    const len = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
    if (len > max) throw Error("Invalid question content");
    return new TextDecoder("utf-8", { fatal: true }).decode(this.bytes(len));
  }
}
function checked(
  info: AccountInfo<Buffer> | null,
  name: string,
  size?: number,
) {
  if (
    !info ||
    !info.owner.equals(deployment().program) ||
    info.data.length < 8 ||
    !info.data.subarray(0, 8).equals(discriminator(name, true)) ||
    (size !== undefined && info.data.length !== size)
  )
    throw Error("Unexpected matching account owner, discriminator or size");
  return new Reader(info.data);
}
export function decodeQuestion(
  key: PublicKey,
  info: AccountInfo<Buffer>,
): Question {
  const d = deployment(),
    r = checked(info, "MatchQuestion", 502);
  const admin = r.key(),
    market = r.key(),
    mint = r.key(),
    chainId = r.u64(),
    closesAt = r.time(),
    resolveBy = r.time(),
    outcome = r.byte();
  r.byte();
  if (
    admin !== MATCH_ADMIN ||
    market !== d.market.toBase58() ||
    mint !== d.mint.toBase58() ||
    !d.derive(Buffer.from("question_v1"), u64(chainId)).equals(key) ||
    outcome > 3
  )
    throw Error("Noncanonical question");
  const title = r.string(200),
    sideA = r.string(80),
    sideB = r.string(80);
  return {
    id: key.toBase58(),
    chainId: chainId.toString(),
    title,
    sideA,
    sideB,
    closesAt,
    resolveBy,
    matchup: `${sideA} / ${sideB}`,
    category: "Game winner",
    result:
      outcome === 1
        ? "a"
        : outcome === 2
          ? "b"
          : outcome === 3
            ? "void"
            : undefined,
  };
}
export function decodeWager(key: PublicKey, info: AccountInfo<Buffer>): Wager {
  const d = deployment(),
    r = checked(info, "MatchedWager", 125);
  const questionId = r.key(),
    maker = r.key(),
    taker = r.key(),
    proposalId = r.u64(),
    units = r.u64(),
    side = r.byte(),
    state = r.byte(),
    mc = r.byte(),
    tc = r.byte();
  r.byte();
  if (
    !d
      .derive(
        Buffer.from("wager_v1"),
        new PublicKey(questionId).toBytes(),
        new PublicKey(maker).toBytes(),
        u64(proposalId),
      )
      .equals(key) ||
    side < 1 ||
    side > 2 ||
    state > 3 ||
    mc > 1 ||
    tc > 1 ||
    units === 0n ||
    units > 0xffffffffffffffffn / 2n ||
    (state === 1 && taker === PublicKey.default.toBase58())
  )
    throw Error("Invalid wager");
  return {
    id: key.toBase58(),
    questionId,
    maker,
    taker: taker === PublicKey.default.toBase58() ? undefined : taker,
    proposalId: proposalId.toString(),
    units: units.toString(),
    side: side === 1 ? "a" : "b",
    state: (["open", "matched", "cancelled", "claimed"] as const)[state],
    claimedBy: [...(mc ? [maker] : []), ...(tc ? [taker] : [])],
  };
}
export async function readMatching(
  connection: Connection,
): Promise<MarketSnapshot> {
  const d = deployment(),
    info = await connection.getAccountInfo(d.market, "confirmed");
  if (!info)
    return { ready: false, admin: MATCH_ADMIN, questions: [], wagers: [] };
  const r = checked(info, "MatchMarket", 106);
  if (
    r.key() !== MATCH_ADMIN ||
    r.key() !== d.vault.toBase58() ||
    r.key() !== d.mint.toBase58() ||
    r.byte() !== 1
  )
    throw Error("Matching market configuration mismatch");
  const get = (name: string) =>
    connection.getProgramAccounts(d.program, {
      commitment: "confirmed",
      filters: [
        {
          memcmp: { offset: 0, bytes: bs58.encode(discriminator(name, true)) },
        },
      ],
    });
  const [qs, ws] = await Promise.all([
    get("MatchQuestion"),
    get("MatchedWager"),
  ]);
  const questions = qs
    .map((a) => decodeQuestion(a.pubkey, a.account))
    .sort((a, b) => Date.parse(a.closesAt) - Date.parse(b.closesAt));
  const ids = new Set(questions.map((q) => q.id));
  const discovered = ws
    .map((a) => decodeWager(a.pubkey, a.account))
    .filter((w) => ids.has(w.questionId));
  const wagers: Wager[] = [];
  for (let offset = 0; offset < discovered.length; offset += 50) {
    const chunk = discovered.slice(offset, offset + 50);
    // Read each wager and its escrow in the same RPC snapshot so a concurrent
    // claim cannot make an older wager look undercollateralized.
    const accounts = await connection.getMultipleAccountsInfo(
      [
        ...chunk.map((w) => new PublicKey(w.id)),
        ...chunk.map((w) =>
          d.derive(
            Buffer.from("wager_escrow_v1"),
            new PublicKey(w.id).toBytes(),
          ),
        ),
      ],
      "confirmed",
    );
    chunk.forEach((initial, index) => {
      const w = decodeWager(new PublicKey(initial.id), accounts[index]!);
      const info = accounts[chunk.length + index];
      wagers.push(w);
      if (
        !info ||
        !info.owner.equals(TOKEN_PROGRAM_ID) ||
        info.data.length !== 165 ||
        !info.data.subarray(0, 32).equals(d.mint.toBuffer()) ||
        !info.data.subarray(32, 64).equals(new PublicKey(w.id).toBuffer())
      )
        throw Error("Unexpected wager escrow token account");
      const balance = new DataView(
        info.data.buffer,
        info.data.byteOffset + 64,
        8,
      ).getBigUint64(0, true);
      const expected =
        w.state === "open"
          ? BigInt(w.units)
          : w.state === "matched"
            ? BigInt(w.units) * BigInt(2 - (w.claimedBy?.length ?? 0))
            : 0n;
      if (balance < expected)
        throw Error("Wager escrow balance is below its recorded obligations");
    });
  }
  return { ready: true, admin: MATCH_ADMIN, questions, wagers };
}
export function claimAmount(
  q: Question,
  w: Wager,
  user: string,
  now = Date.now(),
): bigint {
  if (
    w.state === "cancelled" ||
    w.state === "claimed" ||
    w.claimedBy?.includes(user) ||
    ![w.maker, w.taker].includes(user)
  )
    return 0n;
  const refund =
    q.result === "void" ||
    (!q.result && now >= Date.parse(q.resolveBy)) ||
    (w.state === "open" && now >= Date.parse(q.closesAt));
  if (refund) return BigInt(w.units);
  const winner = q.result === w.side ? w.maker : w.taker;
  return q.result && w.state === "matched" && winner === user
    ? BigInt(w.units) * 2n
    : 0n;
}
const instructionName: Record<MatchAction, string> = {
  initialize: "initialize_matching",
  create: "create_question",
  edit: "edit_question",
  propose: "propose_wager",
  match: "match_wager",
  cancel: "cancel_wager",
  claim: "claim_wager",
  resolve: "resolve_question",
  expire: "expire_question",
};
export type PreparedMatch = Awaited<ReturnType<typeof prepareMatching>>;
export async function prepareMatching(
  connection: Connection,
  userAddress: string,
  action: MatchAction,
  input: MatchInput,
) {
  if (
    (await connection.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
  )
    throw Error("Matching is devnet only");
  const d = deployment(),
    user = new PublicKey(userAddress),
    tx = new Transaction();
  if (
    ["initialize", "create", "edit", "resolve"].includes(action) &&
    userAddress !== MATCH_ADMIN
  )
    throw Error("Only the configured Helius admin can do this");
  let q = input.question,
    w = input.wager,
    questionKey: PublicKey | undefined,
    wagerKey: PublicKey | undefined;
  const randomId = () =>
    new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer).getBigUint64(
      0,
      true,
    );
  let payload = Buffer.alloc(0),
    stake = 0n,
    payout = 0n,
    rentBytes: number[] = [];
  if (action === "create") {
    const draft = input.draft;
    if (
      !draft ||
      draft.sideA === draft.sideB ||
      Date.parse(draft.closesAt) <= Date.now() ||
      Date.parse(draft.resolveBy) <= Date.parse(draft.closesAt)
    )
      throw Error("Invalid question or deadlines");
    const id = randomId();
    questionKey = d.derive(Buffer.from("question_v1"), u64(id));
    const close = Math.floor(Date.parse(draft.closesAt) / 1000),
      deadline = Math.floor(Date.parse(draft.resolveBy) / 1000);
    payload = Buffer.concat([
      u64(id),
      text(draft.title, 200),
      text(draft.sideA, 80),
      text(draft.sideB, 80),
      i64(close),
      i64(deadline),
    ]);
    q = {
      ...draft,
      id: questionKey.toBase58(),
      chainId: id.toString(),
      category: "Game winner",
      matchup: `${draft.sideA} / ${draft.sideB}`,
      closesAt: new Date(close * 1000).toISOString(),
      resolveBy: new Date(deadline * 1000).toISOString(),
    };
    rentBytes = [502];
  } else if (q) {
    questionKey = new PublicKey(q.id);
    q = decodeQuestion(
      questionKey,
      (await connection.getAccountInfo(questionKey, "confirmed"))!,
    );
  }
  if (action === "edit") {
    const draft = input.draft;
    if (!q || q.result || Date.parse(q.resolveBy) <= Date.now())
      throw Error("Resolved or expired questions cannot be edited");
    if (!draft || !Number.isFinite(Date.parse(draft.closesAt)) ||
        !Number.isFinite(Date.parse(draft.resolveBy)) ||
        Date.parse(draft.closesAt) <= 0 ||
        Date.parse(draft.resolveBy) <= Date.now() ||
        Date.parse(draft.resolveBy) <= Date.parse(draft.closesAt))
      throw Error("Resolve-by must be in the future and after betting closes");
    if (draft.sideA !== q.sideA || draft.sideB !== q.sideB)
      throw Error("Outcomes cannot be changed");
    const close = Math.floor(Date.parse(draft.closesAt) / 1000);
    const deadline = Math.floor(Date.parse(draft.resolveBy) / 1000);
    payload = Buffer.concat([text(draft.title.trim(), 200), i64(close), i64(deadline)]);
    if (draft.title.trim().length < 10) throw Error("Question text is too short");
    q = { ...q, title: draft.title.trim(), closesAt: new Date(close * 1000).toISOString(), resolveBy: new Date(deadline * 1000).toISOString() };
  }
  if (w) {
    wagerKey = new PublicKey(w.id);
    w = decodeWager(
      wagerKey,
      (await connection.getAccountInfo(wagerKey, "confirmed"))!,
    );
    if (w.questionId !== q?.id)
      throw Error("Wager does not belong to question");
    stake = BigInt(w.units);
  }
  if (action === "propose") {
    if (!q || q.result || Date.parse(q.closesAt) <= Date.now() || !input.side)
      throw Error("Betting is closed");
    const id = randomId();
    stake = parseAmount(input.amount ?? "");
    payout = stake * 2n;
    wagerKey = d.derive(
      Buffer.from("wager_v1"),
      questionKey!.toBytes(),
      user.toBytes(),
      u64(id),
    );
    payload = Buffer.concat([
      u64(id),
      Buffer.from([input.side === "a" ? 1 : 2]),
      u64(stake),
    ]);
    rentBytes = [125, 165];
  }
  if (action === "match") {
    if (
      !q ||
      !w ||
      w.state !== "open" ||
      w.maker === userAddress ||
      q.result ||
      Date.parse(q.closesAt) <= Date.now()
    )
      throw Error("Wager cannot be matched");
    payout = stake * 2n;
  }
  if (action === "cancel") {
    if (!w || w.state !== "open" || w.maker !== userAddress)
      throw Error("Only proposer can cancel an open wager");
    payout = stake;
  }
  if (action === "claim") {
    if (!q || !w || (payout = claimAmount(q, w, userAddress)) === 0n)
      throw Error("No payout available");
  }
  if (action === "resolve") {
    if (
      !q ||
      q.result ||
      Date.parse(q.closesAt) > Date.now() ||
      Date.parse(q.resolveBy) <= Date.now()
    )
      throw Error("Resolution is outside its allowed window");
    payload = Buffer.from([
      input.outcome === "a"
        ? 1
        : input.outcome === "b"
          ? 2
          : input.outcome === "void"
            ? 3
            : 0,
    ]);
  }
  if (action === "initialize") rentBytes = [106];
  const tokenAccount = getAssociatedTokenAddressSync(d.mint, user);
  if (
    ["cancel", "claim"].includes(action) &&
    !(await connection.getAccountInfo(tokenAccount, "confirmed"))
  ) {
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        user,
        tokenAccount,
        user,
        d.mint,
      ),
    );
    rentBytes.push(165);
  }
  const escrow = wagerKey
    ? d.derive(Buffer.from("wager_escrow_v1"), wagerKey.toBytes())
    : undefined;
  const accounts: Record<string, PublicKey | undefined> = {
    admin: user,
    maker: user,
    taker: user,
    user,
    vault: d.vault,
    market: d.market,
    question: questionKey,
    wager: wagerKey,
    escrow,
    token_mint: d.mint,
    maker_token: tokenAccount,
    taker_token: tokenAccount,
    user_token: tokenAccount,
    token_program: TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
  };
  const abi = idl.instructions.find(
    (ix) => ix.name === instructionName[action],
  )!;
  tx.add(
    new TransactionInstruction({
      programId: d.program,
      data: Buffer.concat([Buffer.from(abi.discriminator), payload]),
      keys: abi.accounts.map((a) => {
        const pubkey = accounts[a.name];
        if (!pubkey) throw Error(`Missing account ${a.name}`);
        return {
          pubkey,
          isSigner: "signer" in a && a.signer === true,
          isWritable: "writable" in a && a.writable === true,
        };
      }),
    }),
  );
  const lifetime = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = user;
  tx.recentBlockhash = lifetime.blockhash;
  const simulation = await connection.simulateTransaction(
    new VersionedTransaction(tx.compileMessage()),
    { commitment: "confirmed", sigVerify: false },
  );
  if (simulation.value.err)
    throw Error(
      `Simulation failed: ${JSON.stringify(simulation.value.err)}. ${simulation.value.logs?.filter((x) => x.includes("Error Message")).join(" ") ?? "The deployed program may need upgrading."}`,
    );
  const fee = (
    await connection.getFeeForMessage(tx.compileMessage(), "confirmed")
  ).value;
  if (fee === null) throw Error("Fee estimate unavailable");
  const rent = (
    await Promise.all(
      rentBytes.map((n) => connection.getMinimumBalanceForRentExemption(n)),
    )
  ).reduce((a, b) => a + b, 0);
  return {
    transaction: tx,
    lifetime,
    feeLamports: fee,
    rentLamports: rent,
    stake: stake.toString(),
    payout: payout.toString(),
    action,
    question: q,
    wager: w,
    questionAddress: questionKey?.toBase58(),
    wagerAddress: wagerKey?.toBase58(),
    escrowAddress: escrow?.toBase58(),
  };
}
