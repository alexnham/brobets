import { parseAmount } from "./money";
import type { Question, Wager, Side } from "./escrow";
export const DEMO_USER = "demo-you";
export function fixtures(): { questions: Question[]; wagers: Wager[] } {
  const deadline = (hours: number) =>
    new Date(Date.now() + hours * 3600_000).toISOString();
  return {
    questions: [
      {
        id: "lakers-warriors",
        title: "Who takes the win in the Bay?",
        matchup: "Los Angeles / Golden State",
        sideA: "Lakers",
        sideB: "Warriors",
        category: "Game winner",
        closesAt: deadline(6),
        resolveBy: deadline(30),
      },
      {
        id: "celtics-knicks",
        title: "Can New York defend the Garden?",
        matchup: "Boston / New York",
        sideA: "Celtics",
        sideB: "Knicks",
        category: "Game winner",
        closesAt: deadline(9),
        resolveBy: deadline(33),
      },
      {
        id: "raptors-heat",
        title: "Toronto or Miami. Pick your side.",
        matchup: "Toronto / Miami",
        sideA: "Raptors",
        sideB: "Heat",
        category: "Game winner",
        closesAt: deadline(12),
        resolveBy: deadline(36),
      },
      {
        id: "nuggets-suns",
        title: "Denver gets it done on the road?",
        matchup: "Denver / Phoenix",
        sideA: "Nuggets",
        sideB: "Suns",
        category: "Game winner",
        closesAt: deadline(-4),
        resolveBy: deadline(20),
        result: "a",
      },
    ],
    wagers: [
      {
        id: "w1",
        questionId: "lakers-warriors",
        maker: "demo-jordan",
        side: "a",
        units: "5000000",
        state: "open",
      },
      {
        id: "w2",
        questionId: "lakers-warriors",
        maker: "demo-steph",
        side: "b",
        units: "10000000",
        state: "open",
      },
      {
        id: "w3",
        questionId: "celtics-knicks",
        maker: "demo-jay",
        side: "a",
        units: "25000000",
        state: "open",
      },
      {
        id: "w4",
        questionId: "raptors-heat",
        maker: DEMO_USER,
        side: "a",
        units: "5000000",
        state: "open",
      },
      {
        id: "w5",
        questionId: "nuggets-suns",
        maker: DEMO_USER,
        taker: "demo-book",
        side: "a",
        units: "10000000",
        state: "matched",
      },
    ],
  };
}
export function transition(
  wagers: Wager[],
  questions: Question[],
  action: "propose" | "match" | "cancel" | "claim",
  input: {
    questionId?: string;
    wagerId?: string;
    side?: Side;
    amount?: string;
  },
  wallet: string,
  now = Date.now(),
): Wager[] {
  if (action === "propose") {
    const q = questions.find((q) => q.id === input.questionId);
    if (!q || q.result || Date.parse(q.closesAt) <= now || !input.side)
      throw Error("This question is closed.");
    return [
      ...wagers,
      {
        id: crypto.randomUUID(),
        questionId: q.id,
        maker: wallet,
        side: input.side,
        units: parseAmount(input.amount ?? "").toString(),
        state: "open",
      },
    ];
  }
  const w = wagers.find((w) => w.id === input.wagerId),
    q = questions.find((q) => q.id === w?.questionId);
  if (!w || !q) throw Error("Wager unavailable.");
  const closed = Date.parse(q.closesAt) <= now || !!q.result;
  if (
    action === "match" &&
    (w.state !== "open" || w.maker === wallet || closed)
  )
    throw Error("This wager cannot be matched.");
  if (action === "cancel" && (w.state !== "open" || w.maker !== wallet))
    throw Error("Only the proposer can cancel an unmatched wager.");
  if (action === "claim") {
    const expired = Date.parse(q.resolveBy) <= now && !q.result;
    const refund =
      q.result === "void" || expired || (w.state === "open" && closed);
    const winner = q.result === w.side ? w.maker : w.taker;
    if (
      ![w.maker, w.taker].includes(wallet) ||
      w.claimedBy?.includes(wallet) ||
      w.state === "cancelled" ||
      w.state === "claimed" ||
      (!refund && (!q.result || winner !== wallet))
    )
      throw Error("No payout is available.");
    return wagers.map((item) =>
      item.id === w.id
        ? {
            ...item,
            claimedBy: [...(item.claimedBy ?? []), wallet],
            state:
              refund && w.taker && !item.claimedBy?.length
                ? item.state
                : "claimed",
          }
        : item,
    );
  }
  return wagers.map((item) =>
    item.id !== w.id
      ? item
      : action === "match"
        ? { ...item, taker: wallet, state: "matched" }
        : { ...item, state: "cancelled" },
  );
}
