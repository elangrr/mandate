// M2b: subscribe and stop through the wallet, against the local chain, with
// the stand-in wallet (e2e/standin.ts) signing with throwaway keys. Runs
// after read.spec.ts (file order), because it changes the chain.
import { createECDH } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { chainFromEnv, installStandin, runCollector, sendCoins, sendDirect, sessionKeys } from "./standin";

const c = chainFromEnv();
const supporter = { key: "supporter", address: c.keys.supporter.addr as string };
const stranger = { key: "stranger", address: c.keys.stranger.addr as string };
const fluxen = { key: "fluxen", address: c.keys.fluxen.addr as string };

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
async function stopAll(page: Page) {
  await page.goto(`./#/mine?a=${supporter.address}`);
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await expect(page.locator(".mandate").first()).toBeVisible();
  for (let i = 0; i < 20; i++) {
    await expect(page.locator(".loading")).toHaveCount(0);
    const b = page.locator(".stop > button.btn:not([disabled])").first();
    if ((await b.count()) === 0) break;
    const name = await b.innerText({ timeout: 2_000 }).catch(() => null);
    if (!name) continue; // the list re-rendered under us: look again
    if (!(await b.click({ timeout: 5_000 }).then(() => true, () => false))) continue; // detached while clicking: look again
    await page.getByRole("group").getByRole("button", { name: name.trim() }).click();
    await expect(page.getByRole("group")).toHaveCount(0, { timeout: 30_000 });
  }
  // the retries above must not hide a page that keeps re-rendering its buttons: nothing is left to stop
  await expect(page.locator(".loading")).toHaveCount(0);
  await expect(page.locator(".stop > button.btn:not([disabled])")).toHaveCount(0);
}

/** Permission messages for n fresh random keys (the wallet's own, for the 16-permission test). */
function randomPermissions(n: number, creator: string, kind: "create" | "revoke", keys?: string[]) {
  const pubs = keys ?? Array.from({ length: n }, () => {
    const e = createECDH("secp256k1");
    e.generateKeys();
    return e.getPublicKey("base64", "compressed");
  });
  const any = (pub: string) => ({ type_url: "/tm.PubKeySecp256k1", value: Buffer.concat([Buffer.from([0x0a, 0x21]), Buffer.from(pub, "base64")]).toString("base64") });
  const messages = pubs.map((pub) =>
    kind === "create"
      ? { type: "/auth.m_create_session", value: { creator, session_key: any(pub), expires_at: String(Math.floor(Date.now() / 1000) + 86400 * 30), allow_paths: ["vm/exec:" + c.realm], spend_limit: "1ugnot", spend_period: "60" } }
      : { type: "/auth.m_revoke_session", value: { creator, session_key: any(pub) } },
  );
  return { pubs, params: { messages, memo: "", gasWanted: 60_000_000, gasFee: 100_000 } };
}

const isSubscribe = (p: any) => p.messages.some((m: any) => m.value?.func === "Subscribe");
const isCreate = (p: any) => p.messages.some((m: any) => m.type === "/auth.m_create_session");
const isRevoke = (p: any) => p.messages.some((m: any) => m.type === "/auth.m_revoke_session");

test("without Adena: the plan page says what is needed", async ({ page }) => {
  await page.goto("./#/plan/1");
  await expect(page.getByText(/Subscribing here needs the/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Adena wallet" })).toHaveAttribute("href", "https://adena.app");
  await shots(page, "wallet-missing");
});

test("a creator opening their own plan is told so, and nothing can be signed", async ({ page }) => {
  const { calls } = await installStandin(page, c, fluxen);
  await page.goto("./#/plan/1");
  await page.getByRole("button", { name: "Connect wallet to subscribe" }).click();
  await expect(page.getByText(/This is your own plan\./)).toBeVisible();
  await expect(page.getByText(/Mandate does not let a creator subscribe to their own plan, so there is nothing to sign here/)).toBeVisible();
  await expect(page.locator(".allow .btn-primary")).toHaveCount(0);
  await expect(page.getByText("Ready to sign")).toHaveCount(0);
  expect(calls).toHaveLength(0);
  expect(await sessionKeys(c, fluxen.address)).not.toContain(c.keys.collector.addr);
});

test("leaving the page during approval 1: approval 2 never opens; the step already sent is still watched", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const { calls } = await installStandin(page, c, {
    ...supporter,
    before: async (p) => {
      if (isCreate(p)) await gate;
    },
  });
  await page.goto("./#/plan/1");
  await page.getByRole("button", { name: "Connect wallet to subscribe" }).click();
  await page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ }).click();
  await expect(page.locator(".step-wallet")).toBeVisible();
  // the person goes to another page while Adena still shows approval 1, then approves it
  await page.evaluate(() => {
    window.location.hash = "#/how";
  });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("How Mandate works");
  release();
  await expect.poll(() => sessionKeys(c, supporter.address), { timeout: 20_000 }).toContain(c.keys.collector.addr);
  await page.waitForTimeout(5_000); // as long as the page would take to read it back and open approval 2
  expect(calls).toHaveLength(1);
  expect(calls[0].messages[0].type).toBe("/auth.m_create_session");
  await expect(page.locator(".pending")).toHaveCount(0); // it reached the chain: nothing left to warn about
  // back on the plan page: the half-finished subscription is offered to finish or undo; undo it for the next tests
  await page.evaluate(() => {
    window.location.hash = "#/plan/1";
  });
  await page.getByRole("button", { name: "Undo: remove the permission" }).click();
  await expect(page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ })).toBeVisible({ timeout: 20_000 });
  expect(await sessionKeys(c, supporter.address)).not.toContain(c.keys.collector.addr);
});

test("locked wallet: the header shows a clear alert", async ({ page }) => {
  await page.addInitScript(() => {
    const locked = async () => ({ code: 4000, status: "failure", type: "WALLET_LOCKED", message: "Wallet is locked", data: {} });
    (window as any).adena = { AddEstablish: locked, GetAccount: locked, DoContract: locked, SwitchNetwork: locked, AddNetwork: locked };
  });
  await page.goto("./#/plan/1");
  await page.getByRole("button", { name: "Connect wallet to subscribe" }).click();
  await expect(page.getByRole("alert")).toContainText("Adena is locked");
  await shots(page, "wallet-locked");
});

test("subscribe in progress: approval 1 of 2 is clearly marked while waiting in Adena", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await installStandin(page, c, {
    ...supporter,
    skipSend: true,
    before: async () => {
      await gate;
    },
  });
  await page.goto("./#/plan/1");
  await page.getByRole("button", { name: "Connect wallet to subscribe" }).click();
  await expect(page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ })).toBeVisible();
  await page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ }).click();
  await expect(page.locator(".step-wallet")).toBeVisible();
  await shots(page, "subscribe-in-progress");
  release();
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

test("subscribe in two approvals; cancel the second; undo; subscribe again", async ({ page }) => {
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
  await expect(page.locator(".confirm-list")).toContainText("is due as soon as the terms are recorded");
  await shots(page, "subscribe-ready");
  await page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ }).click();
  // the second approval was cancelled after the first went through: say so, not "nothing was sent"
  // the page first looks on chain for up to 10 s (Adena says "cancelled" also when its window was closed after sending)
  await expect(page.getByRole("alert")).toContainText("You cancelled “Record the terms in Mandate (approval 2 of 2)” in Adena, or closed its window", { timeout: 20_000 });
  await expect(page.getByRole("alert")).toContainText("What went through before stays on chain: “Give the permission (approval 1 of 2)”");
  await expect(page.getByRole("button", { name: "Finish subscribing" })).toBeVisible();
  await shots(page, "subscribe-recovery");
  // what was sent: the exact permission, with explicit gas, waiting for the block
  const session = calls[0];
  expect(session.messages).toHaveLength(1);
  expect(session.messages[0].type).toBe("/auth.m_create_session");
  expect(session.messages[0].value.spend_limit).toBe("1100000ugnot");
  expect(session.messages[0].value.spend_period).toBe("2592000");
  expect(session.messages[0].value.allow_paths).toEqual(["vm/exec:" + c.realm]);
  expect(session.gasWanted).toBe(5_000_000);
  expect(session.gasFee).toBeGreaterThanOrEqual(5_000);
  expect(calls.every((p: any) => p.commit === true)).toBe(true);
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
  // the end date signed is the one the page showed
  expect(sub.messages[0].value.args[2]).toBe(calls[calls.length - 2].messages[0].value.expires_at);
});

test("the creator's collector takes the first payment; my mandates show it", async ({ page }) => {
  const out = await runCollector(c);
  expect(out).toContain(`from ${supporter.address}`);
  await installStandin(page, c, supporter);
  await page.goto(`./#/mine?a=${supporter.address}`);
  const card = page.locator(".mandate").first();
  await expect(card.locator(".pill")).toHaveText("Active");
  await expect(card).toContainText("Payment1 · 1 GNOT");
  // not connected: the page cannot know this is the visitor's wallet, so it never says "My"
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Mandates of g1/);
  await expect(page).toHaveTitle(/^Mandates of g1.+ · Mandate$/);
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("My mandates");
  await expect(page).toHaveTitle("My mandates · Mandate");
});

test("one plan per creator: a second plan of the same creator is refused before any popup", async ({ page }) => {
  const { calls } = await installStandin(page, c, supporter);
  await page.goto("./#/plan/2");
  await page.getByRole("button", { name: "Connect wallet to subscribe" }).click();
  await expect(page.getByText(/One plan per creator/)).toBeVisible();
  await shots(page, "subscribe-blocked");
  expect(calls).toHaveLength(0);
});

test("one approval for both messages when asked for (experimental)", async ({ page }) => {
  const { calls } = await installStandin(page, c, stranger);
  await page.goto("./#/plan/1?approval=one");
  await page.getByRole("button", { name: "Connect wallet to subscribe" }).click();
  await expect(page.locator(".confirm-list")).toContainText("experimental");
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

test("a wallet that answers before the block: the second approval opens only once the first is on chain", async ({ page }) => {
  let permissionWasOnChain: boolean | null = null;
  const { calls } = await installStandin(page, c, {
    ...supporter,
    queuedOnly: true,
    delayMs: 1500,
    before: async (p) => {
      if (isSubscribe(p)) permissionWasOnChain = (await sessionKeys(c, supporter.address)).includes(c.keys.collector.addr);
    },
  });
  await page.goto("./#/plan/1");
  await page.getByRole("button", { name: "Connect wallet to subscribe" }).click();
  await page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ }).click();
  await expect(page.getByText(/You support this plan/)).toBeVisible({ timeout: 20_000 });
  expect(permissionWasOnChain).toBe(true);
  expect(calls).toHaveLength(2);
});

test("a slow block: the page says it is sent but not on chain yet, and goes on once it is", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const tidy = await browser.newPage();
  await installStandin(tidy, c, supporter);
  await stopAll(tidy);
  await tidy.close();
  await installStandin(page, c, { ...supporter, queuedOnly: true, delayMs: 8_000 });
  await page.goto("./#/plan/1");
  await page.getByRole("button", { name: "Connect wallet to subscribe" }).click();
  await page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ }).click();
  // the stand-in's queued reply carries no hash (real Adena's does), so the page says it does not know whether it was sent
  const pending = page.locator(".pending");
  await expect(pending).toContainText("Adena did not say whether this was sent", { timeout: 15_000 });
  await expect(pending).toContainText("Do not approve it again");
  await expect(page.locator(".confirm .btn-primary")).toBeDisabled();
  await shots(page, "subscribe-pending");
  await page.waitForTimeout(6_000); // the block lands
  await page.getByRole("button", { name: "Check again" }).click();
  // the permission is on chain now; the second approval is offered from a fresh read, not sent on its own
  await expect(page.getByRole("button", { name: "Finish subscribing" })).toBeEnabled({ timeout: 20_000 });
  await page.getByRole("button", { name: "Finish subscribing" }).click();
  const supported = page.getByText(/You support this plan/);
  await expect(supported.or(page.getByRole("button", { name: "Check again" }))).toBeVisible({ timeout: 20_000 });
  if (!(await supported.isVisible())) {
    await page.waitForTimeout(6_000);
    await page.getByRole("button", { name: "Check again" }).click();
  }
  await expect(supported).toBeVisible({ timeout: 20_000 });
});

test("odd wallet replies: never read as success; the page reads the chain", async ({ page }) => {
  // the transaction went out, but the reply is not of a shape the page knows
  await installStandin(page, c, { ...supporter, mangle: () => ({ status: "success", data: null }) });
  await stopAll(page);
  await expect(page.locator(".mandate").first().locator(".pill")).toHaveText("Cancelled");
});

test("odd wallet replies: nothing reached the chain, the page says so and shows the options again", async ({ page }) => {
  const { calls } = await installStandin(page, c, { ...supporter, skipSend: true, mangle: () => ({ status: "failure", type: "TRANSACTION_FAILED", data: { hash: 7 } }) });
  await page.goto("./#/plan/1");
  await page.getByRole("button", { name: "Connect wallet to subscribe" }).click();
  await page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ }).click();
  await expect(page.locator(".pending")).toContainText("Adena did not say whether this was sent", { timeout: 15_000 });
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByText(/Still not there/)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Show the options again" }).click();
  await expect(page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ })).toBeEnabled();
  expect(calls).toHaveLength(1);
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

test("refused in the block: the same Subscribe from another tab lands first; the page says try again", async ({ page }) => {
  let raced = false;
  const { calls } = await installStandin(page, c, {
    ...supporter,
    before: async (params) => {
      if (!raced && isSubscribe(params)) {
        raced = true;
        expect(await sendDirect(c, supporter, params)).toBe(true);
      }
    },
  });
  await stopAll(page);
  await page.goto("./#/plan/1");
  await page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ }).click();
  await expect(page.getByRole("alert")).toContainText("The chain refused it: mandate:");
  await expect(page.getByRole("alert")).toContainText("Check the page and try again.");
  await shots(page, "subscribe-refused");
  await expect(page.getByText(/You support this plan/)).toBeVisible();
  expect(calls.slice(-2).map((p: any) => p.messages[0].type)).toEqual(["/auth.m_create_session", "/vm.m_call"]);
});

test("a revoke refused in the block: another tab removed the permission first; the page shows what is left", async ({ page }) => {
  await installStandin(page, c, {
    ...supporter,
    before: async (params) => {
      if (isRevoke(params)) expect(await sendDirect(c, supporter, params)).toBe(true);
    },
  });
  await page.goto(`./#/mine?a=${supporter.address}`);
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await page.getByRole("button", { name: "Stop this mandate" }).click();
  await page.getByRole("group").getByRole("button", { name: "Stop this mandate" }).click();
  await expect(page.getByRole("alert").first()).toContainText("that permission is not on chain any more");
  // the cancel was not sent after the refusal; the page offers it now
  await expect(page.getByRole("button", { name: "Cancel it in Mandate" })).toBeVisible();
});

test("the permission disappears before the terms are recorded: the page says the mandate is stopped on chain", async ({ page }) => {
  let permission: any = null;
  await installStandin(page, c, {
    ...supporter,
    before: async (params) => {
      if (isCreate(params)) permission = params.messages[0].value;
      if (isSubscribe(params) && permission) {
        const revoke = { messages: [{ type: "/auth.m_revoke_session", value: { creator: permission.creator, session_key: permission.session_key } }], memo: "", gasWanted: 5_000_000, gasFee: 7_500 };
        expect(await sendDirect(c, supporter, revoke)).toBe(true);
      }
    },
  });
  await stopAll(page);
  await page.goto("./#/plan/1");
  await page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ }).click();
  await expect(page.getByText(/Stopped on chain\./)).toBeVisible();
  await shots(page, "subscribe-stopped-on-chain");
  await expect(page.getByText(/You support this plan\. The/)).toHaveCount(0);
});

test("Adena's window closed after the block: Adena says cancelled, the chain shows it, the page goes on", async ({ page }) => {
  let n = 0;
  const { options } = await installStandin(page, c, {
    ...supporter,
    // only the first approval (the permission) has its window closed
    get closeWindow() {
      return n === 1 ? ("after-block" as const) : undefined; // before() has counted this call already
    },
    before: () => {
      n++;
    },
  } as any);
  await stopAll(page);
  n = 0;
  await page.goto("./#/plan/1");
  await page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ }).click();
  await expect(page.getByText(/You support this plan/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(options.length).toBeGreaterThan(0);
  expect(options.every((o: any) => o?.isVisibleResult === false)).toBe(true);
});

test("Adena's window closed before the block: the page waits for the chain before saying anything", async ({ page }) => {
  await installStandin(page, c, { ...supporter, closeWindow: "before-block", delayMs: 2_000 });
  await page.goto(`./#/mine?a=${supporter.address}`);
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  // stop: the revoke goes out though Adena says cancelled; the page sees it on chain and goes on to the cancel (also closed early)
  await page.getByRole("button", { name: "Stop this mandate" }).click();
  await page.getByRole("group").getByRole("button", { name: "Stop this mandate" }).click();
  await expect(page.locator(".mandate").first().locator(".pill")).toHaveText("Cancelled", { timeout: 40_000 });
  await expect(page.getByText(/You cancelled/)).toHaveCount(0);
});

test("cancelled in Adena for real: the page looks on chain, then says so without claiming more than it knows", async ({ page }) => {
  await installStandin(page, c, { ...supporter, refuse: () => true });
  await page.goto("./#/plan/1");
  await page.getByRole("button", { name: "Connect wallet to subscribe" }).click();
  await page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ }).click();
  await expect(page.getByRole("alert")).toContainText("You cancelled “Give the permission (approval 1 of 2)” in Adena, or closed its window, and the chain does not show it", {
    timeout: 20_000,
  });
});

test("a step not on chain yet survives a reload and leaving the page, and clears once the chain shows it", async ({ page }) => {
  test.setTimeout(90_000);
  await installStandin(page, c, { ...supporter, queuedOnly: true, delayMs: 9_000 });
  await page.goto("./#/plan/1");
  await page.getByRole("button", { name: "Connect wallet to subscribe" }).click();
  await page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ }).click();
  const banner = page.locator(".pending");
  await expect(banner).toContainText("Do not approve it again", { timeout: 15_000 });
  await page.reload();
  await expect(banner).toContainText("Do not approve it again");
  await page.goto("./#/how");
  await expect(banner).toBeVisible();
  await shots(page, "pending-banner");
  await page.waitForTimeout(6_000);
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(banner).toHaveCount(0, { timeout: 15_000 });
  await page.goto("./#/plan/1");
  await expect(page.getByRole("button", { name: "Connect wallet to subscribe" }).or(page.getByRole("button", { name: "Finish subscribing" }))).toBeVisible();
});

test("stop: the cancel is checked again right before it; a mandate that changed meanwhile is left alone", async ({ page }) => {
  await installStandin(page, c, supporter);
  await stopAll(page);
  // subscribe plan 1 again (finishing what the previous test left)
  await page.goto("./#/plan/1");
  const go = page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days|Finish subscribing/ });
  await go.click();
  await expect(page.getByText(/You support this plan/)).toBeVisible({ timeout: 20_000 });
  const p2 = await page.context().newPage();
  const key = c.keys.collector.addr;
  await installStandin(p2, c, {
    ...supporter,
    before: async (params) => {
      if (!isRevoke(params)) return;
      // another tab cancels this mandate and records a new one on the same key (plan 2)
      const call = (func: string, args: string[]) => ({ type: "/vm.m_call", value: { caller: supporter.address, send: "", pkg_path: c.realm, func, args } });
      const end = String(Math.floor(Date.now() / 1000) + 30 * 86400);
      expect(await sendDirect(c, supporter, { messages: [call("Cancel", [supporter.address, key]), call("Subscribe", ["2", key, end])], memo: "", gasWanted: 60_000_000, gasFee: 100_000 })).toBe(true);
    },
  });
  await p2.goto(`./#/mine?a=${supporter.address}`);
  await p2.getByRole("button", { name: "Connect wallet" }).first().click();
  await p2.getByRole("button", { name: "Stop this mandate" }).first().click();
  await p2.getByRole("group").getByRole("button", { name: "Stop this mandate" }).click();
  // the permission was removed by then: never "left in place", never "stays on chain"
  await expect(p2.getByRole("alert").first()).toContainText(
    "Another of your mandates (plan #2) now uses this collector key. So “Cancel the mandate in Mandate” was not sent. The page now shows the current state.",
  );
  await expect(p2.getByRole("alert").first()).not.toContainText("left in place");
  await expect(p2.getByRole("alert").first()).not.toContainText("stays on chain");
  await p2.close();
});

test("permissions for Mandate without a mandate are listed with what they allow, and can be removed", async ({ page }) => {
  await installStandin(page, c, supporter);
  await stopAll(page);
  const r = randomPermissions(1, supporter.address, "create");
  expect(await sendDirect(c, supporter, r.params)).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "Connect wallet" }).first().click().catch(() => undefined);
  const loose = page.locator(".loose");
  await expect(loose).toContainText("Permissions without a mandate");
  await expect(loose).toContainText("can still use it to call Mandate for this wallet");
  await shots(page, "mine-loose-permission");
  const before = (await sessionKeys(c, supporter.address)).length;
  await loose.getByRole("button", { name: "Remove this permission" }).last().click();
  await expect.poll(async () => (await sessionKeys(c, supporter.address)).length, { timeout: 20_000 }).toBe(before - 1);
});

test("a permission refused in the block: the wallet reached 16 permissions in between", async ({ page }) => {
  let extra: string[] = [];
  await installStandin(page, c, {
    ...supporter,
    before: async (params) => {
      if (isCreate(params) && extra.length === 0) {
        const have = (await sessionKeys(c, supporter.address)).length;
        const r = randomPermissions(16 - have, supporter.address, "create");
        extra = r.pubs;
        expect(await sendDirect(c, supporter, r.params)).toBe(true);
      }
    },
  });
  await stopAll(page);
  await page.goto("./#/plan/1");
  await page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ }).click();
  await expect(page.getByRole("alert")).toContainText("your wallet already holds the 16 permissions the chain allows, counting ones for other apps and expired ones");
  await expect(page.getByText(/Your wallet is full/)).toBeVisible();
  await shots(page, "subscribe-blocked-full");
  // tidy up for the next test
  expect(await sendDirect(c, supporter, randomPermissions(0, supporter.address, "revoke", extra).params)).toBe(true);
});

test("a permission refused in the block: the collector address became an account in between; then nobody new can join", async ({ page }) => {
  await installStandin(page, c, {
    ...supporter,
    before: async (params) => {
      if (isCreate(params)) await sendCoins(c, "fluxen", c.keys.collector.addr, "1ugnot");
    },
  });
  await stopAll(page);
  await page.goto("./#/plan/1");
  await page.getByRole("button", { name: /Subscribe for 1 GNOT every 30 days/ }).click();
  await expect(page.getByRole("alert")).toContainText("collector key can no longer be used for new permissions");
  await expect(page.getByText(/New supporters cannot join right now/).first()).toBeVisible();
  await shots(page, "subscribe-blocked-collector");
  await page.goto("./#/plan/3");
  await expect(page.getByText(/New supporters cannot join right now/).first()).toBeVisible();
  await page.goto(`./#/creator/${c.keys.fluxen.addr}`);
  await expect(page.getByText(/This key’s address has received coins/)).toBeVisible();
  await shots(page, "creator-blocked-key");
});
