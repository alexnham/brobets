import { Prisma, type PurchaseDraft } from "@prisma/client";
import { PublicKey } from "@solana/web3.js";
import { db } from "./db";
import { quoteBuy } from "./money";

export const draftHeaders = { "Cache-Control": "private, no-store" };

export function serializeDraft(row: PurchaseDraft) {
  return {
    id: row.id,
    status: row.status,
    paymentEnabled: false,
    cluster: row.cluster,
    mint: row.mint,
    decimals: 6,
    quote: {
      bbUnits: row.quantity.toFixed(0),
      backingUnits: row.backing.toFixed(0),
      premiumUnits: row.premium.toFixed(0),
      totalUnits: row.total.toFixed(0),
    },
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createDraft(wallet: string, requestId: string, quantity: bigint) {
  const where = { wallet_requestId: { wallet, requestId } };
  let row = await db.purchaseDraft.findUnique({ where });
  let created = false;
  if (!row) {
    const configuredMint = process.env.NEXT_PUBLIC_USDC_MINT;
    if (!configuredMint) throw Error("Quote mint is not configured");
    const mint = new PublicKey(configuredMint).toBase58();
    const quote = quoteBuy(quantity);
    try {
      row = await db.purchaseDraft.create({
        data: {
          wallet,
          requestId,
          mint,
          quantity: quote.quantity.toString(),
          backing: quote.backing.toString(),
          premium: quote.premium.toString(),
          total: quote.total.toString(),
        },
      });
      created = true;
    } catch (error) {
      // Another worker may have created the same wallet/request pair.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002")
        throw error;
      row = await db.purchaseDraft.findUnique({ where });
      if (!row) throw error;
    }
  }
  return { row, created, conflict: row.quantity.toFixed(0) !== quantity.toString() };
}
