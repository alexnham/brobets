import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import nacl from "tweetnacl";
import bs58 from "bs58";

const origin = { Origin: "http://localhost:3017" };

async function signIn(request: APIRequestContext, keys: nacl.SignKeyPair) {
  const challenge = await request.post("/api/auth/challenge", {
    headers: origin,
    data: { wallet: bs58.encode(keys.publicKey) },
  });
  expect(challenge.status()).toBe(200);
  const { message } = await challenge.json();
  const signature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), keys.secretKey)).toString("hex");
  expect((await request.post("/api/auth/verify", { headers: origin, data: { signature } })).status()).toBe(200);
}

test("durable, exact, wallet-private purchase drafts with concurrent retry protection", async ({ request, playwright }) => {
  test.skip(!process.env.BROBETS_TEST_DATABASE, "Requires a dedicated disposable PostgreSQL database");
  const db = new PrismaClient();
  const owner = nacl.sign.keyPair();
  const other = nacl.sign.keyPair();
  const wallets = [owner, other].map((keys) => bs58.encode(keys.publicKey));
  const stranger = await playwright.request.newContext({ baseURL: "http://localhost:3017" });
  try {
    expect((await request.get("/api/purchases")).status()).toBe(401);
    expect((await request.post("/api/purchases", { headers: origin, data: {} })).status()).toBe(401);
    expect((await request.post("/api/purchases", { headers: { Origin: "https://evil.example" }, data: {} })).status()).toBe(403);
    await signIn(request, owner);
    const requestId = randomUUID();
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => request.post("/api/purchases", {
      headers: origin, data: { quantity: "10", requestId: index % 2 ? requestId.toUpperCase() : requestId },
    })));
    expect(responses.filter((r) => r.status() === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status() === 200)).toHaveLength(7);
    const drafts = await Promise.all(responses.map((r) => r.json()));
    expect(new Set(drafts.map((d) => d.id)).size).toBe(1);
    const draft = drafts[0];
    expect(draft).toMatchObject({ status: "DRAFT", cluster: "devnet", paymentEnabled: false, decimals: 6,
      quote: { bbUnits: "10000000", backingUnits: "10000000", premiumUnits: "1000000", totalUnits: "11000000" } });
    expect(draft).not.toHaveProperty("wallet");
    expect(draft).not.toHaveProperty("paymentAddress");
    expect(await db.purchaseDraft.count({ where: { wallet: wallets[0], requestId } })).toBe(1);
    const replay = await request.post("/api/purchases", { headers: origin, data: { quantity: "10.000000", requestId } });
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual(draft);
    expect((await request.post("/api/purchases", { headers: origin, data: { quantity: "11", requestId } })).status()).toBe(409);

    for (const quantity of ["0", "-1", "1e3", "1.0000001", "9223372036854.775808"]) {
      expect((await request.post("/api/purchases", { headers: origin, data: { quantity, requestId: randomUUID() } })).status()).toBe(400);
    }
    expect((await request.post("/api/purchases", { headers: origin,
      data: { quantity: "1", requestId: randomUUID(), status: "SETTLED", wallet: wallets[1] } })).status()).toBe(400);
    for (const [quantity, totalUnits] of [["0.000001", "2"], ["9223372036854.775807", "10145709240540253388"]]) {
      const quote = await request.post("/api/purchases", { headers: origin, data: { quantity, requestId: randomUUID() } });
      expect(quote.status()).toBe(201);
      expect((await quote.json()).quote.totalUnits).toBe(totalUnits);
    }
    expect((await request.patch(`/api/purchases/${draft.id}`, { headers: origin, data: { status: "SETTLED" } })).status()).toBe(405);

    await signIn(stranger, other);
    expect((await stranger.get(`/api/purchases/${draft.id}`)).status()).toBe(404);
    expect((await stranger.get(`/api/purchases?cursor=${draft.id}`)).status()).toBe(404);
    expect((await (await stranger.get("/api/purchases")).json()).items).toEqual([]);
    const independent = await stranger.post("/api/purchases", { headers: origin, data: { quantity: "1", requestId } });
    expect(independent.status()).toBe(201);
    expect((await independent.json()).id).not.toBe(draft.id);

    expect((await request.delete("/api/auth/session", { headers: origin })).status()).toBe(200);
    expect((await request.get(`/api/purchases/${draft.id}`)).status()).toBe(401);
    await signIn(request, owner);
    const restored = await request.get(`/api/purchases/${draft.id}`);
    expect(restored.status()).toBe(200);
    expect(restored.headers()["cache-control"]).toContain("no-store");
    expect(await restored.json()).toEqual(draft);
    // Exercise pagination with more than one full page of persisted drafts.
    await db.purchaseDraft.createMany({ data: Array.from({ length: 50 }, () => ({
      wallet: wallets[0], requestId: randomUUID(), mint: draft.mint,
      quantity: "1", backing: "1", premium: "1", total: "2",
    })) });
    const page = await (await request.get("/api/purchases")).json();
    expect(page.items).toHaveLength(50);
    const next = await (await request.get(`/api/purchases?cursor=${page.nextCursor}`)).json();
    expect(next.items).toHaveLength(3);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...page.items, ...next.items].map((d) => d.id)).size).toBe(53);
  } finally {
    await db.purchaseDraft.deleteMany({ where: { wallet: { in: wallets } } });
    await db.session.deleteMany({ where: { wallet: { in: wallets } } });
    await db.challenge.deleteMany({ where: { wallet: { in: wallets } } });
    await stranger.dispose();
    await db.$disconnect();
  }
});
