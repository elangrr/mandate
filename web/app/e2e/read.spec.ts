// M2a: the site that only reads, against the local chain seeded by
// e2e/seed.mjs and paid once by the collector (e2e/run-e2e.mjs).
import { expect, test, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";

const chain = JSON.parse(readFileSync(process.env.MD_CHAIN!, "utf8"));
const fluxen: string = chain.keys.fluxen.addr;
const collector: string = chain.keys.collector.addr;
const paid: string = chain.supporters.find((s: { plan: number }) => s.plan === 1).addr;
const stranger: string = chain.keys.stranger.addr;

const errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
});
test.afterEach(() => expect(errors, "no script errors or CSP violations").toEqual([]));

test("home: what it is, the picture, numbers from the chain, paid plans", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Support a creator every month, with a cap you set yourself.");
  await expect(page.getByRole("img", { name: /How a payment moves/ })).toBeVisible();
  const pause = page.getByRole("button", { name: "Pause the picture" });
  await pause.click(); // the looping picture can be stopped (WCAG 2.2.2)
  await expect(page.getByRole("button", { name: "Play the picture" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Mandate in numbers")).toContainText("4plans");
  await expect(page.getByLabel("Mandate in numbers")).toContainText("10payments");
  const list = page.locator(".plan-list");
  await expect(list).toContainText("Support Fluxen's work");
  await expect(list).toContainText("Fluxen's weekly notes");
  await expect(list).not.toContainText("onerror"); // never paid: not on the home page
});

test("plan page: price, counts, what you allow, supporters", async ({ page }) => {
  await page.goto("./#/plan/1");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Support Fluxen's work");
  await expect(page.locator(".plan-price")).toContainText("1 GNOT");
  await expect(page.locator(".plan-price")).toContainText("every 30 days");
  await expect(page.locator(".stats")).toContainText("Payments this period5");
  await expect(page.getByText(/3 mandates recorded but not paid yet/)).toBeVisible();
  await expect(page.locator(".allow-sentence")).toContainText("at most 1.1 GNOT every 30 days");
  await expect(page.locator(".sup-list li")).toHaveCount(5);
  await expect(page.getByRole("button", { name: "Show more supporters" })).toHaveCount(0); // cursor -1: stop
  await expect(page.getByRole("link", { name: /open plan #1 on gnoweb/ })).toHaveAttribute("href", /:plan\/1$/);
});

test("a stranger's plan title is shown as text, never as HTML or a link", async ({ page }) => {
  await page.goto("./#/plan/4");
  const h1 = page.getByRole("heading", { level: 1 });
  await expect(h1).toHaveText('Fluxen <img src=x onerror="window.__xss=1"> **b** [a](https://x.example)');
  await expect(h1.locator("img, a, b, strong")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
});

test("my mandates: the realm's view and the chain's, by address", async ({ page }) => {
  await page.goto(`./#/mine?a=${paid}`);
  const card = page.locator(".mandate").first();
  await expect(card).toContainText("Support Fluxen's work");
  await expect(card.locator(".pill")).toHaveText("Active");
  await expect(card).toContainText("Paid through");
  await expect(page.getByText(/1 active mandate of the 16/)).toBeVisible();
  // a wrong address is refused at the field
  await page.getByLabel("Wallet address").fill("g1notanaddress");
  await page.getByRole("button", { name: "Show mandates" }).click();
  await expect(page.getByText(/That is not a gno.land address/)).toBeVisible();
  await expect(page.getByLabel("Wallet address")).toHaveAttribute("aria-invalid", "true");
  // a wallet with no mandates
  await page.goto(`./#/mine?a=${stranger}`);
  await expect(page.getByText(/No mandates from/)).toBeVisible();
});

test("creator page: plans, counts and the collector key", async ({ page }) => {
  await page.goto(`./#/creator/${fluxen}`);
  await expect(page.locator(".stats")).toContainText("Plans4");
  const rows = page.locator(".table tbody tr");
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: "Support Fluxen's work" })).toContainText("5 / 0");
  await expect(page.getByText(collector)).toBeVisible();
  await expect(page.getByText(/must never receive coins/)).toBeVisible();
});

test("while the realm waits for approval: a calm state, no errors", async ({ page }) => {
  await page.route(process.env.MD_RPC!, async (route) => {
    const body = route.request().postDataJSON();
    if (body?.method === "abci_query" && body.params?.path === "vm/qpkgmeta_json") {
      const data = Buffer.from(JSON.stringify({ path: "x", status: "inert", reason: "waiting for a package approver to enable it", pending: true })).toString("base64");
      return route.fulfill({ json: { jsonrpc: "2.0", id: body.id, result: { response: { ResponseBase: { Data: data, Error: null, Log: "" } } } } });
    }
    return route.continue();
  });
  for (const path of ["./", "./#/plan/1", `./#/mine?a=${paid}`]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Deployed, waiting for the network’s approval" })).toBeVisible();
  }
  await expect(page.getByRole("link", { name: /approval status/ })).toBeVisible();
  await page.goto("./#/how");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("How Mandate works");
});

test("keyboard: skip link first, focus lands on the new page", async ({ page }) => {
  await page.goto("./");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.getByRole("link", { name: "How it works" }).first().click();
  await expect(page.locator("#main")).toBeFocused();
  await expect(page).toHaveTitle("How it works · Mandate");
});

test("the built page carries a strict Content-Security-Policy", async ({ page }) => {
  await page.goto("./");
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain("unsafe");
});

// Screenshots of every page, desktop and phone, light and dark.
const shots: [string, string][] = [
  ["home", "./"],
  ["plans", "./#/plans"],
  ["plan", "./#/plan/1"],
  ["mine", `./#/mine?a=${paid}`],
  ["creator", `./#/creator/${fluxen}`],
  ["how", "./#/how"],
];
for (const [w, h, size] of [
  [1280, 800, "desktop"],
  [390, 844, "phone"],
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`screenshots ${size} ${scheme}`, async ({ page }) => {
      mkdirSync("e2e/out/shots", { recursive: true });
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      for (const [name, url] of shots) {
        await page.goto(url);
        await waitReady(page);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${name} ${size}: no sideways scroll`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: `e2e/out/shots/${name}-${size}-${scheme}.png`, fullPage: true });
      }
    });
  }
}

async function waitReady(page: Page) {
  await expect(page.locator(".loading")).toHaveCount(0, { timeout: 15_000 });
}

test("320px wide and 200% text: nothing clipped sideways", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  for (const [name, url] of shots) {
    await page.goto(url);
    await waitReady(page);
    await page.evaluate(() => document.documentElement.style.setProperty("font-size", "200%")); // CSSOM, allowed by the CSP
    await page.waitForTimeout(100);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const wide = overflow > 0 ? await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth || e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === "visible").slice(0, 12).map((e) => e.tagName + "." + (e.getAttribute("class") ?? "") + " r" + Math.round(e.getBoundingClientRect().right) + " sw" + e.scrollWidth + "/" + e.clientWidth)) : [];
    expect(overflow, `${name} at 320px with 200% text (${overflow}px): ${wide.join(", ")}`).toBeLessThanOrEqual(0);
  }
});
