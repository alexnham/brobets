import "server-only";
import { Connection } from "@solana/web3.js";
export function matchingConnection() {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw Error("Helius configuration is required");
  return new Connection(
    `https://devnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`,
    "confirmed",
  );
}
