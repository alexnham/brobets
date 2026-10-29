import { NextResponse } from "next/server";
import { matchingConnection } from "@/lib/matching-server";
import { readMatching } from "@/lib/matching";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return NextResponse.json(await readMatching(matchingConnection()), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      {
        error:
          "Unable to read the matching market from Helius devnet. Check RPC and deployment configuration.",
      },
      { status: 503 },
    );
  }
}
