import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  hashToken,
  randomToken,
  verifySignature,
  isAdmin,
} from "@/lib/auth-core";
import { sameOrigin, cookieOptions } from "@/lib/auth";
export async function POST(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  try {
    const { signature } = await request.json();
    const id = (await cookies()).get("brobets-challenge")?.value;
    if (!id || typeof signature !== "string") throw Error();
    // DELETE ... RETURNING atomically consumes the challenge, including failed attempts.
    const challenge = await db.challenge.delete({ where: { id } });
    if (
      challenge.expiresAt <= new Date() ||
      !verifySignature(challenge.message, signature, challenge.wallet)
    )
      throw Error();
    const token = randomToken();
    await db.session.create({
      data: {
        tokenHash: hashToken(token),
        wallet: challenge.wallet,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const response = NextResponse.json({
      wallet: challenge.wallet,
      admin: isAdmin(challenge.wallet),
    });
    response.cookies.set("brobets-session", token, {
      ...cookieOptions,
      maxAge: 86400,
    });
    response.cookies.delete("brobets-challenge");
    return response;
  } catch {
    return NextResponse.json(
      { error: "Challenge expired, already used, or signature invalid." },
      { status: 401 },
    );
  }
}
