export type Side = "a" | "b";
export type Wager = {
  id: string;
  questionId: string;
  proposalId?: string;
  maker: string;
  taker?: string;
  side: Side;
  units: string;
  state: "open" | "matched" | "cancelled" | "claimed";
  claimedBy?: string[];
};
export type Question = {
  chainId?: string;
  id: string;
  title: string;
  sideA: string;
  sideB: string;
  closesAt: string;
  resolveBy: string;
  matchup: string;
  category: string;
  result?: Side | "void";
};

export function wagerResult(q: Question, w: Wager, user: string | null) {
  // A cancelled or never-matched proposal cannot win, even if its side wins later.
  if (!user || !w.taker || w.state === "cancelled" ||
      ![w.maker, w.taker].includes(user) || !q.result || q.result === "void")
    return undefined;
  const winner = q.result === w.side ? w.maker : w.taker;
  return winner === user ? "won" : "lost";
}
