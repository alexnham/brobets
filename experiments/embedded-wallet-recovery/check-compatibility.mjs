import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Source inspection only: no wallet, secret, provider call, or transaction.
const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const kit = "web/node_modules/helius-wallet-kit/";
const turnkey = "web/node_modules/@turnkey/";
const map = JSON.parse(read(`${kit}dist/core/index.js.map`));
const sourceIndex = map.sources.findIndex((s) => s.endsWith("/useHeliusWallet.ts"));
assert(sourceIndex >= 0, "Wallet hook source missing; re-inspect SDK");
const hook = map.sourcesContent[sourceIndex];
const types = read(`${kit}dist/core/index.d.ts`);
const provider = read(`${turnkey}react-wallet-kit/dist/providers/client/Provider.js`);
const modal = read(`${turnkey}react-wallet-kit/dist/components/sign/Message.js`);
const core = read(`${turnkey}core/dist/__clients__/core.js`);
assert.match(types, /signMessage: \(message: string\) => Promise<string>/);
assert.match(hook, /handleSignMessage\(\{\s*message,\s*walletAccount,\s*\}\)/);
assert.match(provider, /message: params\.message/);
assert.match(modal, /await signMessage\(\{\s*message,\s*walletAccount,/);
assert.match(core, /let msgBytes = ethers\.toUtf8Bytes\(message\)/);

// Public fixture using the documented Solana off-chain v0 envelope.
const payload = Buffer.from("TSPP/derive/v1");
const length = Buffer.alloc(2);
length.writeUInt16LE(payload.length);
const envelope = Buffer.concat([
  Buffer.from([0xff]), Buffer.from("solana offchain"), Buffer.from([0]),
  createHash("sha256").update(payload).digest(), Buffer.from([0, 1]),
  Buffer.alloc(32, 1), length, payload,
]);
assert.equal(envelope[0], 0xff);
// Neither interpreting binary as Latin-1 nor decoding it as UTF-8 preserves it.
for (const encoding of ["latin1", "utf8"]) {
  assert.notDeepEqual(Buffer.from(envelope.toString(encoding), "utf8"), envelope);
}
console.log(JSON.stringify({
  walletKit: JSON.parse(read(`${kit}package.json`)).version,
  turnkeyReactWalletKit: JSON.parse(read(`${turnkey}react-wallet-kit/package.json`)).version,
  turnkeyCore: JSON.parse(read(`${turnkey}core/package.json`)).version,
  walletHookSha256: createHash("sha256").update(hook).digest("hex"),
  turnkeyCoreSha256: createHash("sha256").update(core).digest("hex"),
  result: "Installed Helius signMessage uses UTF-8 text; cannot sign the canonical binary derivation envelope unchanged.",
  liveRecoveryTested: false,
}, null, 2));
