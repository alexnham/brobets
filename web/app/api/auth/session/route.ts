import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { session, sameOrigin, cookieOptions } from "@/lib/auth";
import { isAdmin, hashToken } from "@/lib/auth-core";
import { db } from "@/lib/db";
export async function GET() {
  try {
    const user = await session();
    return NextResponse.json({
      wallet: user?.wallet ?? null,
      admin: !!user && isAdmin(user.wallet),
    });
  } catch {
    return NextResponse.json({ wallet: null, admin: false });
  }
}
export async function DELETE(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const token = (await cookies()).get("brobets-session")?.value;
  if (token)
    await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  const response = NextResponse.json({ ok: true });
  response.cookies.set("brobets-session", "", { ...cookieOptions, maxAge: 0 });
  return response;
}
