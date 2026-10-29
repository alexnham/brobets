import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { metadataInstruction, verifyMetadata, prepare } = require("../../scripts/token-metadata.cjs");
const { PublicKey } = require("@solana/web3.js");
const program = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const authority = new PublicKey("GbDLTR4JK4EdZAtjXqAVDx3vWg2BwwEiESxsLqhDNEiG");
const mint = new PublicKey("yU47auGVnuqUqYACt8u3388nfP29mTWQcLRgAHPAjMC");
function string(value: string) { const data = Buffer.from(value); const length = Buffer.alloc(4); length.writeUInt32LE(data.length); return Buffer.concat([length, data]); }
function account() {
  return { owner: program, data: Buffer.concat([Buffer.from([4]), authority.toBuffer(), mint.toBuffer(),
    string("BROBETS"), string("BB"), string("https://alexnham.github.io/storage/brobets.json"), Buffer.from([0, 0, 0, 0, 1])]) };
}
test("metadata instruction matches the generated Anchor ABI and canonical metadata PDA", () => {
  const instruction = metadataInstruction();
  const idl = JSON.parse(readFileSync(new URL("../../target/idl/token_vault.json", import.meta.url), "utf8"));
  const definition = idl.instructions.find((ix: { name: string }) => ix.name === "create_token_metadata");
  assert.deepEqual([...instruction.data], definition.discriminator);
  assert.equal(instruction.keys.length, definition.accounts.length);
  assert.deepEqual(instruction.keys.map((key: { isSigner: boolean }) => key.isSigner), definition.accounts.map((a: { signer?: boolean }) => !!a.signer));
  assert.deepEqual(instruction.keys.map((key: { isWritable: boolean }) => key.isWritable), definition.accounts.map((a: { writable?: boolean }) => !!a.writable));
  assert.equal(instruction.keys[3].pubkey.toBase58(), "9XuardGkf2UxULbiMVLgwvWPXp1hmE48HsnRFR1TwCe6");
});
test("metadata verification checks branding, ownership, authority, mutability, and bounds", () => {
  assert.equal(verifyMetadata(account()).symbol, "BB");
  for (const offset of [0, 1, 33, account().data.length - 1]) {
    const bad = account(); bad.data[offset] ^= 1;
    assert.throws(() => verifyMetadata(bad));
  }
  assert.throws(() => verifyMetadata({ ...account(), owner: authority }));
  assert.throws(() => verifyMetadata({ owner: program, data: account().data.subarray(0, 80) }));
});
test("metadata preparation prevents duplicate creation and rejects a wrong cluster", async () => {
  const connection = { getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", getAccountInfo: async () => account() };
  assert.equal((await prepare(connection)).existing, true);
  await assert.rejects(prepare({ getGenesisHash: async () => "mainnet" }), /Devnet required/);
});
