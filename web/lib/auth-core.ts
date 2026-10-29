import { createHash, randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const randomToken = () => randomBytes(32).toString("hex");
export function challengeMessage(
  wallet: string,
  nonce: string,
  origin: string,
  expires: Date,
) {
  return `Sign in to Brobets\nOrigin: ${origin}\nWallet: ${wallet}\nNonce: ${nonce}\nExpires: ${expires.toISOString()}\nThis signature does not authorize a transaction.`;
}
export function verifySignature(
  message: string,
  signature: string,
  wallet: string,
): boolean {
  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      /^[0-9a-f]{128}$/i.test(signature)
        ? Buffer.from(signature, "hex")
        : bs58.decode(signature),
      bs58.decode(wallet),
    );
  } catch {
    return false;
  }
}
export function isAdmin(
  wallet: string,
  configured = process.env.ADMIN_WALLET_ADDRESS,
) {
  return !!configured && wallet === configured;
}
