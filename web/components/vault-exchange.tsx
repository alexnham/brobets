"use client";
import { useState, useEffect } from "react";
import { useHeliusWallet } from "helius-wallet-kit";
import { prepareVaultTrade } from "@/lib/wallet";
import { formatAmount } from "@/lib/money";
export function VaultExchange({
  onConfirmed,
}: {
  onConfirmed: () => Promise<void>;
}) {
  const wallet = useHeliusWallet();
  const [action, setAction] = useState<"buy" | "sell">("buy"),
    [amount, setAmount] = useState("5"),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<Awaited<
    ReturnType<typeof prepareVaultTrade>
  > | null>(null);
  const configured =
    !!process.env.NEXT_PUBLIC_USDC_MINT &&
    !!process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID;
  const storageKey = `brobets-vault-pending:${wallet.address}`;
  useEffect(() => {
    const signature = localStorage.getItem(storageKey);
    if (!signature) return;
    wallet.connection
      .getSignatureStatuses([signature], { searchTransactionHistory: true })
      .then(({ value }) => {
        const s = value[0];
        setStatus(
          s?.err
            ? `Failed · ${signature}`
            : s?.confirmationStatus === "confirmed" ||
                s?.confirmationStatus === "finalized"
              ? `Confirmed · ${signature}`
              : `Pending or expired · ${signature}. Check Explorer before retrying.`,
        );
        if (
          s?.err ||
          s?.confirmationStatus === "confirmed" ||
          s?.confirmationStatus === "finalized"
        )
          localStorage.removeItem(storageKey);
      })
      .catch(() =>
        setStatus(
          "Unable to recover previous transaction. Check Explorer before retrying.",
        ),
      );
  }, [wallet.connection, storageKey]);
  const prepare = async () => {
    setBusy(true);
    setPrepared(null);
    try {
      if (wallet.cluster !== "devnet")
        throw Error("Switch to devnet before trading.");
      const result = await prepareVaultTrade(
        wallet.connection,
        wallet.address!,
        action,
        amount,
      );
      setPrepared(result);
      setStatus("Simulation passed. Review before signing.");
    } catch (e) {
      setStatus(`Failed · ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (!prepared) return;
    setBusy(true);
    try {
      if (wallet.cluster !== "devnet") throw Error("Devnet required.");
      if (prepared.transaction.feePayer?.toBase58() !== wallet.address)
        throw Error("Wallet changed. Simulate again.");
      if (
        (await wallet.connection.getBlockHeight("confirmed")) >
        prepared.lifetime.lastValidBlockHeight
      )
        throw Error("Review expired. Simulate again.");
      setStatus("Waiting for wallet approval…");
      const signature = await wallet.signAndSendTransaction(
        prepared.transaction.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        }),
      );
      localStorage.setItem(storageKey, signature);
      setStatus(`Pending · ${signature}`);
      setPrepared(null);
      const result = await wallet.connection.confirmTransaction(
        { ...prepared.lifetime, signature },
        "confirmed",
      );
      if (result.value.err)
        throw Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
      localStorage.removeItem(storageKey);
      setStatus(`Confirmed · ${signature}`);
      await onConfirmed();
    } catch (e) {
      setStatus(
        `Failed or rejected · ${(e as Error).message}. If submitted, check the saved signature before retrying.`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="token-exchange">
      <h3>1 BB = 1 USDC · 10% fee to buy</h3>
      <p className="hint">
        Devnet only. Original SPL tokens. Network fees and account rent are paid
        separately in SOL.
      </p>
      {configured && wallet.address ? (
        <>
          <div className="row-actions">
            <button
              disabled={busy}
              className="secondary"
              onClick={() => {
                setAction("buy");
                setPrepared(null);
              }}
            >
              Buy tokens
            </button>
            <button
              disabled={busy}
              className="secondary"
              onClick={() => {
                setAction("sell");
                setPrepared(null);
              }}
            >
              Redeem tokens
            </button>
          </div>
          <label className="field">
            {action === "buy" ? "BB to buy" : "BB to redeem"}
            <input
              value={amount}
              disabled={busy}
              inputMode="decimal"
              onChange={(e) => {
                setAmount(e.target.value);
                setPrepared(null);
              }}
            />
          </label>
          {prepared ? (
            <>
              <p className="hint">
                {prepared.quote ? (
                  <>
                    Quantity: {formatAmount(prepared.quote.quantity)} BB
                    <br />
                    Backing (to reserve): {formatAmount(prepared.quote.backing)}{" "}
                    USDC
                    <br />
                    Fee (10%, to treasury):{" "}
                    {formatAmount(prepared.quote.premium)} USDC
                    <br />
                    Total: {formatAmount(prepared.quote.total)} USDC
                  </>
                ) : (
                  <>
                    Redeem {amount} BB for {amount} USDC · no fee
                  </>
                )}
                <br />
                Fee payer: your wallet · Devnet
                <br />
                Network fee: {prepared.feeLamports / 1e9} SOL
                <br />
                Account rent: up to {prepared.rentLamports / 1e9} SOL
              </p>
              <button disabled={busy} className="primary wide" onClick={send}>
                Approve and sign transaction
              </button>
            </>
          ) : (
            <button disabled={busy} className="primary wide" onClick={prepare}>
              {busy ? "Checking…" : "Simulate and review"}
            </button>
          )}
          <p role="status" className="hint wallet-address">
            {status}
          </p>
        </>
      ) : (
        <>
          <p className="hint">
            Sign in and configure the devnet USDC mint and deployed vault
            program to enable trading.
          </p>
          <div className="row-actions">
            <button className="secondary" disabled>
              Buy tokens
            </button>
            <button className="secondary" disabled>
              Redeem tokens
            </button>
          </div>
        </>
      )}
    </div>
  );
}
