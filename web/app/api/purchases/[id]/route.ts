import { NextResponse } from "next/server";
import { session } from "@/lib/auth";
import { db } from "@/lib/db";
import { draftHeaders, serializeDraft } from "@/lib/purchase-drafts";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const options = { headers: draftHeaders };
  try {
    const user = await session();
    if (!user)
      return NextResponse.json({ error: "Sign in required" }, { ...options, status: 401 });
    const { id } = await context.params;
    const row = id.length <= 100
      ? await db.purchaseDraft.findFirst({ where: { id, wallet: user.wallet } })
      : null;
    if (!row)
      return NextResponse.json({ error: "Draft not found" }, { ...options, status: 404 });
    return NextResponse.json(serializeDraft(row), options);
  } catch {
    return NextResponse.json({ error: "Purchase drafts unavailable" }, { ...options, status: 503 });
  }
}
