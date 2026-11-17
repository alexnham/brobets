import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../web/package.json", import.meta.url));
// The package root exports this as a type only; inspect the installed client.
const { TurnkeySDKClientBase } = require("@turnkey/core/dist/__generated__/sdk-client-base.js");
// Covers every byte, including the 0xff that the text API cannot represent.
const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const input = {
  signWith: "fixture-wallet-address",
  payload: bytes.toString("hex"),
  encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
  hashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
};
let stampedBody;
let requests = 0;
let deny = false;
const client = new TurnkeySDKClientBase({
  apiBaseUrl: "https://fixture.invalid",
  organizationId: "fixture-parent-org",
  storageManager: {
    getActiveSession: async () => ({ organizationId: "fixture-user-suborg" }),
  },
  // This is a fake request stamp, never a user's credential or spending key.
  apiKeyStamper: {
    stamp: async (body) => {
      stampedBody = body;
      return { stampHeaderName: "X-Stamp", stampHeaderValue: "fixture-only" };
    },
  },
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  requests++;
  assert.equal(url, "https://fixture.invalid/public/v1/submit/sign_raw_payload");
  assert.equal(init.method, "POST");
  assert.equal(init.body, stampedBody);
  assert.equal(init.headers["X-Stamp"], "fixture-only");
  const body = JSON.parse(init.body);
  assert.equal(body.organizationId, "fixture-user-suborg");
  assert.equal(body.type, "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2");
  assert.deepEqual(body.parameters, input);
  assert.deepEqual(Buffer.from(body.parameters.payload, "hex"), bytes);
  if (deny) return Response.json({ code: 7, message: "fixture policy denial" }, { status: 403 });
  // No signature is generated. This only exercises the real SDK transport.
  return Response.json({ activity: {
    status: "ACTIVITY_STATUS_COMPLETED",
    result: { signRawPayloadResult: { r: "fixture-r", s: "fixture-s" } },
  } });
};
try {
  const result = await client.signRawPayload(input);
  assert.equal(result.r, "fixture-r");
  deny = true;
  await assert.rejects(client.signRawPayload(input), /fixture policy denial/);
  assert.equal(requests, 2);
  console.log(JSON.stringify({
    turnkeyCore: require("@turnkey/core/package.json").version,
    all256BytesPreserved: true,
    activeSessionSuborganizationUsed: true,
    requestMatchesStampedBody: true,
    policyDenialPropagated: true,
    transport: "mocked; no network requests or real signatures",
    heliusProjectAccessVerified: false,
    userApprovalVerified: false,
    liveRecoveryTested: false,
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
}
