import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  MintLayout,
  AccountLayout,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  prepareVaultTrade,
  quoteBuy,
  TREASURY_AUTHORITY,
} from "../lib/wallet";
import { sponsorSign } from "../lib/sponsor";
test("buy quote charges 1.10 USDC per BB with the premium rounded up", () => {
  assert.deepEqual(quoteBuy(10_000_000n), {
    quantity: 10_000_000n,
    backing: 10_000_000n,
    premium: 1_000_000n,
    total: 11_000_000n,
  });
  for (const [quantity, premium] of [
    [1n, 1n],
    [10n, 1n],
    [11n, 2n],
    [2_500_001n, 250_001n],
  ])
    assert.equal(quoteBuy(quantity).premium, premium);
});
test("vault trade uses existing Anchor ABI, simulates, estimates rent and rejects substituted accounts", async (t) => {
  const pid = Keypair.generate().publicKey,
    usdc = Keypair.generate().publicKey,
    userKey = Keypair.generate(),
    user = userKey.publicKey;
  process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID = pid.toBase58();
  process.env.NEXT_PUBLIC_USDC_MINT = usdc.toBase58();
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), usdc.toBuffer()],
    pid,
  );
  const [token] = PublicKey.findProgramAddressSync(
    [Buffer.from("token"), vault.toBuffer()],
    pid,
  );
  const [reserve] = PublicKey.findProgramAddressSync(
    [Buffer.from("reserve"), vault.toBuffer()],
    pid,
  );
  const state = Buffer.concat([
    createHash("sha256").update("account:Vault").digest().subarray(0, 8),
    usdc.toBuffer(),
    token.toBuffer(),
    Buffer.from([1]),
  ]);
  const mint = (authority: PublicKey) => {
    const b = Buffer.alloc(MintLayout.span);
    MintLayout.encode(
      {
        mintAuthorityOption: 1,
        mintAuthority: authority,
        supply: 100000000n,
        decimals: 6,
        isInitialized: true,
        freezeAuthorityOption: 0,
        freezeAuthority: PublicKey.default,
      },
      b,
    );
    return b;
  };
  const reserveData = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint: usdc,
      owner: vault,
      amount: 100000000n,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    reserveData,
  );
  const account = (data: Buffer, owner: PublicKey) => ({
    data,
    owner,
    lamports: 10000000,
    executable: false,
    rentEpoch: 0,
  });
  const records = new Map([
    [vault.toBase58(), account(state, pid)],
    [usdc.toBase58(), account(mint(user), TOKEN_PROGRAM_ID)],
    [token.toBase58(), account(mint(vault), TOKEN_PROGRAM_ID)],
    [reserve.toBase58(), account(reserveData, TOKEN_PROGRAM_ID)],
  ]);
  let simulated = 0,
    fail = false;
  const mock = {
    getAccountInfo: async (p: PublicKey) => records.get(p.toBase58()) ?? null,
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    }),
    simulateTransaction: async (tx: VersionedTransaction) => {
      simulated++;
      return {
        value: { err: fail ? { InstructionError: [2, "Custom"] } : null },
      };
    },
    getFeeForMessage: async () => ({ value: 5000 }),
    getMinimumBalanceForRentExemption: async () => 2039280,
  } as unknown as Connection;
  // Browser Buffer shims do not implement Node's bigint writer.
  t.mock.method(Buffer.prototype, "writeBigUInt64LE", () => {
    throw new Error("writeBigUInt64LE is unavailable in the browser");
  });
  for (const action of ["buy", "sell"] as const) {
    const prepared = await prepareVaultTrade(
      mock,
      user.toBase58(),
      action,
      "5.123456",
    );
    const buying = action === "buy";
    // Buying adds the treasury account creation and passes it as the ninth account.
    assert.equal(prepared.transaction.instructions.length, buying ? 4 : 3);
    const instruction = prepared.transaction.instructions.at(-1)!;
    assert.equal(instruction.keys.length, buying ? 9 : 8);
    if (buying) {
      assert.equal(
        instruction.keys[8].pubkey.toBase58(),
        getAssociatedTokenAddressSync(usdc, TREASURY_AUTHORITY).toBase58(),
      );
      assert.equal(instruction.keys[8].isWritable, true);
      assert.deepEqual(prepared.quote, quoteBuy(5123456n));
      assert.equal(prepared.quote!.total, 5635802n);
    } else assert.equal(prepared.quote, null);
    assert.deepEqual(
      instruction.data.subarray(0, 8),
      createHash("sha256").update(`global:${action}`).digest().subarray(0, 8),
    );
    assert.equal(instruction.data.readBigUInt64LE(8), 5123456n);
    assert.equal(
      instruction.keys[5].pubkey.toBase58(),
      getAssociatedTokenAddressSync(usdc, user).toBase58(),
    );
    assert.equal(prepared.feeLamports, 5000);
    assert.equal(prepared.rentLamports, buying ? 6117840 : 4078560);
    assert.equal(prepared.transaction.feePayer?.toBase58(), user.toBase58());
  }
  assert.equal(simulated, 2);
  // Sponsored: Brobets pays the fee and creates token accounts; the player still signs.
  const sponsor = Keypair.generate(),
    other = Keypair.generate();
  const sponsored = async (action: "buy" | "sell") => {
    const p = await prepareVaultTrade(
      mock,
      user.toBase58(),
      action,
      "5",
      sponsor.publicKey.toBase58(),
    );
    assert.equal(p.sponsored, true);
    assert.equal(p.user, user.toBase58());
    assert.equal(p.transaction.feePayer!.toBase58(), sponsor.publicKey.toBase58());
    for (const ix of p.transaction.instructions.slice(0, -1))
      assert.equal(ix.keys[0].pubkey.toBase58(), sponsor.publicKey.toBase58());
    return p.transaction;
  };
  const sign = (tx: Transaction, player = user, signer = userKey) => {
    tx.partialSign(signer);
    return sponsorSign(tx.serialize({ requireAllSignatures: false }), sponsor, player);
  };
  for (const action of ["buy", "sell"] as const) {
    const tx = await sponsored(action),
      message = tx.serializeMessage(),
      out = Transaction.from(sign(tx));
    assert.ok(out.serializeMessage().equals(message));
    assert.ok(out.verifySignatures());
  }
  // Refused: another session's player, a different treasury, a sponsor-paid transfer,
  // a treasury creation on a sell, and an extra instruction.
  assert.throws(() => sign(Transaction.from(Buffer.alloc(0))), /./);
  const wrongPlayer = await sponsored("buy");
  assert.throws(() => sign(wrongPlayer, other.publicKey), /./);
  const treasury = await sponsored("buy");
  treasury.instructions.at(-1)!.keys[8].pubkey = getAssociatedTokenAddressSync(
    usdc,
    other.publicKey,
  );
  assert.throws(() => sign(treasury), /trade accounts/);
  const drain = await sponsored("sell");
  drain.instructions[0] = SystemProgram.transfer({
    fromPubkey: sponsor.publicKey,
    toPubkey: user,
    lamports: 1,
  });
  assert.throws(() => sign(drain), /token account creation/);
  const sellTreasury = await sponsored("sell"),
    buyTx = await sponsored("buy");
  sellTreasury.instructions.unshift(buyTx.instructions[2]);
  assert.throws(() => sign(sellTreasury), /instruction count/);
  const amount = await sponsored("sell");
  amount.instructions.at(-1)!.data = Buffer.concat([
    amount.instructions.at(-1)!.data,
    Buffer.from([0]),
  ]);
  assert.throws(() => sign(amount), /trade accounts/);
  // Without a sponsor the player pays exactly as before.
  const own = await prepareVaultTrade(mock, user.toBase58(), "buy", "5");
  assert.equal(own.sponsored, false);
  assert.throws(() => sign(own.transaction), /fee payer/);
  fail = true;
  await assert.rejects(
    prepareVaultTrade(mock, user.toBase58(), "buy", "5"),
    /Simulation failed/,
  );
  records.set(vault.toBase58(), account(state, TOKEN_PROGRAM_ID));
  await assert.rejects(
    prepareVaultTrade(mock, user.toBase58(), "buy", "5"),
    /expected program/,
  );
  delete process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID;
  delete process.env.NEXT_PUBLIC_USDC_MINT;
});
