import type { Metadata } from "next";
import "helius-wallet-kit/ui/styles.css";
import "./globals.css";
export const metadata: Metadata = {
  title: "Brobets — Put your game on it",
  description:
    "Basketball takes. Equal stakes. Head-to-head wagers with embedded Solana wallets.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
