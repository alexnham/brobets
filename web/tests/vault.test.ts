import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Connection, PublicKey, Keypair, VersionedTransaction } from "@solana/web3.js";
import {
  MintLayout,
  AccountLayout,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { prepareVaultTrade } from "../lib/wallet";
test("vault trade uses existing Anchor ABI, simulates, estimates rent and rejects substituted accounts", async (t) => {
  const pid = Keypair.generate().publicKey,
    usdc = Keypair.generate().publicKey,
    user = Keypair.generate().publicKey;
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
      assert.equal(tx.message.compiledInstructions.length, 3);
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
    const instruction = prepared.transaction.instructions[2];
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
    assert.equal(prepared.rentLamports, 4078560);
    assert.equal(prepared.transaction.feePayer?.toBase58(), user.toBase58());
  }
  assert.equal(simulated, 2);
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
