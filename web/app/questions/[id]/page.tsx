import { Brobets } from "@/components/brobets";
export const dynamic = "force-dynamic";
export default async function QuestionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Brobets
      walletEnabled={!!process.env.HELIUS_API_KEY}
      initialQuestionId={id}
    />
  );
}
