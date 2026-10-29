import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test("board, search, exact matching and recovery after reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Big takes. Back yours." }),
  ).toBeVisible();
  await expect(
    page.getByText("Sample games and simulated wagers.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Search games" }).fill("Lakers");
  await expect(page.locator(".game-card")).toHaveCount(1);
  await page.locator(".game-card").click();
  await page
    .getByRole("button", { name: "Match", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("dialog", { name: "Review your play" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm demo action" }).click();
  await expect(
    page.getByText("Confirmed · demo only, no funds moved."),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Review your play" })
    .getByRole("button", { name: "Close dialog" })
    .click();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.reload();
  await page.getByRole("button", { name: "My bets", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Lakers · $5" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("proposal validation, rejection, cancellation and claim", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".game-card").first().click();
  await page
    .getByRole("textbox", { name: "Your stake in vault tokens" })
    .fill("0.0000001");
  await page.getByRole("button", { name: "Review demo proposal" }).click();
  await expect(
    page.getByRole("dialog", { name: "Review your play" }),
  ).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Your stake in vault tokens" })
    .fill("5.123456");
  await page.getByRole("button", { name: "Review demo proposal" }).click();
  await page.getByRole("button", { name: "Reject action" }).click();
  await expect(
    page.getByText("Rejected · action cancelled. No funds moved."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm demo action" }).click();
  await expect(
    page.getByText("Confirmed · demo only, no funds moved."),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Review your play" })
    .getByRole("button", { name: "Close dialog" })
    .click();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "My bets", exact: true }).click();
  await page
    .locator(".wager-row")
    .filter({ hasText: "Lakers · $5.123456" })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm demo action" }).click();
  await expect(
    page.getByText("Confirmed · demo only, no funds moved."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page
    .locator(".wager-row")
    .filter({ hasText: "Nuggets · $10" })
    .getByRole("button", { name: "Claim", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm demo action" }).click();
  await expect(
    page.getByText("Confirmed · demo only, no funds moved."),
  ).toBeVisible();
});
test("demo admin cannot bypass deadlines and wallet setup is clear", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Try admin view" }).click();
  await page.getByRole("button", { name: "Create question" }).click();
  await page
    .getByRole("textbox", { name: "Basketball question" })
    .fill("Who wins this demo game?");
  await page.getByRole("textbox", { name: "Outcome A" }).fill("Team A");
  await page.getByRole("textbox", { name: "Outcome B" }).fill("Team B");
  await page.getByLabel("Betting closes").fill("2030-01-01T12:00");
  await page.getByLabel("Resolve by").fill("2030-01-02T12:00");
  await page.getByRole("button", { name: "Publish demo question" }).click();
  await expect(page.locator(".game-card")).toHaveCount(5);
  await page.locator(".game-card").first().click();
  await expect(
    page.getByRole("button", { name: "Lakers wins", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(
    page.getByRole("heading", { name: "Wallet setup needed" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Buy tokens", exact: true }),
  ).toBeDisabled();
});
test("keyboard dialogs, responsive layout and accessibility", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".game-card")).toHaveCount(4);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
  await page.locator(".game-card").first().click();
  const dialogResults = await new AxeBuilder({ page }).analyze();
  expect(dialogResults.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".game-card").first()).toBeFocused();
});
