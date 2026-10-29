import { NextResponse } from "next/server";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { sameOrigin, session } from "@/lib/auth";
import { db } from "@/lib/db";
import { matchingConnection } from "@/lib/matching-server";
import { deployment, decodeQuestion, readMatching } from "@/lib/matching";
import idl from "@/lib/matching-idl.json";
const schema = z.object({
  signature: z.string().min(64).max(88),
  action: z.enum([
    "create",
    "propose",
    "match",
    "cancel",
    "claim",
    "resolve",
    "expire",
  ]),
  questionId: z.string().min(32).max(44),
});
const names = {
  create: "create_question",
  propose: "propose_wager",
  match: "match_wager",
  cancel: "cancel_wager",
  claim: "claim_wager",
  resolve: "resolve_question",
  expire: "expire_question",
};
// This endpoint records verified effects. It never signs, prepares arbitrary transactions,
// or treats a browser-supplied signature as funding proof.
export async function POST(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  try {
    const actor = await session();
    if (!actor)
      return NextResponse.json(
        { error: "Verify wallet session first" },
        { status: 401 },
      );
    const input = schema.parse(await request.json()),
      connection = matchingConnection();
    const snapshot = await readMatching(connection);
    if (!snapshot.ready)
      return NextResponse.json(
        { error: "Matching deployment is not initialized" },
        { status: 503 },
      );
    const result = await connection.getTransaction(input.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!result || !result.meta || result.meta.err)
      throw Error("Transaction is not confirmed successfully");
    const message = result.transaction.message;
    const keys = message.getAccountKeys({
      accountKeysFromLookups: result.meta.loadedAddresses,
    });
    if (keys.get(0)?.toBase58() !== actor.wallet)
      throw Error("Transaction fee payer does not match session");
    const abi = idl.instructions.find((i) => i.name === names[input.action])!;
    const questionIndex = abi.accounts.findIndex((a) => a.name === "question");
    const instruction = message.compiledInstructions.find(
      (i) =>
        keys.get(i.programIdIndex)?.equals(deployment().program) &&
        Buffer.from(i.data)
          .subarray(0, 8)
          .equals(Buffer.from(abi.discriminator)) &&
        keys.get(i.accountKeyIndexes[questionIndex])?.toBase58() ===
          input.questionId,
    );
    if (!instruction)
      throw Error("Expected canonical matching instruction missing");
    const key = new PublicKey(input.questionId),
      info = await connection.getAccountInfo(key, "confirmed");
    const q = decodeQuestion(key, info!);
    const row = await db.question.upsert({
      where: { chainAddress: q.id },
      create: {
        title: q.title,
        sideA: q.sideA,
        sideB: q.sideB,
        closesAt: q.closesAt,
        resolveBy: q.resolveBy,
        adminWallet: snapshot.admin,
        chainAddress: q.id,
      },
      update: {},
    });
    await db.transactionReference.upsert({
      where: { signature: input.signature },
      create: {
        signature: input.signature,
        questionId: row.id,
        action: input.action,
        wallet: actor.wallet,
      },
      update: {},
    });
    return NextResponse.json({ ok: true, question: q });
  } catch {
    return NextResponse.json(
      {
        error:
          "Unable to verify or record the transaction. Confirmed chain accounts remain authoritative.",
      },
      { status: 400 },
    );
  }
}
