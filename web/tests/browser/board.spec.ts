import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const admin = "ERsc4ugZCfht4joqXWgVqtb222KUorwTuoD4Nc17wsB8";
function question(id: string, sideA: string, sideB: string, closed = false) {
  return {
    id,
    title: `Who wins: ${sideA} or ${sideB}?`,
    sideA,
    sideB,
    closesAt: new Date(Date.now() + (closed ? -1 : 1) * 3600000).toISOString(),
    resolveBy: new Date(Date.now() + 7200000).toISOString(),
    matchup: `${sideA} / ${sideB}`,
    category: "Game winner",
    ...(closed ? { result: "a" } : {}),
  };
}
async function market(
  page: Page,
  questions: ReturnType<typeof question>[] = [],
  ready = true,
) {
  await page.route("**/api/market", (route) =>
    route.fulfill({ json: { ready, admin, questions, wagers: [] } }),
  );
}
test("empty chain state stays empty and never restores browser samples", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "brobets-demo-v1",
      JSON.stringify({
        questions: [{ id: "old-sample", title: "Old stored sample" }],
        wagers: [],
      }),
    ),
  );
  await market(page);
  await page.goto("/");
  await expect(
    page.getByText("No basketball questions have been published yet."),
  ).toBeVisible();
  await expect(page.locator(".game-card")).toHaveCount(0);
  await expect(page.getByText("Old stored sample")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create question" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Try admin view" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reset demo" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Brobets balance/ }),
  ).toBeVisible();
});
test("board reads server questions, filters teams and opens shareable details", async ({
  page,
}) => {
  await market(page, [
    question("lakers-warriors", "Lakers", "Warriors"),
    question("celtics-knicks", "Celtics", "Knicks", true),
  ]);
  await page.goto("/");
  await expect(page.locator(".game-card")).toHaveCount(2);
  await page.getByRole("textbox", { name: "Search games" }).fill("Lakers");
  await expect(page.locator(".game-card")).toHaveCount(1);
  await page.locator(".game-card").click();
  await expect(page).toHaveURL("/questions/lakers-warriors");
  await expect(
    page.getByRole("button", { name: "Simulate and review proposal" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(page).toHaveURL("/");
  await page.getByRole("textbox", { name: "Search games" }).fill("");
  await page.getByRole("button", { name: "Settled", exact: true }).click();
  await expect(page.locator(".game-card")).toHaveCount(1);
});
test("funding requires a real wallet and never produces a synthetic confirmation", async ({
  page,
}) => {
  await market(page, [question("lakers-warriors", "Lakers", "Warriors")]);
  await page.goto("/questions/lakers-warriors");
  await page
    .getByRole("button", { name: "Simulate and review proposal" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Wallet setup needed" }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Review your play" }),
  ).toHaveCount(0);
  await expect(page.getByText(/Confirmed ·/)).toHaveCount(0);
});
test("closed questions hide proposals and signed-out accounts have no wagers", async ({
  page,
}) => {
  await market(page, [question("celtics-knicks", "Celtics", "Knicks", true)]);
  await page.goto("/questions/celtics-knicks");
  await expect(
    page.getByRole("button", { name: "Simulate and review proposal" }),
  ).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Put up a proposal" })).toHaveCount(0);
  await expect(page.getByText("Your stake in vault tokens")).toHaveCount(0);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "My bets", exact: true }).click();
  await expect(
    page.getByText("Sign in with email to view your wagers."),
  ).toBeVisible();
});
test("missing deployment and RPC errors cannot populate the board", async ({
  page,
}) => {
  await market(page, [], false);
  await page.goto("/");
  await expect(
    page.getByText(
      "Matching setup is required before questions can be published.",
    ),
  ).toBeVisible();
  await page.unroute("**/api/market");
  await page.route("**/api/market", (route) =>
    route.fulfill({ status: 503, json: { error: "RPC unavailable" } }),
  );
  await page.getByRole("button", { name: "Refresh board" }).click();
  await expect(
    page.getByText("RPC unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".game-card")).toHaveCount(0);
});
test("keyboard focus, mobile overflow and accessibility", async ({ page }) => {
  await market(page, [question("lakers-warriors", "Lakers", "Warriors")]);
  await page.goto("/");
  await expect(page.locator(".game-card")).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.locator(".game-card").click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".game-card")).toBeFocused();
});

test("unresolved questions past betting close hide the proposal form", async ({ page }) => {
  const closed = { ...question("closed-game", "Lakers", "Warriors", true), result: undefined };
  await market(page, [closed]);
  await page.goto("/questions/closed-game");
  await expect(page.getByText("Betting is closed. No new proposals can be posted.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Put up a proposal" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Simulate and review proposal" })).toHaveCount(0);
  await expect(page.getByText("No open proposals.", { exact: true })).toBeVisible();
});
