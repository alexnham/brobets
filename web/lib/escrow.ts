export type Side = "a" | "b";
export type Wager = {
  id: string;
  questionId: string;
  maker: string;
  taker?: string;
  side: Side;
  units: string;
  state: "open" | "matched" | "cancelled" | "claimed";
  claimedBy?: string[];
};
export type Question = {
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
export type EscrowAction =
  | "createQuestion"
  | "propose"
  | "match"
  | "cancel"
  | "resolve"
  | "void"
  | "refundExpired"
  | "claim";
// Matching IDL is not available. Never reinterpret the existing pooled escrow as matched wagers.
export const MATCHING_ESCROW_CONNECTED = false;
export interface MatchingEscrow {
  readQuestion(address: string): Promise<Question>;
  readWager(address: string): Promise<Wager>;
  prepare(
    action: EscrowAction,
    input: Record<string, string>,
  ): Promise<{ transaction: Uint8Array; feeLamports: string }>;
  verifyConfirmed(
    signature: string,
    action: EscrowAction,
    wallet: string,
  ): Promise<Wager | Question>;
}
