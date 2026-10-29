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
