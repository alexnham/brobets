import { NextResponse } from "next/server";
export async function POST() {
  return NextResponse.json(
    {
      error:
        "Matching escrow IDL and deployment are not connected. Funding is disabled.",
    },
    { status: 503 },
  );
}
