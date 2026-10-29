import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { session, sameOrigin } from "@/lib/auth";
import { isAdmin } from "@/lib/auth-core";
const schema = z.object({
  title: z.string().trim().min(10).max(200),
  sideA: z.string().trim().min(1).max(80),
  sideB: z.string().trim().min(1).max(80),
  closesAt: z.iso.datetime(),
  resolveBy: z.iso.datetime(),
});
export async function GET() {
  try {
    return NextResponse.json(
      await db.question.findMany({ orderBy: { createdAt: "desc" } }),
    );
  } catch {
    return NextResponse.json(
      { error: "Database unavailable" },
      { status: 503 },
    );
  }
}
export async function POST(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  try {
    const user = await session();
    if (!user || !isAdmin(user.wallet))
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 },
      );
    const data = schema.parse(await request.json());
    if (
      Date.parse(data.closesAt) <= Date.now() ||
      Date.parse(data.resolveBy) <= Date.parse(data.closesAt) ||
      data.sideA === data.sideB
    )
      throw Error("Invalid outcomes or deadlines");
    // Persist draft content only. Publishing requires the matching escrow transaction.
    return NextResponse.json(
      await db.question.create({ data: { ...data, adminWallet: user.wallet } }),
      { status: 201 },
    );
  } catch {
    return NextResponse.json(
      { error: "Could not save draft. Check fields and database." },
      { status: 400 },
    );
  }
}
