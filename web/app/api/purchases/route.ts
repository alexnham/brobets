import { NextResponse } from "next/server";
import { z } from "zod";
import { session, sameOrigin } from "@/lib/auth";
import { db } from "@/lib/db";
import { parseAmount } from "@/lib/money";
import { createDraft, draftHeaders, serializeDraft } from "@/lib/purchase-drafts";

const input = z.object({
  quantity: z.string().max(32),
  requestId: z.uuid(),
}).strict();
const options = { headers: draftHeaders };

export async function POST(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "Invalid origin" }, { ...options, status: 403 });
  try {
    const user = await session();
    if (!user)
      return NextResponse.json({ error: "Sign in required" }, { ...options, status: 401 });
    let body: z.infer<typeof input>;
    let quantity: bigint;
    try {
      body = input.parse(await request.json());
      quantity = parseAmount(body.quantity);
    } catch {
      return NextResponse.json({ error: "Invalid quantity or requestId" }, { ...options, status: 400 });
    }
    const result = await createDraft(user.wallet, body.requestId, quantity);
    if (result.conflict)
      return NextResponse.json({ error: "requestId already used for another quantity" }, { ...options, status: 409 });
    return NextResponse.json(serializeDraft(result.row), { ...options, status: result.created ? 201 : 200 });
  } catch {
    return NextResponse.json({ error: "Purchase drafts unavailable" }, { ...options, status: 503 });
  }
}

export async function GET(request: Request) {
  try {
    const user = await session();
    if (!user)
      return NextResponse.json({ error: "Sign in required" }, { ...options, status: 401 });
    const cursor = new URL(request.url).searchParams.get("cursor");
    if (cursor && (cursor.length > 100 || !(await db.purchaseDraft.findFirst({ where: { id: cursor, wallet: user.wallet } }))))
      return NextResponse.json({ error: "Draft not found" }, { ...options, status: 404 });
    const rows = await db.purchaseDraft.findMany({
      where: { wallet: user.wallet },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, 50).map(serializeDraft);
    return NextResponse.json({ items, nextCursor: rows.length > 50 ? items.at(-1)!.id : null }, options);
  } catch {
    return NextResponse.json({ error: "Purchase drafts unavailable" }, { ...options, status: 503 });
  }
}
