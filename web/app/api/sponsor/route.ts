import { NextResponse } from "next/server";
import { z } from "zod";
import bs58 from "bs58";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { sameOrigin, session } from "@/lib/auth";
import { matchingConnection } from "@/lib/matching-server";
import { sponsorSign } from "@/lib/sponsor";
export const dynamic = "force-dynamic";
const schema = z.object({ transaction: z.string().min(1).max(2000) });
function sponsor() {
  const raw = process.env.SPONSOR_SECRET_KEY;
  if (!raw) return null;
  // Accepts a solana-keygen JSON byte array or a wallet-exported base58 secret key.
  return Keypair.fromSecretKey(
    raw.trim().startsWith("[")
      ? Uint8Array.from(JSON.parse(raw))
      : bs58.decode(raw.trim()),
  );
}
// Without a configured sponsor the address is null and players pay their own fees.
export async function GET() {
  return NextResponse.json(
    { address: sponsor()?.publicKey.toBase58() ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
// Signs as fee and rent payer only. It never broadcasts and never signs for the player.
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
    const key = sponsor();
    if (!key)
      return NextResponse.json(
        { error: "Sponsorship is not configured" },
        { status: 503 },
      );
    const input = schema.parse(await request.json());
    const signed = sponsorSign(
      Buffer.from(input.transaction, "base64"),
      key,
      new PublicKey(actor.wallet),
    );
    // Release the signature only for a transaction that verifies and succeeds on the
    // configured devnet RPC: this rejects other clusters, stale blockhashes and wagers
    // that would fail after the sponsor has paid the fee.
    const simulation = await matchingConnection().simulateTransaction(
      VersionedTransaction.deserialize(signed),
      { sigVerify: true, commitment: "confirmed" },
    );
    if (simulation.value.err) throw Error("Simulation failed");
    return NextResponse.json({ transaction: signed.toString("base64") });
  } catch {
    return NextResponse.json(
      { error: "Brobets cannot sponsor this transaction." },
      { status: 400 },
    );
  }
}
