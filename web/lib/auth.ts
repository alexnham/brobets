import { cookies } from "next/headers";
import { db } from "./db";
import { hashToken } from "./auth-core";
export async function session() {
  const token = (await cookies()).get("brobets-session")?.value;
  if (!token) return null;
  const row = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  return row && row.expiresAt > new Date() ? row : null;
}
export function sameOrigin(request: Request) {
  return (
    request.headers.get("origin") ===
    (process.env.APP_ORIGIN ?? "http://localhost:3000")
  );
}
export const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
};
