// M2b: subscribe and stop through the wallet, against the local chain, with
// the stand-in wallet (e2e/standin.ts) signing with throwaway keys. Runs
// after read.spec.ts (file order), because it changes the chain.
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { chainFromEnv, installStandin, runCollector, sendCoins, signAndSend } from "./standin";

const c = chainFromEnv();
const supporter = { key: "supporter", address: c.keys.supporter.addr as string };
const stranger = { key: "stranger", address: c.keys.stranger.addr as string };

test.describe.configure({ mode: "serial" });

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
      await page.waitForTimeout(400); // let the colour transitions finish
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${name} ${size}: no sideways scroll`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `e2e/out/shots/${name}-${size}-${scheme}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
}

/** Stops every mandate of the connected wallet that still needs it (the stand-in must be installed). */
async function stopAll(page: import("@playwright/test").Page) {
  await page.goto(`./#/mine?a=${supporter.address}`);
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await expect(page.locator(".mandate").first()).toBeVisible();
  for (;;) {
    const b = page.locator(".stop > button.btn").first();
    if ((await b.count()) === 0) break;
    const name = (await b.innerText()).trim();
    await b.click();
    await page.getByRole("group").getByRole("button", { name }).click();
    await expect(page.getByRole("group")).toHaveCount(0);
  }
}


const errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
});
test.afterEach(() => expect(errors, "no script errors or CSP violations").toEqual([]));

test("without Adena: the plan page says what is needed", async ({ page }) => {
  await page.goto("./#/plan/1");
  await expect(page.getByText(/Subscribing here needs the/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Adena wallet" })).toHaveAttribute("href", "https://adena.app");
});

test("wrong network: one click switches Adena", async ({ page }) => {
  await installStandin(page, c, { ...supporter, chainId: "test5" });
  await page.goto("./#/plan/1");
  await page.getByRole("button", { name: "Connect wallet to subscribe" }).click();
  await expect(page.locator(".allow").getByRole("button", { name: "Switch Adena to dev" })).toBeVisible();
  await shots(page, "wallet-wrong-network");
  await page.locator(".allow").getByRole("button", { name: "Switch Adena to dev" }).click();
  await expect(page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ })).toBeVisible();
});

test("subscribe in two approvals; refuse the second; undo; subscribe again", async ({ page }) => {
  let refuseOnce = true;
  const { calls } = await installStandin(page, c, {
    ...supporter,
    refuse: (msgs) => {
      if (refuseOnce && msgs.some((m: any) => m.value?.func === "Subscribe")) {
        refuseOnce = false;
        return true;
      }
      return false;
    },
  });
  await page.goto("./#/plan/1");
  await page.getByRole("button", { name: "Connect wallet to subscribe" }).click();
  await expect(page.locator(".confirm-sentence")).toContainText("at most 1.1 GNOT every 30 days");
  await shots(page, "subscribe-ready");
  await page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ }).click();
  await expect(page.getByRole("alert")).toContainText("You cancelled this in Adena");
  // the permission exists, the mandate does not: finish or undo
  await expect(page.getByRole("button", { name: "Finish subscribing" })).toBeVisible();
  await shots(page, "subscribe-recovery");
  // what was sent: the exact permission, with explicit gas
  const session = calls[0];
  expect(session.messages).toHaveLength(1);
  expect(session.messages[0].type).toBe("/auth.m_create_session");
  expect(session.messages[0].value.spend_limit).toBe("1100000ugnot");
  expect(session.messages[0].value.spend_period).toBe("2592000");
  expect(session.messages[0].value.allow_paths).toEqual(["vm/exec:" + c.realm]);
  expect(session.gasWanted).toBe(5_000_000);
  expect(session.gasFee).toBeGreaterThanOrEqual(5_000);
  await page.getByRole("button", { name: "Undo: remove the permission" }).click();
  await expect(page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ })).toBeVisible();
  expect(calls[calls.length - 1].messages[0].type).toBe("/auth.m_revoke_session");
  // now all the way
  await page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ }).click();
  await expect(page.getByText(/You support this plan/)).toBeVisible();
  await shots(page, "subscribe-done");
  const sub = calls[calls.length - 1];
  expect(sub.messages[0].value.func).toBe("Subscribe");
  expect(sub.messages[0].value.args[1]).toBe(c.keys.collector.addr);
});

test("the creator's collector takes the first payment; my mandates show it", async ({ page }) => {
  const out = runCollector(c as any);
  expect(out).toContain(`from ${supporter.address}`);
  await installStandin(page, c, supporter);
  await page.goto(`./#/mine?a=${supporter.address}`);
  const card = page.locator(".mandate").first();
  await expect(card.locator(".pill")).toHaveText("Active");
  await expect(card).toContainText("Payments1 · 1 GNOT");
});

test("one plan per creator: a second plan of the same creator is refused before any popup", async ({ page }) => {
  const { calls } = await installStandin(page, c, supporter);
  await page.goto("./#/plan/2");
  await page.getByRole("button", { name: "Connect wallet to subscribe" }).click();
  await expect(page.getByText(/One plan per creator/)).toBeVisible();
  await shots(page, "subscribe-blocked");
  expect(calls).toHaveLength(0);
});

test("one approval for both messages when asked for", async ({ page }) => {
  const { calls } = await installStandin(page, c, stranger);
  await page.goto("./#/plan/1?approval=one");
  await page.getByRole("button", { name: "Connect wallet to subscribe" }).click();
  await page.getByRole("button", { name: /Subscribe for 1 GNOT/ }).click();
  await expect(page.getByText(/You support this plan/)).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls[0].messages.map((m: any) => m.type)).toEqual(["/auth.m_create_session", "/vm.m_call"]);
});

test("stop: remove the permission, then cancel; paid time stays", async ({ page }) => {
  const { calls } = await installStandin(page, c, supporter);
  await page.goto(`./#/mine?a=${supporter.address}`);
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await page.getByRole("button", { name: "Stop this mandate" }).click();
  await expect(page.getByRole("group", { name: "Stop this mandate?" })).toContainText("Time you already paid for stays yours");
  await shots(page, "stop-confirm");
  await page.getByRole("group").getByRole("button", { name: "Stop this mandate" }).click();
  await expect(page.locator(".mandate").first().locator(".pill")).toHaveText("Cancelled");
  expect(calls.map((p: any) => p.messages[0].type)).toEqual(["/auth.m_revoke_session", "/vm.m_call"]);
  expect(calls[1].messages[0].value.func).toBe("Cancel");
});

test("the chain changes after the terms were shown: nothing is sent, the page shows the new state", async ({ browser }) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  const sa = await installStandin(a, c, supporter);
  const sb = await installStandin(b, c, supporter);
  for (const p of [a, b]) {
    await p.goto("./#/plan/1?approval=one");
    await p.getByRole("button", { name: "Connect wallet to subscribe" }).click();
    await expect(p.getByRole("button", { name: /Subscribe for 1 GNOT/ })).toBeVisible();
  }
  await a.getByRole("button", { name: /Subscribe for 1 GNOT/ }).click();
  await expect(a.getByText(/You support this plan/)).toBeVisible();
  await b.getByRole("button", { name: /Subscribe for 1 GNOT/ }).click();
  await expect(b.getByRole("alert")).toContainText("Something changed on chain since this page was read");
  await expect(b.getByText(/You support this plan/)).toBeVisible();
  expect(sa.calls).toHaveLength(1);
  expect(sb.calls).toHaveLength(0);
  await a.close();
  await b.close();
});

test("the chain changes between Adena's check and the block: the transaction fails cleanly and the page says try again", async ({ page }) => {
  let raced = false;
  const { calls } = await installStandin(page, c, {
    ...supporter,
    before: (params) => {
      // the same Subscribe, sent from another tab of this wallet, lands first
      if (!raced && params.messages.some((m: any) => m.value?.func === "Subscribe")) {
        raced = true;
        expect(signAndSend(c, supporter, params).data.deliverTx).toBeUndefined();
      }
    },
  });
  await stopAll(page);
  await page.goto("./#/plan/1");
  await page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ }).click();
  await expect(page.getByRole("alert")).toContainText("The chain refused it: mandate:");
  await expect(page.getByRole("alert")).toContainText("Nothing changed apart from the network fee. Check the page and try again.");
  await shots(page, "subscribe-refused");
  // the page read the chain again and shows the mandate the other tab recorded
  await expect(page.getByText(/You support this plan/)).toBeVisible();
  expect(calls.slice(-2).map((p: any) => p.messages[0].type)).toEqual(["/auth.m_create_session", "/vm.m_call"]);
});

test("the permission disappears before the terms are recorded: the page says the mandate is stopped on chain", async ({ page }) => {
  let permission: any = null;
  await installStandin(page, c, {
    ...supporter,
    before: (params) => {
      if (params.messages[0].value?.func === "Subscribe") {
        const s = permission!;
        const revoke = { messages: [{ type: "/auth.m_revoke_session", value: { creator: s.creator, session_key: s.session_key } }], memo: "", gasWanted: 5_000_000, gasFee: 7_500 };
        expect(signAndSend(c, supporter, revoke).data.deliverTx).toBeUndefined();
      }
      if (params.messages[0].type === "/auth.m_create_session") permission = params.messages[0].value;
    },
  });
  await stopAll(page);
  await page.goto("./#/plan/1");
  await page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ }).click();
  await expect(page.getByText(/Stopped on chain\./)).toBeVisible();
  await shots(page, "subscribe-stopped-on-chain");
  await expect(page.getByText(/You support this plan\. The creator/)).toHaveCount(0);
});

test("a collector key that received coins: nobody new can join, before any popup", async ({ page }) => {
  sendCoins(c, "fluxen", c.keys.collector.addr, "1ugnot");
  const { calls } = await installStandin(page, c, supporter);
  await page.goto("./#/plan/3");
  await page.getByRole("button", { name: "Connect wallet to subscribe" }).click();
  await expect(page.getByText(/New supporters cannot join right now/).first()).toBeVisible();
  expect(calls).toHaveLength(0);
});
