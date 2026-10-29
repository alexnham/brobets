import { Brobets } from "@/components/brobets";
export const dynamic = "force-dynamic";
export default function Page() {
  return <Brobets walletEnabled={!!process.env.HELIUS_API_KEY} />;
}
