import { test, expect } from "@playwright/test";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { PrismaClient } from "@prisma/client";
const origin = { Origin: "http://localhost:3017" };
const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
const wallet = bs58.encode(keys.publicKey);
test("escrow fails closed and forged admin is rejected", async ({
  request,
}) => {
  expect(
    (
      await request.post("/api/escrow", { data: { signature: "fake" } })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/questions", {
        headers: origin,
        data: { wallet, admin: true },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/auth/challenge", {
        headers: { Origin: "https://evil.example" },
        data: { wallet },
      })
    ).status(),
  ).toBe(403);
});
test("single-use challenge, session binding, expiry and admin draft permissions", async ({
  request,
}) => {
  test.skip(
    !process.env.BROBETS_TEST_DATABASE,
    "Run with isolated test database configuration",
  );
  const db = new PrismaClient();
  try {
    const issue = await request.post("/api/auth/challenge", {
      headers: origin,
      data: { wallet },
    });
    expect(issue.status()).toBe(200);
    const { message } = await issue.json();
    const signature = Buffer.from(
      nacl.sign.detached(new TextEncoder().encode(message), keys.secretKey),
    ).toString("hex");
    const responses = await Promise.all([
      request.post("/api/auth/verify", {
        headers: origin,
        data: { signature },
      }),
      request.post("/api/auth/verify", {
        headers: origin,
        data: { signature },
      }),
    ]);
    expect(responses.map((r) => r.status()).sort()).toEqual([200, 401]);
    expect((await (await request.get("/api/auth/session")).json()).admin).toBe(
      true,
    );
    const draft = {
      title: "Will the home team win?",
      sideA: "Yes",
      sideB: "No",
      closesAt: new Date(Date.now() + 3600000).toISOString(),
      resolveBy: new Date(Date.now() + 7200000).toISOString(),
    };
    const created = await request.post("/api/questions", {
      headers: origin,
      data: draft,
    });
    expect(created.status()).toBe(201);
    const row = await created.json();
    expect(row.chainAddress).toBeNull();
    await db.question.delete({ where: { id: row.id } });
    const invalid = await request.post("/api/questions", {
      headers: origin,
      data: { ...draft, resolveBy: draft.closesAt },
    });
    expect(invalid.status()).toBe(400);
    expect(
      (await request.delete("/api/auth/session", { headers: origin })).status(),
    ).toBe(200);
    expect(
      (
        await request.post("/api/questions", { headers: origin, data: draft })
      ).status(),
    ).toBe(403);
    const expiring = await request.post("/api/auth/challenge", {
      headers: origin,
      data: { wallet },
    });
    const { message: expiredMessage } = await expiring.json();
    const expiredSignature = Buffer.from(
      nacl.sign.detached(
        new TextEncoder().encode(expiredMessage),
        keys.secretKey,
      ),
    ).toString("hex");
    await db.challenge.updateMany({
      where: { message: expiredMessage },
      data: { expiresAt: new Date(0) },
    });
    expect(
      (
        await request.post("/api/auth/verify", {
          headers: origin,
          data: { signature: expiredSignature },
        })
      ).status(),
    ).toBe(401);
  } finally {
    await db.$disconnect();
  }
});
