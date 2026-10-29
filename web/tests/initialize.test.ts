import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { INITIALIZE_ACCOUNTS, INITIALIZE_PAYER, INITIALIZE_PROGRAM, INITIALIZE_USDC, initializeInstruction, prepareVaultInitialize, verifyVaultInitialized } from "../lib/initialize-vault";

test("initialization uses the payer, correct seeds, and deployed instruction layout", () => {
  const instruction = initializeInstruction(INITIALIZE_PAYER);
  assert.throws(() => initializeInstruction(INITIALIZE_USDC.toBase58()), /payer wallet/);
  assert.equal(instruction.programId.toBase58(), INITIALIZE_PROGRAM.toBase58());
  assert.deepEqual(instruction.data, createHash("sha256").update("global:initialize").digest().subarray(0, 8));
  const idl = JSON.parse(readFileSync(new URL("../../target/idl/token_vault.json", import.meta.url), "utf8"));
  const initialize = idl.instructions.find((instruction: { name: string }) => instruction.name === "initialize");
  assert.deepEqual([...instruction.data], initialize.discriminator);
  assert.equal(instruction.keys.length, initialize.accounts.length);
  assert.deepEqual(instruction.keys.filter(key => key.isSigner).map(key => key.pubkey.toBase58()), [INITIALIZE_PAYER]);
  assert.deepEqual(instruction.keys.map(key => key.isWritable), initialize.accounts.map((account: { writable?: boolean }) => !!account.writable));
  assert.equal(INITIALIZE_ACCOUNTS.vault.toBase58(), PublicKey.findProgramAddressSync([Buffer.from("vault"), INITIALIZE_USDC.toBuffer()], INITIALIZE_PROGRAM)[0].toBase58());
  assert.equal(INITIALIZE_ACCOUNTS.tokenMint.toBase58(), "yU47auGVnuqUqYACt8u3388nfP29mTWQcLRgAHPAjMC");
  assert.equal(INITIALIZE_ACCOUNTS.reserve.toBase58(), "AefhcK8bHKXxGyfTSbUtb9VmuVYHStx6H1EBFdVE8iRg");
});

test("initialization rejects the wrong network before simulating or signing", async () => {
  const connection = { getGenesisHash: async () => "mainnet" } as unknown as Connection;
  await assert.rejects(prepareVaultInitialize(connection, INITIALIZE_PAYER), /Devnet is required/);
});

test("verification rejects missing or substituted vault state", async () => {
  for (const info of [null, { owner: INITIALIZE_USDC, data: Buffer.alloc(73) }, { owner: INITIALIZE_PROGRAM, data: Buffer.alloc(73) }]) {
    const connection = { getAccountInfo: async () => info } as unknown as Connection;
    await assert.rejects(verifyVaultInitialized(connection), /expected configuration/);
  }
});
