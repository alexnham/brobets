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
  Clock3,
  Trophy,
  ChevronRight,
  Plus,
  CircleDot,
  Menu,
} from "lucide-react";
import { VaultExchange } from "./vault-exchange";
import { fixtures, transition, DEMO_USER } from "@/lib/demo";
import { formatAmount, parseAmount } from "@/lib/money";
import type { Question, Wager, Side } from "@/lib/escrow";

type WalletState = {
  address: string | null;
  admin: boolean;
  enabled: boolean;
  connect: () => Promise<void>;
  authenticate: () => Promise<void>;
  logout: () => Promise<void>;
  balances: { sol: string; usdc: string; tokens: string };
  error: string;
  exchange?: ReactNode;
};
const emptyWallet: WalletState = {
  address: null,
  admin: false,
  enabled: false,
  connect: async () => {},
  authenticate: async () => {},
  logout: async () => {},
  balances: { sol: "—", usdc: "—", tokens: "—" },
  error: "",
};
export function Brobets({ walletEnabled }: { walletEnabled: boolean }) {
  return walletEnabled ? (
    <HeliusWalletProvider
      config={{
        cluster: "devnet",
        authMethods: { email: true, passkey: false, wallet: false, sms: false },
        theme: { darkMode: true, primaryColor: "#ff7545" },
      }}
    >
      <Connected />
    </HeliusWalletProvider>
  ) : (
    <Board wallet={emptyWallet} />
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
function Connected() {
  const w = useHeliusWallet();
  const [admin, setAdmin] = useState(false),
    [error, setError] = useState("");
  const [balances, setBalances] = useState(emptyWallet.balances);
  useEffect(() => {
    setAdmin(false);
    if (!w.address) return;
    api("/api/auth/session")
      .then((s) => setAdmin(s.wallet === w.address && s.admin))
      .catch(() => {});
    import("@/lib/wallet")
      .then((m) => m.readBalances(w.connection, w.address!))
      .then(setBalances)
      .catch((e) => setError(e.message));
  }, [w.address, w.connection]);
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
    }
  };
  return (
    <Board
      wallet={{
        address: w.address,
        admin,
        enabled: true,
        balances,
        error,
        exchange: <VaultExchange />,
        connect: async () => {
          try {
            await w.login();
          } catch (e) {
            setError((e as Error).message);
          }
        },
        authenticate,
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
function Board({ wallet }: { wallet: WalletState }) {
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
      action: "propose" | "match" | "cancel" | "claim";
      question: Question;
      wager?: Wager;
    } | null>(null),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  const [demoAdmin, setDemoAdmin] = useState(false),
    [notice, setNotice] = useState("");
  useEffect(() => {
    const seed = fixtures();
    try {
      const saved = sessionStorage.getItem("brobets-demo-v1");
      const data = saved ? JSON.parse(saved) : seed;
      setQuestions(data.questions);
      setWagers(data.wagers);
    } catch {
      setQuestions(seed.questions);
      setWagers(seed.wagers);
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (ready)
      sessionStorage.setItem(
        "brobets-demo-v1",
        JSON.stringify({ questions, wagers }),
      );
  }, [questions, wagers, ready]);
  const open = wagers.filter(
    (w) =>
      w.state === "open" &&
      !questions.find((q) => q.id === w.questionId)?.result,
  );
  const mine = wagers.filter(
    (w) => w.maker === DEMO_USER || w.taker === DEMO_USER,
  );
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
    setStatus("Pending · checking demo escrow…");
    try {
      await new Promise((r) => setTimeout(r, 450));
      setWagers((current) =>
        transition(
          current,
          questions,
          review.action,
          {
            questionId: review.question.id,
            wagerId: review.wager?.id,
            side,
            amount,
          },
          DEMO_USER,
        ),
      );
      setStatus("Confirmed · demo only, no funds moved.");
    } catch (e) {
      setStatus(`Failed · ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const start = (
    action: "propose" | "match" | "cancel" | "claim",
    question: Question,
    wager?: Wager,
  ) => {
    try {
      if (action === "propose") parseAmount(amount);
      setReview({ action, question, wager });
      setStatus("");
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  const reset = () => {
    const seed = fixtures();
    setQuestions(seed.questions);
    setWagers(seed.wagers);
    setDemoAdmin(false);
    setNotice("Demo reset.");
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
        <button className="text-button" onClick={reset}>
          Reset demo
        </button>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <span className="breadcrumb">
            The court <span>/</span> {tab === "board" ? "Bet board" : "My bets"}
          </span>
          <div className="top-actions">
            <span className="network">
              <i /> Devnet
            </span>
            <button
              className="wallet-button"
              onClick={() => setModal("wallet")}
            >
              <Wallet size={16} />
              {wallet.address
                ? wallet.address.slice(0, 4) + "…" + wallet.address.slice(-4)
                : "Connect wallet"}
            </button>
          </div>
        </header>
        <main>
          <div className="demo-banner">
            <span>
              <b>Demo court</b> · Sample games and simulated wagers. No real
              funds move.
            </span>
            <button
              onClick={() => {
                setDemoAdmin(!demoAdmin);
                setNotice(
                  !demoAdmin
                    ? "Demo admin enabled. This grants no backend permissions."
                    : "Demo admin disabled.",
                );
              }}
            >
              {demoAdmin ? "Exit demo admin" : "Try admin view"}
              <ArrowUpRight size={14} />
            </button>
          </div>
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
              <section className="stats" aria-label="Demo activity">
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
                    <small>Demo vault tokens</small>
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
                  {(demoAdmin || wallet.admin) && (
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
                  <div className="empty">No games match your search.</div>
                )}
              </section>
            </>
          ) : (
            <section>
              <div className="section-heading">
                <div>
                  <h1 className="page-title">Your side of the game.</h1>
                  <p>Track proposals, matchups, and payouts. Demo account.</p>
                </div>
              </div>
              <div className="wager-list">
                {mine.map((w) => {
                  const q = questions.find((q) => q.id === w.questionId)!;
                  return (
                    <div className="wager-row" key={w.id}>
                      <div>
                        <small>{q.matchup}</small>
                        <h3>
                          {w.side === "a" ? q.sideA : q.sideB} ·{" "}
                          {dollars(w.units)}
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
                        {w.state === "open" && (
                          <button
                            className="secondary"
                            onClick={() => start("cancel", q, w)}
                          >
                            Cancel
                          </button>
                        )}
                        {!["claimed", "cancelled"].includes(w.state) &&
                          (q.result ||
                            Date.parse(q.closesAt) <= Date.now()) && (
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
            <span>Devnet demo · No platform fees</span>
          </footer>
        </main>
      </div>
      {selected && (
        <Modal title={selected.title} onClose={() => setSelected(null)}>
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
              !!selected.result || Date.parse(selected.closesAt) <= Date.now()
            }
            onClick={() => start("propose", selected)}
          >
            Review demo proposal <ArrowRight size={16} />
          </button>
          <h3 className="modal-section">Waiting for a match</h3>
          {wagers
            .filter((w) => w.questionId === selected.id && w.state === "open")
            .map((w) => (
              <div className="proposal" key={w.id}>
                <div>
                  <b>{w.side === "a" ? selected.sideA : selected.sideB}</b>
                  <small>
                    {w.maker === DEMO_USER ? "Your proposal" : "Rival’s pick"}
                  </small>
                </div>
                <strong>{dollars(w.units)}</strong>
                <button
                  className="secondary"
                  disabled={
                    !!selected.result ||
                    Date.parse(selected.closesAt) <= Date.now()
                  }
                  onClick={() =>
                    start(
                      w.maker === DEMO_USER ? "cancel" : "match",
                      selected,
                      w,
                    )
                  }
                >
                  {w.maker === DEMO_USER ? "Cancel" : "Match"}
                </button>
              </div>
            ))}
          {!wagers.some(
            (w) => w.questionId === selected.id && w.state === "open",
          ) && (
            <p className="muted">No open proposals. Start the conversation.</p>
          )}
          {demoAdmin && !selected.result && (
            <div className="admin-box">
              <h3>Demo resolution</h3>
              <p className="hint">
                Resolution is available after betting closes.
              </p>
              <div className="row-actions">
                {(["a", "b", "void"] as const).map((result) => (
                  <button
                    key={result}
                    className="secondary"
                    disabled={Date.parse(selected.closesAt) > Date.now()}
                    onClick={() => {
                      const next = { ...selected, result };
                      setQuestions((qs) =>
                        qs.map((q) => (q.id === next.id ? next : q)),
                      );
                      setSelected(next);
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
          <span className="demo-tag">Simulated transaction · Devnet</span>
          <h3>
            {review.action === "match"
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
              <dd>{dollars(review.wager?.units ?? parseAmount(amount))}</dd>
            </div>
            <div>
              <dt>Potential winning payout</dt>
              <dd>
                {dollars(
                  BigInt(review.wager?.units ?? parseAmount(amount)) * 2n,
                )}
              </dd>
            </div>
            <div>
              <dt>Platform fee</dt>
              <dd>$0</dd>
            </div>
            <div>
              <dt>Network fee</dt>
              <dd>Simulated · 0 SOL charged</dd>
            </div>
          </dl>
          <p className="hint">
            No wallet signature will be requested. Real funding is disabled
            until the matching escrow deployment is connected.
          </p>
          <div role="status" className="transaction-status">
            {status}
          </div>
          {!status.startsWith("Confirmed") && (
            <button className="primary wide" disabled={busy} onClick={run}>
              {busy ? "Pending…" : "Confirm demo action"}
            </button>
          )}
          <button
            className="text-button wide"
            disabled={busy}
            onClick={() => {
              setStatus("Rejected · action cancelled. No funds moved.");
            }}
          >
            Reject action
          </button>
        </Modal>
      )}
      {modal === "wallet" && (
        <Modal title="Your wallet. Your game." onClose={() => setModal(null)}>
          <span className="demo-tag">Helius embedded wallet · Devnet</span>
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
                <button
                  className="secondary wide"
                  onClick={wallet.authenticate}
                >
                  Verify wallet for backend access
                </button>
                <button className="text-button wide" onClick={wallet.logout}>
                  Sign out
                </button>
              </>
            ) : (
              <button className="primary wide" onClick={wallet.connect}>
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
          title={demoAdmin ? "Create a demo question" : "Save question draft"}
          onClose={() => setModal(null)}
        >
          <QuestionForm
            demo={demoAdmin}
            onSubmit={async (values) => {
              if (demoAdmin) {
                setQuestions((q) => [
                  ...q,
                  {
                    ...values,
                    id: crypto.randomUUID(),
                    category: "Game winner",
                    matchup: `${values.sideA} / ${values.sideB}`,
                  },
                ]);
                setNotice(
                  "Demo question published. No on-chain account created.",
                );
              } else {
                await api("/api/questions", values);
                setNotice(
                  "Draft saved. Publishing awaits the matching escrow integration.",
                );
              }
              setModal(null);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
function QuestionForm({
  demo,
  onSubmit,
}: {
  demo: boolean;
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
        {busy ? "Saving…" : demo ? "Publish demo question" : "Save draft"}
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
    dialog.current?.showModal();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeHandler.current();
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      previous?.focus();
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
