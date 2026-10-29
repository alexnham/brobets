import { NextResponse } from "next/server";
import bs58 from "bs58";
import { db } from "@/lib/db";
import { challengeMessage, randomToken } from "@/lib/auth-core";
import { sameOrigin, cookieOptions } from "@/lib/auth";
export async function POST(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  try {
    const { wallet } = await request.json();
    if (typeof wallet !== "string" || bs58.decode(wallet).length !== 32)
      throw Error();
    const id = randomToken(),
      expiresAt = new Date(Date.now() + 300_000);
    const message = challengeMessage(
      wallet,
      id,
      process.env.APP_ORIGIN ?? "http://localhost:3000",
      expiresAt,
    );
    await db.challenge.create({ data: { id, wallet, message, expiresAt } });
    const response = NextResponse.json({ message });
    response.cookies.set("brobets-challenge", id, {
      ...cookieOptions,
      maxAge: 300,
    });
    return response;
  } catch {
    return NextResponse.json(
      {
        error:
          "Unable to issue challenge. Check wallet and database configuration.",
      },
      { status: 400 },
    );
  }
}
