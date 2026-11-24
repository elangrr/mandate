// M2c: the creator's side through the wallet, against the local chain, with
// the stand-in wallet (e2e/standin.ts) signing with throwaway keys. Runs after
// wallet.spec.ts (file order): by then Fluxen's collector key has received
// coins (blocked) and Fluxen's plans have supporters.
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { chainFromEnv, installStandin, newKey, runCollector, sendCoins, totals } from "./standin";

const c = chainFromEnv();
const stranger = { key: "stranger", address: c.keys.stranger.addr as string };
const fluxen = { key: "fluxen", address: c.keys.fluxen.addr as string };

test.describe.configure({ mode: "serial" });

const errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
});
test.afterEach(() => expect(errors, "no script errors or CSP violations").toEqual([]));

/** Screenshots of the current state at desktop and phone width, light and dark, without reloading it. */
async function shots(page: Page, name: string) {
  mkdirSync("e2e/out/shots", { recursive: true });
  for (const [w, h, size] of [
    [1280, 800, "desktop"],
    [390, 844, "phone"],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${name} ${size}: no sideways scroll`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `e2e/out/shots/${name}-${size}-${scheme}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
}

const keyField = (page: Page) => page.getByLabel(/collector public key/i);

async function openPublish(page: Page) {
  await page.goto("./#/publish");
  await page.getByRole("button", { name: "Connect wallet to publish" }).click();
  await expect(page.getByRole("heading", { name: "Publish a plan" })).toBeVisible();
}

test("publish page without Adena: says what is needed", async ({ page }) => {
  await page.goto("./#/publish");
  await expect(page.getByText(/Publishing here needs the/)).toBeVisible();
  await shots(page, "publish-no-wallet");
});

test("a collector key is checked before any popup: not a key, the creator's own key, an account", async ({ page }) => {
  const { calls } = await installStandin(page, c, stranger);
  await openPublish(page);
  await shots(page, "publish-empty");
  // a recovery phrase, typed: refused and removed from the page
  await keyField(page).fill("abandon ability able about above absent absorb abstract absurd abuse access accident");
  await page.getByRole("button", { name: "Check this key" }).click();
  await expect(page.getByText(/so the page removed it/)).toBeVisible();
  await expect(keyField(page)).toHaveValue("");
  // a private key in hex: the same
  await keyField(page).fill("0x" + "ab".repeat(32));
  await page.getByRole("button", { name: "Check this key" }).click();
  await expect(keyField(page)).toHaveValue("");
  // pasted: never even shown
  await keyField(page).focus();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "abandon,ability,able,about,above,absent,absorb,abstract,absurd,abuse,access,accident");
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(keyField(page)).toHaveValue("");
  await expect(page.getByText(/so the page removed it/)).toBeVisible();
  expect(await page.evaluate(() => document.body.innerText.includes("absurd"))).toBe(false);
  await keyField(page).fill(c.keys.stranger.gpub);
  await page.getByRole("button", { name: "Check this key" }).click();
  await expect(page.getByText(/This is your own wallet’s key/)).toBeVisible();
  // Fluxen's collector key received coins in wallet.spec.ts: its address is an account
  await keyField(page).fill(c.keys.collector.gpub);
  await page.getByRole("button", { name: "Check this key" }).click();
  await expect(page.getByText(/already received coins, so it is an account/)).toBeVisible();
  await expect(page.getByText(c.keys.collector.addr)).toBeVisible(); // the derived address is shown
  await expect(keyField(page)).toHaveAttribute("aria-invalid", "true");
  await shots(page, "publish-key-refused");
  expect(calls).toHaveLength(0);
});

test("publish a collector key: check, see its address, publish; the creator page shows it", async ({ page }) => {
  const k = await newKey(c, "stranger-collector");
  const { calls, options } = await installStandin(page, c, stranger);
  await openPublish(page);
  await keyField(page).fill(k.gpub);
  await page.getByRole("button", { name: "Check this key" }).click();
  await expect(page.locator(".publish-confirm")).toContainText(k.addr);
  await expect(page.locator(".publish-confirm")).toContainText("never received coins");
  await shots(page, "publish-key-checked");
  await page.getByRole("button", { name: "Publish collector key" }).click();
  await expect(page.getByText(/Published: the chain now lists this key/)).toBeVisible({ timeout: 20_000 });
  expect(calls).toHaveLength(1);
  expect(calls[0].messages[0].value).toMatchObject({ func: "SetCollectorKey", args: [k.gpub], caller: stranger.address, send: "" });
  expect(calls[0].commit).toBe(true);
  expect(options[0]).toEqual({ isVisibleResult: false });
  await page.goto(`./#/creator/${stranger.address}`);
  await expect(page.locator(".collector-card")).toContainText(k.addr);
  await expect(page.locator(".collector-card .pill")).toHaveText("Ready");
});

test("plan inputs the realm would refuse are refused on the page, before any popup", async ({ page }) => {
  const { calls } = await installStandin(page, c, stranger);
  await openPublish(page);
  await page.getByLabel("Title").fill("a‮b");
  await page.getByLabel("Price per period, in GNOT").fill("0.05");
  await page.getByLabel("Number of").fill("31");
  await page.getByRole("button", { name: "Publish plan" }).click();
  await expect(page.getByText(/invisible formatting characters/)).toBeVisible();
  await expect(page.getByText(/at least 0.1 GNOT: below that/)).toBeVisible();
  await expect(page.getByText(/at most 30 days/)).toBeVisible();
  await expect(page.getByLabel("Title")).toBeFocused();
  await expect(page.getByLabel("Title")).toHaveAttribute("aria-invalid", "true");
  await shots(page, "publish-plan-errors");
  await page.getByLabel("Title").fill("x".repeat(81));
  await expect(page.getByText(/81 characters long; the most is 80/)).toBeVisible();
  expect(calls).toHaveLength(0);
});

test("publish a plan: preview with the cap, cannot be changed, then it is on the creator page", async ({ page }) => {
  const { calls } = await installStandin(page, c, stranger);
  await openPublish(page);
  await page.getByLabel("Title").fill("Fluxen's sketchbook");
  await page.getByLabel("Price per period, in GNOT").fill("0.5");
  await page.getByLabel("Number of").fill("7");
  const preview = page.locator(".plan-preview");
  await expect(preview).toContainText("Fluxen's sketchbook");
  await expect(preview).toContainText("0.5 GNOT every week");
  await expect(preview).toContainText("at most 0.6 GNOT every week");
  await expect(page.locator(".costs")).toContainText("Once published, a plan’s title, price and period stay as they are");
  await shots(page, "publish-plan-preview");
  await page.getByRole("button", { name: "Publish plan" }).click();
  await expect(page.getByText(/“Fluxen's sketchbook” is published/)).toBeVisible({ timeout: 20_000 });
  expect(calls[0].messages[0].value).toMatchObject({ func: "Offer", args: ["Fluxen's sketchbook", "500000", "604800"], caller: stranger.address, send: "" });
  await page.goto(`./#/creator/${stranger.address}`);
  await expect(page.locator(".table")).toContainText("Fluxen's sketchbook");
  await expect(page.getByRole("link", { name: "Publish a plan or a key" })).toBeVisible(); // own creator page
  await shots(page, "creator-own");
});

test("popup cancelled: the page looks on chain, then says nothing was published", async ({ page }) => {
  const before = await totals(c);
  await installStandin(page, c, { ...stranger, refuse: () => true });
  await openPublish(page);
  await page.getByLabel("Title").fill("Never published");
  await page.getByLabel("Price per period, in GNOT").fill("1");
  await page.getByRole("button", { name: "Publish plan" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "You cancelled “Publish the plan” in Adena, or closed its window" })).toBeVisible({ timeout: 20_000 });
  expect(await totals(c)).toBe(before);
});

test("refused in the block: the new key's address received coins after the page checked it", async ({ page }) => {
  const k = await newKey(c, "stranger-collector-2");
  await installStandin(page, c, {
    ...stranger,
    before: async (params) => {
      if (params.messages[0].value?.func === "SetCollectorKey") await sendCoins(c, "fluxen", k.addr, "1ugnot");
    },
  });
  await openPublish(page);
  await keyField(page).fill(k.gpub);
  await page.getByRole("button", { name: "Check this key" }).click();
  await page.getByRole("button", { name: "Replace collector key" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The chain refused it: mandate: this key's address" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("alert").filter({ hasText: "Check the page and try again" })).toBeVisible();
  // the panel states only what was just read: the key is now an account, and it cannot be published
  await expect(page.getByText(/already received coins, so it is an account/)).toBeVisible();
  await expect(page.getByText(/its address has never received coins/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Replace collector key" })).toHaveCount(0);
  await shots(page, "publish-key-refused-in-block");
});

test("the key's address receives coins between the check and the popup: the fresh read refuses it, nothing is sent", async ({ page }) => {
  const k = await newKey(c, "stranger-collector-3");
  const { calls } = await installStandin(page, c, stranger);
  await openPublish(page);
  await keyField(page).fill(k.gpub);
  await page.getByRole("button", { name: "Check this key" }).click();
  await expect(page.locator(".publish-confirm")).toContainText("never received coins");
  await sendCoins(c, "fluxen", k.addr, "1ugnot");
  await page.getByRole("button", { name: "Replace collector key" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already received coins" }).filter({ hasText: "Nothing was sent" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Replace collector key" })).toHaveCount(0);
  expect(calls).toHaveLength(0);
});

test("a key whose address was emptied again is still an account: refused before any popup", async ({ page }) => {
  const k = await newKey(c, "emptied-collector");
  await sendCoins(c, "fluxen", k.addr, "200000ugnot");
  await sendCoins(c, k.name, fluxen.address, "100000ugnot"); // the other 100000ugnot pays the fee: nothing is left
  const { calls } = await installStandin(page, c, stranger);
  await openPublish(page);
  await keyField(page).fill(k.gpub);
  await page.getByRole("button", { name: "Check this key" }).click();
  await expect(page.getByText(/already received coins, so it is an account \(even if its coins are gone\)/)).toBeVisible();
  expect(calls).toHaveLength(0);
});

test("a plan not on chain yet: the warning survives a reload and clears once the chain shows it", async ({ page }) => {
  test.setTimeout(90_000);
  await installStandin(page, c, { ...stranger, queuedOnly: true, delayMs: 9_000 });
  await openPublish(page);
  await page.getByLabel("Title").fill("Fluxen's slow plan");
  await page.getByLabel("Price per period, in GNOT").fill("1");
  await page.getByRole("button", { name: "Publish plan" }).click();
  const banner = page.locator(".pending");
  await expect(banner).toContainText("Do not approve it again", { timeout: 15_000 });
  await page.reload();
  await expect(banner).toContainText("Publish the plan");
  await page.getByRole("button", { name: "Connect wallet to publish" }).click();
  // while it is pending, neither panel offers another approval
  await expect(page.getByRole("button", { name: "Waiting for the other step…" })).toBeDisabled();
  await expect(page.getByLabel("Title")).toBeDisabled();
  await page.waitForTimeout(6_000);
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(banner).toHaveCount(0, { timeout: 15_000 });
  await page.goto(`./#/creator/${stranger.address}`);
  await expect(page.locator(".table")).toContainText("Fluxen's slow plan");
});

test("replace a blocked key while supporters exist: the old mandates are still collected with the old key", async ({ page }) => {
  test.setTimeout(150_000);
  const k = await newKey(c, "fluxen-collector-2");
  await installStandin(page, c, fluxen);
  await openPublish(page);
  await expect(page.locator(".publish-card").first().locator(".pill")).toHaveText("Blocked");
  await expect(page.getByText(/Replacing it keeps existing supporters on the old key/)).toBeVisible();
  await keyField(page).fill(k.gpub);
  await page.getByRole("button", { name: "Check this key" }).click();
  await expect(page.locator(".publish-confirm")).toContainText("Replace your collector key");
  await page.getByRole("button", { name: "Replace collector key" }).click();
  await expect(page.getByText(/Published: the chain now lists this key/)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".publish-card").first().locator(".pill")).toHaveText("Ready");
  // the one-minute plan's supporters gave their permission to the old key: a run with the old key still takes their payments
  const before = await totals(c);
  await page.waitForTimeout(61_000); // one period of the one-minute plan
  const out = await runCollector(c as any);
  expect(out).toMatch(/done: [1-9]\d* pulled or tried, \d+ refused on the payer's side, 0 failed/);
  expect(await totals(c)).not.toBe(before);
});

test("the collector guide: the exact command for this creator, what it says, what to do when blocked", async ({ page }) => {
  await page.goto(`./#/collector?a=${fluxen.address}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Running the collector");
  const cmd = page.getByLabel("The collector command");
  await expect(cmd).toContainText(`scripts/collect.sh -home ~/mandate-collector -key collector -payee ${fluxen.address} -remote ${process.env.MD_RPC}`);
  await expect(cmd).toContainText(`-chainid dev -realm ${c.realm}`);
  await expect(page.getByText(/\*\/10 \* \* \* \*/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "When the key is blocked" })).toBeVisible();
  await shots(page, "collector-guide");
});

test("320px wide and 200% text: the publish forms, their errors and the guide stay on screen", async ({ page }) => {
  await installStandin(page, c, stranger);
  await page.setViewportSize({ width: 320, height: 700 });
  const wide = async (what: string) => {
    await page.evaluate(() => document.documentElement.style.setProperty("font-size", "200%"));
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const culprits = overflow > 0 ? await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(-10).map((e) => e.tagName + "." + (e.getAttribute("class") ?? "") + " r" + Math.round(e.getBoundingClientRect().right)).join(", ")) : "";
    expect(overflow, `${what} at 320px with 200% text: ${culprits}`).toBeLessThanOrEqual(0);
  };
  await openPublish(page);
  await keyField(page).fill(c.keys.stranger.gpub);
  await page.getByRole("button", { name: "Check this key" }).click();
  await expect(page.getByText(/This is your own wallet’s key/)).toBeVisible();
  await page.getByLabel("Title").fill("x".repeat(81));
  await page.getByLabel("Price per period, in GNOT").fill("1");
  await page.getByRole("button", { name: "Publish plan" }).click();
  await wide("publish with errors");
  await page.goto(`./#/collector?a=${fluxen.address}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await wide("collector guide");
});
