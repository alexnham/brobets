"use client";
import { useEffect, useState, useRef, type ReactNode } from "react";
import { HeliusWalletProvider, useHeliusWallet } from "helius-wallet-kit";
import {
  ArrowUpRight,
  ArrowRight,
  Wallet,
  X,
  Check,
  ShieldCheck,
  Trophy,
  ChevronRight,
  Plus,
  CircleDot,
} from "lucide-react";
import { VaultExchange } from "./vault-exchange";
import { formatAmount, parseAmount } from "@/lib/money";
import {
  claimAmount,
  MATCH_ADMIN,
  type MatchAction,
  type MatchInput,
  type PreparedMatch,
  type MarketSnapshot,
} from "@/lib/matching";
import type { Question, Wager, Side } from "@/lib/escrow";
type WalletState = {
  address: string | null;
  admin: boolean;
  enabled: boolean;
  signIn: () => Promise<void>;
  authenticate: () => Promise<void>;
  logout: () => Promise<void>;
  balances: {
    sol: string;
    usdc: string;
    tokens: string;
  };
  error: string;
  refresh?: () => Promise<void>;
  exchange?: ReactNode;
  prepareMatching?: (
    action: MatchAction,
    input: MatchInput,
  ) => Promise<PreparedMatch>;
  sendMatching?: (prepared: PreparedMatch) => Promise<string>;
  recoverMatching?: () => Promise<string>;
};
const emptyWallet: WalletState = {
  address: null,
  admin: false,
  enabled: false,
  signIn: async () => {},
  authenticate: async () => {},
  logout: async () => {},
  balances: { sol: "—", usdc: "—", tokens: "—" },
  error: "",
};
export function Brobets({
  walletEnabled,
  initialQuestionId,
}: {
  walletEnabled: boolean;
  initialQuestionId?: string;
}) {
  return walletEnabled ? (
    <HeliusWalletProvider
      config={{
        cluster: "devnet",
        authMethods: {
          email: true,
          passkey: false,
          wallet: false,
          sms: false,
          google: false,
          apple: false,
          discord: false,
          x: false,
        },
        theme: { darkMode: true, primaryColor: "#ff7545" },
      }}
    >
      <Connected initialQuestionId={initialQuestionId} />
    </HeliusWalletProvider>
  ) : (
    <Board wallet={emptyWallet} initialQuestionId={initialQuestionId} />
  );
}
async function api(path: string, body?: object) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Error(data.error ?? "Request failed");
  return data;
}
function Connected({ initialQuestionId }: { initialQuestionId?: string }) {
  const w = useHeliusWallet();
  const [admin, setAdmin] = useState(false),
    [error, setError] = useState("");
  const [balances, setBalances] = useState(emptyWallet.balances);
  useEffect(() => {
    setAdmin(false);
    setBalances(emptyWallet.balances);
    if (!w.address) return;
    let cancelled = false;
    api("/api/auth/session")
      .then((s) => {
        if (!cancelled) setAdmin(s.wallet === w.address && s.admin);
      })
      .catch(() => {});
    import("@/lib/wallet")
      .then((m) => m.readBalances(w.connection, w.address!))
      .then((next) => {
        if (!cancelled) setBalances(next);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [w.address, w.connection]);
  const refresh = async () => {
    if (!w.address) return;
    try {
      const { readBalances } = await import("@/lib/wallet");
      setBalances(await readBalances(w.connection, w.address));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const authenticate = async () => {
    try {
      const { message } = await api("/api/auth/challenge", {
        wallet: w.address,
      });
      const signature = await w.signMessage(message);
      const s = await api("/api/auth/verify", { signature });
      setAdmin(s.admin);
      setError("");
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  };
  return (
    <Board
      initialQuestionId={initialQuestionId}
      wallet={{
        address: w.address,
        admin: admin || w.address === MATCH_ADMIN,
        enabled: true,
        balances,
        error,
        exchange: <VaultExchange onConfirmed={refresh} />,
        refresh,
        signIn: async () => {
          try {
            await w.login();
          } catch (e) {
            setError((e as Error).message);
          }
        },
        authenticate,
        prepareMatching: async (action, input) => {
          if (!w.address || w.cluster !== "devnet")
            throw Error("Sign in on devnet first.");
          let current = await api("/api/auth/session");
          if (current.wallet !== w.address) {
            await authenticate();
            current = await api("/api/auth/session");
          }
          if (
            ["initialize", "create", "resolve"].includes(action) &&
            !current.admin
          )
            throw Error(
              "Server admin wallet configuration does not match this account.",
            );
          const { prepareMatching } = await import("@/lib/matching");
          return prepareMatching(w.connection, w.address, action, input);
        },
        sendMatching: async (prepared) => {
          if (
            !w.address ||
            w.cluster !== "devnet" ||
            prepared.transaction.feePayer?.toBase58() !== w.address
          )
            throw Error("Wallet or network changed. Review again.");
          if (
            (await w.connection.getBlockHeight("confirmed")) >
            prepared.lifetime.lastValidBlockHeight
          )
            throw Error("Review expired. Simulate again.");
          const key = `brobets-matching-pending:${w.address}`;
          const pending = localStorage.getItem(key);
          if (pending)
            throw Error(
              `A previous transaction needs confirmation: ${pending}. Check its status before retrying.`,
            );
          // Persist the deterministic transaction signature before broadcast, so even
          // a send timeout can be reconciled without risking a repeated deposit.
          const signed = await w.signTransaction(
            prepared.transaction.serialize({
              requireAllSignatures: false,
              verifySignatures: false,
            }),
          );
          const { Transaction } = await import("@solana/web3.js");
          const { default: bs58 } = await import("bs58");
          const signedTransaction = Transaction.from(signed);
          if (
            !signedTransaction
              .serializeMessage()
              .equals(prepared.transaction.serializeMessage()) ||
            !signedTransaction.verifySignatures()
          )
            throw Error("Wallet returned a modified or invalid transaction.");
          const signatureBytes = signedTransaction.signature;
          if (!signatureBytes)
            throw Error("Wallet returned an unsigned transaction.");
          const signature = bs58.encode(signatureBytes);
          localStorage.setItem(
            key,
            JSON.stringify({
              signature,
              questionId: prepared.questionAddress,
              action: prepared.action,
              lastValidBlockHeight: prepared.lifetime.lastValidBlockHeight,
            }),
          );
          await w.connection.sendRawTransaction(signed, {
            skipPreflight: false,
            maxRetries: 3,
          });
          const result = await w.connection.confirmTransaction(
            { ...prepared.lifetime, signature },
            "confirmed",
          );
          if (result.value.err) {
            localStorage.removeItem(key);
            throw Error(
              `Transaction failed: ${JSON.stringify(result.value.err)}`,
            );
          }
          localStorage.removeItem(key);
          if (prepared.questionAddress) {
            await api("/api/escrow", {
              signature,
              action: prepared.action,
              questionId: prepared.questionAddress,
            }).catch(() => {});
          }
          await refresh();
          return signature;
        },
        recoverMatching: async () => {
          if (!w.address) return "";
          const key = `brobets-matching-pending:${w.address}`;
          const raw = localStorage.getItem(key);
          if (!raw) return "";
          const pending = JSON.parse(raw);
          const result = (
            await w.connection.getSignatureStatuses([pending.signature], {
              searchTransactionHistory: true,
            })
          ).value[0];
          if (result?.err) {
            localStorage.removeItem(key);
            return `Failed transaction: ${pending.signature}. It is safe to prepare again.`;
          }
          if (
            result?.confirmationStatus === "confirmed" ||
            result?.confirmationStatus === "finalized"
          ) {
            localStorage.removeItem(key);
            if (pending.questionId)
              await api("/api/escrow", pending).catch(() => {});
            await refresh();
            return `Confirmed · ${pending.signature}`;
          }
          if (
            !result &&
            (await w.connection.getBlockHeight("finalized")) >
              pending.lastValidBlockHeight
          ) {
            localStorage.removeItem(key);
            return `Expired without confirmation: ${pending.signature}. You can prepare again.`;
          }
          return `Still pending: ${pending.signature}. Do not submit the wager again.`;
        },
        logout: async () => {
          await fetch("/api/auth/session", { method: "DELETE" });
          await w.logout();
          setAdmin(false);
        },
      }}
    />
  );
}
const dollars = (units: string | bigint) => "$" + formatAmount(BigInt(units));
function closes(q: Question) {
  const hours = Math.ceil((Date.parse(q.closesAt) - Date.now()) / 3600000);
  return hours > 0 ? `Closes in ${hours}h` : "Betting closed";
}
function Board({
  wallet,
  initialQuestionId,
}: {
  wallet: WalletState;
  initialQuestionId?: string;
}) {
  const [questions, setQuestions] = useState<Question[]>([]),
    [wagers, setWagers] = useState<Wager[]>([]),
    [ready, setReady] = useState(false);
  const [tab, setTab] = useState("board"),
    [filter, setFilter] = useState("All games"),
    [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Question | null>(null),
    [modal, setModal] = useState<"wallet" | "admin" | null>(null),
    [side, setSide] = useState<Side>("a"),
    [amount, setAmount] = useState("5");
  const [review, setReview] = useState<{
      action: MatchAction;
      question: Question;
      wager?: Wager;
    } | null>(null),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  const actor = wallet.address;
  const [marketReady, setMarketReady] = useState(false);
  const [prepared, setPrepared] = useState<PreparedMatch | null>(null);
  const loadMarket = async () => {
    const data: MarketSnapshot = await api("/api/market");
    setQuestions(data.questions);
    setWagers(data.wagers);
    setMarketReady(data.ready);
    setReady(true);
    setSelected((current) =>
      current
        ? (data.questions.find((q) => q.id === current.id) ?? null)
        : null,
    );
  };
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const load = () => {
      void loadMarket().catch((e) => {
        setNotice(e.message);
        setReady(true);
      });
    };
    load();
    const timer = setInterval(load, 15000);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, []);
  useEffect(() => {
    if (ready && initialQuestionId) {
      const question = questions.find((q) => q.id === initialQuestionId);
      if (question) setSelected(question);
      else
        setNotice(
          "This question is unavailable. Refresh the board and try again.",
        );
    }
  }, [ready, initialQuestionId]);
  useEffect(() => {
    if (wallet.address && wallet.recoverMatching) {
      void wallet
        .recoverMatching()
        .then((message) => {
          if (message) {
            setNotice(message);
            void loadMarket().catch(() => {});
          }
        })
        .catch((e) =>
          setNotice(`Pending transaction recovery failed: ${e.message}`),
        );
    }
  }, [wallet.address]);
  const closeQuestion = () => {
    setSelected(null);
    window.history.replaceState(null, "", "/");
  };
  const open = wagers.filter(
    (w) =>
      w.state === "open" &&
      !questions.find((q) => q.id === w.questionId)?.result,
  );
  const mine = wagers.filter((w) => w.maker === actor || w.taker === actor);
  const visible = questions.filter(
    (q) =>
      (filter !== "Open for bets" || Date.parse(q.closesAt) > Date.now()) &&
      (filter !== "Settled" || !!q.result) &&
      `${q.title} ${q.matchup} ${q.sideA} ${q.sideB}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const run = async () => {
    if (!review) return;
    setBusy(true);
    setStatus("Waiting for wallet approval and on-chain confirmation…");
    try {
      if (!prepared || !wallet.sendMatching)
        throw Error("Simulate this action before signing.");
      const signature = await wallet.sendMatching(prepared);
      setStatus(`Confirmed · ${signature}`);
      await loadMarket();
      return;
    } catch (e) {
      setStatus(`Failed · ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const start = async (
    action: MatchAction,
    question: Question,
    wager?: Wager,
    outcome?: Side | "void",
  ) => {
    setPrepared(null);
    setStatus("");
    try {
      if (action === "propose") parseAmount(amount);
      if (!wallet.address || !wallet.prepareMatching) {
        setModal("wallet");
        return;
      }
      setBusy(true);
      setNotice(
        "Checking wallet session and simulating the devnet transaction…",
      );
      const next = await wallet.prepareMatching(action, {
        question,
        wager,
        side,
        amount,
        outcome,
      });
      setPrepared(next);
      setNotice("");
      setReview({ action, question, wager });
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <a href="/" className="brand">
          <span className="brand-ball">◉</span> brobets
          <span className="brand-dot">.</span>
        </a>
        <div className="nav-label">Your home court</div>
        <nav aria-label="Main navigation">
          {[
            ["board", "Bet board", <CircleDot key="b" size={19} />],
            ["mine", "My bets", <Trophy key="m" size={19} />],
          ].map(([id, label, icon]) => (
            <button
              key={id as string}
              className={tab === id ? "nav-item active" : "nav-item"}
              onClick={() => setTab(id as string)}
            >
              {icon}
              {label}
              <ChevronRight size={15} />
            </button>
          ))}
          <button className="nav-item" onClick={() => setModal("wallet")}>
            <Wallet size={19} />
            My wallet
            <ChevronRight size={15} />
          </button>
        </nav>
        <div className="sidebar-card">
          <div className="small-court">
            <span>+</span>
            <i />
          </div>
          <h3>
            Your take.
            <br />
            Your stake.
          </h3>
          <p>
            Find your matchup.
            <br />
            Let the game do the talking.
          </p>
        </div>
        <div className="sidebar-bottom">
          <ShieldCheck size={16} />
          <span>Equal stakes. On-chain escrow.</span>
        </div>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <span className="breadcrumb">
            The court <span>/</span> {tab === "board" ? "Bet board" : "My bets"}
          </span>
          <div className="top-actions">
            <button
              className="header-balance"
              onClick={() => setModal("wallet")}
              aria-label={`Brobets balance: ${wallet.address ? wallet.balances.tokens : "Sign in to view"}. Open wallet`}
            >
              <span>Brobets</span>
              <strong>{wallet.address ? wallet.balances.tokens : "—"}</strong>
            </button>
            <span className="network">
              <i /> Devnet
            </span>
            <button
              className="wallet-button"
              onClick={() =>
                wallet.address || !wallet.enabled
                  ? setModal("wallet")
                  : void wallet.signIn()
              }
            >
              <Wallet size={16} />
              {wallet.address
                ? wallet.address.slice(0, 4) + "…" + wallet.address.slice(-4)
                : "Sign in with email"}
            </button>
          </div>
        </header>
        <main>
          <div className="market-banner">
            <span>
              {
                <>
                  <b>Devnet court</b> ·{" "}
                  {!wallet.enabled
                    ? "Helius email sign-in is not configured."
                    : marketReady
                      ? "Real Brobets escrow. Review and sign every transaction."
                      : "Matching contract awaits program upgrade and admin initialization."}
                </>
              }
            </span>
            {
              <button
                onClick={() =>
                  void loadMarket().catch((e) => setNotice(e.message))
                }
              >
                Refresh board
              </button>
            }
          </div>
          {!marketReady && wallet.admin && (
            <div className="notice">
              <span>
                Initialize matching after the upgraded program is deployed.
              </span>
              <button
                className="secondary"
                disabled={busy}
                onClick={async () => {
                  try {
                    if (!wallet.prepareMatching) return;
                    const next = await wallet.prepareMatching("initialize", {});
                    setPrepared(next);
                    setReview({
                      action: "initialize",
                      question: {
                        id: "setup",
                        title: "Initialize matching",
                        sideA: "",
                        sideB: "",
                        closesAt: "",
                        resolveBy: "",
                        category: "",
                        matchup: "",
                      },
                    });
                    setStatus("");
                  } catch (e) {
                    setNotice((e as Error).message);
                  }
                }}
              >
                Review initialization
              </button>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
              <button
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {tab === "board" ? (
            <>
              <section className="hero">
                <div className="hero-copy">
                  <div className="season">
                    <span /> Basketball. Head to head.
                  </div>
                  <h1>
                    Big takes.
                    <br />
                    <span>Back yours.</span>
                  </h1>
                  <p>
                    You know the game. Put a stake on your side
                    <br className="desktop-break" /> and find someone who sees
                    it differently.
                  </p>
                  <button
                    className="primary"
                    onClick={() =>
                      document
                        .getElementById("games")
                        ?.scrollIntoView({ behavior: "smooth" })
                    }
                  >
                    Find your matchup <ArrowRight size={17} />
                  </button>
                </div>
                <div className="court-art" aria-hidden="true">
                  <div className="court-lines">
                    <div className="center-circle" />
                    <div className="paint" />
                    <div className="arc" />
                    <div className="hoop" />
                  </div>
                  <div className="basketball">
                    <i />
                    <b />
                    <em />
                  </div>
                  <span className="court-caption">
                    The game settles the debate.
                  </span>
                </div>
              </section>
              <section className="stats" aria-label={"Devnet activity"}>
                <div>
                  <span>Open proposals</span>
                  <strong>
                    {open.length.toString().padStart(2, "0")}
                    <small>Waiting for a rival</small>
                  </strong>
                </div>
                <div>
                  <span>On the board</span>
                  <strong>
                    {dollars(open.reduce((s, w) => s + BigInt(w.units), 0n))}
                    <small>{"Brobets tokens"}</small>
                  </strong>
                </div>
                <div>
                  <span>The rules</span>
                  <strong>
                    1 : 1<small>Same stake. Opposite sides.</small>
                  </strong>
                </div>
              </section>
              <section id="games">
                <div className="section-heading">
                  <div>
                    <h2>
                      On the board
                      <span className="count">{questions.length}</span>
                    </h2>
                    <p>Pick a game. Find a take worth matching.</p>
                  </div>
                  {wallet.admin && marketReady && (
                    <button
                      className="secondary"
                      onClick={() => setModal("admin")}
                    >
                      <Plus size={16} />
                      Create question
                    </button>
                  )}
                </div>
                <div className="board-tools">
                  <div className="tabs" aria-label="Filter games">
                    {["All games", "Open for bets", "Settled"].map((f) => (
                      <button
                        key={f}
                        className={filter === f ? "selected" : ""}
                        onClick={() => setFilter(f)}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                  <input
                    aria-label="Search games"
                    placeholder="Search teams…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <div className="games">
                  {visible.map((q, i) => {
                    const available = open.filter((w) => w.questionId === q.id);
                    return (
                      <button
                        className="game-card"
                        key={q.id}
                        onClick={() => {
                          setSelected(q);
                          window.history.replaceState(
                            null,
                            "",
                            `/questions/${encodeURIComponent(q.id)}`,
                          );
                          setSide("a");
                        }}
                      >
                        <div className="card-top">
                          <span>
                            <i /> {q.category}
                          </span>
                          <span className={q.result ? "settled" : ""}>
                            {q.result ? "Final" : closes(q)}
                          </span>
                        </div>
                        <div className="teams">
                          <div>
                            <span className={`team-mark team-${i % 4}`}>
                              {q.sideA.slice(0, 3).toUpperCase()}
                            </span>
                            <b>{q.sideA}</b>
                          </div>
                          <span className="versus">vs</span>
                          <div>
                            <span className={`team-mark team-${(i + 1) % 4}`}>
                              {q.sideB.slice(0, 3).toUpperCase()}
                            </span>
                            <b>{q.sideB}</b>
                          </div>
                        </div>
                        <h3>{q.title}</h3>
                        <div className="card-bottom">
                          <span>
                            {q.result
                              ? `${q.result === "void" ? "Voided" : q.result === "a" ? q.sideA : q.sideB} ${q.result === "void" ? "" : "wins"}`
                              : `${available.length} open proposal${available.length === 1 ? "" : "s"}`}
                          </span>
                          <span>
                            {available.length
                              ? `From ${dollars(available.reduce((min, w) => (BigInt(w.units) < min ? BigInt(w.units) : min), BigInt(available[0].units)))}`
                              : "View game"}
                            <ArrowUpRight size={16} />
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
                {!visible.length && (
                  <div className="empty">
                    {!ready
                      ? "Loading basketball questions…"
                      : !marketReady
                        ? "Matching setup is required before questions can be published."
                        : questions.length === 0
                          ? "No basketball questions have been published yet."
                          : "No games match your search."}
                  </div>
                )}
              </section>
            </>
          ) : (
            <section>
              <div className="section-heading">
                <div>
                  <h1 className="page-title">Your side of the game.</h1>
                  <p>
                    Track proposals, matchups, and payouts.
                    {" Your devnet wallet."}
                  </p>
                </div>
              </div>
              <div className="wager-list">
                {!mine.length && (
                  <div className="empty">
                    {actor
                      ? "You have no wagers yet."
                      : "Sign in with email to view your wagers."}
                  </div>
                )}
                {mine.map((w) => {
                  const q = questions.find((q) => q.id === w.questionId)!;
                  return (
                    <div className="wager-row" key={w.id}>
                      <div>
                        <small>{q.matchup}</small>
                        <h3>
                          {(w.maker === actor
                            ? w.side
                            : w.side === "a"
                              ? "b"
                              : "a") === "a"
                            ? q.sideA
                            : q.sideB}{" "}
                          · {dollars(w.units)}
                        </h3>
                        <span className="muted">
                          {w.state} {q.result ? "· Result available" : ""}
                        </span>
                      </div>
                      <div className="row-actions">
                        <button
                          className="secondary"
                          onClick={() => setSelected(q)}
                        >
                          View
                        </button>
                        {w.state === "open" && w.maker === actor && (
                          <button
                            className="secondary"
                            onClick={() => start("cancel", q, w)}
                          >
                            Cancel
                          </button>
                        )}
                        {actor && claimAmount(q, w, actor) > 0n && (
                          <button
                            className="primary"
                            onClick={() => start("claim", q, w)}
                          >
                            Claim
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          <footer>
            <span className="brand-small">brobets.</span>
            <span>For the love of the game.</span>
            <span>{"Devnet escrow"} · No platform fees</span>
          </footer>
        </main>
      </div>
      {selected && (
        <Modal title={selected.title} onClose={closeQuestion}>
          <p className="muted">
            {selected.matchup} · {closes(selected)}
          </p>
          <div className="outcomes">
            {(["a", "b"] as Side[]).map((s) => (
              <button
                key={s}
                className={side === s ? "outcome chosen" : "outcome"}
                onClick={() => setSide(s)}
              >
                {s === "a" ? selected.sideA : selected.sideB}
                {side === s && <Check size={16} />}
              </button>
            ))}
          </div>
          {notice && (
            <p className="error" role="status">
              {notice}
            </p>
          )}
          <h3>Put up a proposal</h3>
          <label className="field">
            Your stake in vault tokens
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <p className="hint">
            Your stake locks when posted. A rival must match the full amount.
          </p>
          <button
            className="primary wide"
            disabled={
              busy ||
              !!selected.result ||
              Date.parse(selected.closesAt) <= Date.now()
            }
            onClick={() => start("propose", selected)}
          >
            {"Simulate and review proposal"} <ArrowRight size={16} />
          </button>
          <h3 className="modal-section">Waiting for a match</h3>
          {wagers
            .filter((w) => w.questionId === selected.id && w.state === "open")
            .map((w) => (
              <div className="proposal" key={w.id}>
                <div>
                  <b>{w.side === "a" ? selected.sideA : selected.sideB}</b>
                  <small>
                    {w.maker === actor ? "Your proposal" : "Rival’s pick"}
                  </small>
                </div>
                <strong>{dollars(w.units)}</strong>
                <button
                  className="secondary"
                  disabled={
                    busy ||
                    (w.maker !== actor &&
                      (!!selected.result ||
                        Date.parse(selected.closesAt) <= Date.now()))
                  }
                  onClick={() =>
                    start(w.maker === actor ? "cancel" : "match", selected, w)
                  }
                >
                  {w.maker === actor ? "Cancel" : "Match"}
                </button>
              </div>
            ))}
          {!wagers.some(
            (w) => w.questionId === selected.id && w.state === "open",
          ) && (
            <p className="muted">No open proposals. Start the conversation.</p>
          )}
          {wallet.admin && !selected.result && (
            <div className="admin-box">
              <h3>{"Resolve question"}</h3>
              <p className="hint">
                Resolution is available after betting closes.
              </p>
              <div className="row-actions">
                {(["a", "b", "void"] as const).map((result) => (
                  <button
                    key={result}
                    className="secondary"
                    disabled={
                      busy ||
                      Date.parse(selected.closesAt) > Date.now() ||
                      Date.parse(selected.resolveBy) <= Date.now()
                    }
                    onClick={() => {
                      void start("resolve", selected, undefined, result);
                      return;
                    }}
                  >
                    {result === "void"
                      ? "Void"
                      : `${result === "a" ? selected.sideA : selected.sideB} wins`}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Modal>
      )}
      {review && (
        <Modal
          title="Review your play"
          onClose={() => {
            if (!busy) setReview(null);
          }}
        >
          <span className="status-tag">
            {"Simulation passed · Devnet escrow"}
          </span>
          <h3>
            {review.action === "create"
              ? "Publish basketball question"
              : review.action === "initialize"
                ? "Initialize matching market"
                : review.action === "resolve"
                  ? "Settle question outcome"
                  : review.action === "expire"
                    ? "Enable deadline refunds"
                    : review.action === "match"
                      ? `Back ${review.wager?.side === "a" ? review.question.sideB : review.question.sideA}`
                      : review.action === "propose"
                        ? `Back ${side === "a" ? review.question.sideA : review.question.sideB}`
                        : review.action === "cancel"
                          ? "Cancel unmatched proposal"
                          : "Claim available payout"}
          </h3>
          <dl className="review">
            <div>
              <dt>Stake</dt>
              <dd>{dollars(prepared?.stake ?? "0")}</dd>
            </div>
            <div>
              <dt>
                {review.action === "cancel"
                  ? "Refund"
                  : review.action === "claim"
                    ? "Available payout"
                    : "Potential winning payout"}
              </dt>
              <dd>{dollars(prepared?.payout ?? "0")}</dd>
            </div>
            <div>
              <dt>Platform fee</dt>
              <dd>$0</dd>
            </div>
            <div>
              <dt>Network fee</dt>
              <dd>{`${(prepared?.feeLamports ?? 0) / 1e9} SOL`}</dd>
            </div>
          </dl>
          {
            <>
              <p className="hint">
                Fee payer: your Helius wallet. Account rent: up to{" "}
                {(prepared?.rentLamports ?? 0) / 1e9} SOL. Brobets tokens only;
                no platform fee.
              </p>
              <p className="hint wallet-address">
                {prepared?.escrowAddress
                  ? `Escrow recipient: ${prepared.escrowAddress}`
                  : `Question: ${prepared?.questionAddress ?? "Matching market setup"}`}
              </p>
              <p className="hint">
                {review.action === "resolve"
                  ? `Selected result: ${prepared?.transaction.instructions.at(-1)?.data.at(-1) === 1 ? review.question.sideA : prepared?.transaction.instructions.at(-1)?.data.at(-1) === 2 ? review.question.sideB : "Void and refund both sides"}`
                  : "Check the stake and payout before approving the wallet signature."}
              </p>
            </>
          }
          <div role="status" className="transaction-status">
            {status}
          </div>
          {!status.startsWith("Confirmed") && (
            <button className="primary wide" disabled={busy} onClick={run}>
              {busy ? "Pending…" : "Approve and sign transaction"}
            </button>
          )}
          <button
            className="text-button wide"
            disabled={busy}
            onClick={() => {
              setPrepared(null);
              setReview(null);
              setStatus("Rejected · action cancelled. No funds moved.");
            }}
          >
            Reject action
          </button>
        </Modal>
      )}
      {modal === "wallet" && (
        <Modal title="Your wallet. Your game." onClose={() => setModal(null)}>
          <span className="status-tag">Helius embedded wallet · Devnet</span>
          <p className="muted">
            Sign in with an email code. Your wallet stays in your control.
          </p>
          {wallet.error && (
            <p role="alert" className="error">
              {wallet.error}
            </p>
          )}
          {wallet.enabled ? (
            wallet.address ? (
              <>
                <p className="wallet-address">{wallet.address}</p>
                <div className="balance-grid">
                  {Object.entries(wallet.balances).map(([k, v]) => (
                    <div key={k}>
                      <small>
                        {k === "tokens" ? "Vault tokens" : k.toUpperCase()}
                      </small>
                      <strong>{v}</strong>
                    </div>
                  ))}
                </div>
                {wallet.recoverMatching && (
                  <button
                    className="secondary wide"
                    onClick={() =>
                      void wallet.recoverMatching!()
                        .then((message) => {
                          setNotice(
                            message || "No pending matching transaction.",
                          );
                          void loadMarket().catch(() => {});
                        })
                        .catch((e) => setNotice(e.message))
                    }
                  >
                    Check pending betting transaction
                  </button>
                )}
                <button className="text-button wide" onClick={wallet.refresh}>
                  Refresh balances
                </button>
                <button
                  className="secondary wide"
                  onClick={() => void wallet.authenticate().catch(() => {})}
                >
                  Verify wallet for backend access
                </button>
                <button className="text-button wide" onClick={wallet.logout}>
                  Sign out
                </button>
              </>
            ) : (
              <button className="primary wide" onClick={wallet.signIn}>
                Sign in with email <ArrowRight size={16} />
              </button>
            )
          ) : (
            <div className="admin-box">
              <h3>Wallet setup needed</h3>
              <p className="hint">
                Add HELIUS_API_KEY on the server and enable email sign-in in
                your Helius WaaS dashboard.
              </p>
            </div>
          )}
          {wallet.exchange ?? (
            <div className="token-exchange">
              <h3>1 token = 1 USDC</h3>
              <p className="hint">
                Vault trading requires Helius login and devnet deployment
                configuration.
              </p>
              <div className="row-actions">
                <button className="secondary" disabled>
                  Buy tokens
                </button>
                <button className="secondary" disabled>
                  Redeem tokens
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
      {modal === "admin" && (
        <Modal
          title={"Publish a basketball question"}
          onClose={() => setModal(null)}
        >
          <QuestionForm
            onSubmit={async (values) => {
              if (!wallet.prepareMatching)
                throw Error("Sign in as admin first");
              const next = await wallet.prepareMatching("create", {
                draft: values,
              });
              setPrepared(next);
              setReview({ action: "create", question: next.question! });
              setStatus("");
              setModal(null);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
function QuestionForm({
  onSubmit,
}: {
  onSubmit: (values: {
    title: string;
    sideA: string;
    sideB: string;
    closesAt: string;
    resolveBy: string;
  }) => Promise<void>;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          const data = new FormData(e.currentTarget);
          const values = {
            title: String(data.get("title")).trim(),
            sideA: String(data.get("sideA")).trim(),
            sideB: String(data.get("sideB")).trim(),
            closesAt: new Date(String(data.get("closesAt"))).toISOString(),
            resolveBy: new Date(String(data.get("resolveBy"))).toISOString(),
          };
          if (
            Date.parse(values.closesAt) <= Date.now() ||
            Date.parse(values.resolveBy) <= Date.parse(values.closesAt) ||
            values.sideA === values.sideB
          )
            throw Error(
              "Choose different outcomes and future, ordered deadlines.",
            );
          await onSubmit(values);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {[
        ["title", "Basketball question"],
        ["sideA", "Outcome A"],
        ["sideB", "Outcome B"],
        ["closesAt", "Betting closes"],
        ["resolveBy", "Resolve by"],
      ].map(([name, label]) => (
        <label className="field" key={name}>
          {label}
          <input
            name={name}
            type={
              name.endsWith("At") || name === "resolveBy"
                ? "datetime-local"
                : "text"
            }
            required
            minLength={name === "title" ? 10 : 1}
            maxLength={name === "title" ? 200 : 80}
          />
        </label>
      ))}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button className="primary wide" disabled={busy}>
        {busy ? "Checking…" : "Simulate and review publication"}
      </button>
    </form>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeHandler = useRef(onClose);
  closeHandler.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const node = dialog.current;
    node?.showModal();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeHandler.current();
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      node?.close();
      queueMicrotask(() => previous?.focus());
    };
  }, []);
  return (
    <dialog ref={dialog} className="modal" aria-label={title}>
      <div className="modal-top">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={21} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
