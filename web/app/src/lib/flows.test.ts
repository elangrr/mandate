import { describe, expect, it } from "vitest";
import type { Mandate, Payee, Plan } from "./amino";
import { FIRST_DEPOSIT_UGNOT, LATER_DEPOSIT_UGNOT, permissionFits, stopState, subscribeState, type ChainView } from "./flows";
import type { SessionEntry } from "./rpc";
import { allowPath, defaultEnd } from "./tx";

const NOW = 1_800_000_000n;
const DAY = 86_400n;
const KEY = "g1psdsf789f4xw3qrpjue54g2h28syd09yfkrxdh";
const OTHER_KEY = "g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj";
const ME = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";

const plan: Plan = {
  id: 2n, payee: OTHER_KEY, title: "Support Fluxen's work", amount: 1_000_000n, period: 2_592_000n,
  createdAt: 0n, mandates: 0, cancelled: 0, paidThisPeriod: 0, paidLastPeriod: 0, periodStart: 0n, pulls: 0n, paid: 0n, lastPullAt: 0n,
};
const payee: Payee = { addr: OTHER_KEY, plans: 2, pulls: 0n, paid: 0n, lastPullAt: 0n, collectorKey: "gpub1x", collectorAddr: KEY, collectorFunded: false };

function mandate(o: Partial<Mandate> = {}): Mandate {
  return {
    id: 1n, planId: 1n, payer: ME, payee: OTHER_KEY, session: KEY, sessionPubKey: "", amount: 1_000_000n, period: 2_592_000n,
    createdAt: NOW - DAY, expiresAt: NOW + 300n * DAY, nextPullAt: NOW, lastPullAt: 0n, paidThrough: 0n, pulls: 0n, paid: 0n,
    cancelledAt: 0n, cancelledBy: "", status: "active", due: false, sessionQuery: "", ...o,
  };
}

function session(o: Partial<SessionEntry> = {}): SessionEntry {
  return { address: KEY, pubKey: "", expiresAt: NOW + 300n * DAY, spendLimit: 1_100_000n, spendPeriod: 2_592_000n, spendUsed: 0n, spendReset: 0n, allowPaths: [allowPath()], ...o };
}

function view(o: Partial<ChainView> = {}): ChainView {
  return { now: NOW, plan, payee, collectorIsAccount: false, mandates: [], sessions: [], paidThrough: 0n, balance: 10_000_000n, gasPrice: { gas: 1000n, amount: 1n }, ...o };
}

const others = (n: number) => Array.from({ length: n }, (_, i) => session({ address: `other-${i}` }));

describe("subscribeState", () => {
  it("is ready for a first mandate: a new permission for a year, the first deposit, both fees", () => {
    const s = subscribeState(view());
    expect(s.kind).toBe("ready");
    if (s.kind !== "ready") return;
    expect(s.resume).toBe(false);
    expect(s.end).toBe(defaultEnd(NOW));
    expect(s.cap).toBe(1_100_000n);
    expect(s.deposit).toBe(FIRST_DEPOSIT_UGNOT);
    expect(s.fees).toBe(7_500n + 25_000n);
    expect(s.paidThrough).toBe(0n);
  });

  it("blocks without a collector key, and when the key is an account (funded or not)", () => {
    expect(subscribeState(view({ payee: null })).kind).toBe("blocked");
    expect(subscribeState(view({ payee: { ...payee, collectorKey: "" } })).kind).toBe("blocked");
    const funded = subscribeState(view({ payee: { ...payee, collectorFunded: true } }));
    expect(funded.kind === "blocked" && funded.title).toBe("New supporters cannot join right now");
    expect(subscribeState(view({ collectorIsAccount: true })).kind).toBe("blocked");
  });

  it("shows an active mandate for this plan instead of a second one", () => {
    const m = mandate({ planId: plan.id });
    const s = subscribeState(view({ mandates: [m], sessions: [session()] }));
    expect(s).toEqual({ kind: "already", mandate: m, permission: true });
  });

  it("says when the permission behind an active mandate is gone or expired", () => {
    const m = mandate({ planId: plan.id });
    expect(subscribeState(view({ mandates: [m] }))).toEqual({ kind: "already", mandate: m, permission: false });
    expect(subscribeState(view({ mandates: [m], sessions: [session({ expiresAt: NOW })] }))).toEqual({ kind: "already", mandate: m, permission: false });
  });

  it("does not count a cancelled or ended mandate as active", () => {
    const gone = [mandate({ planId: plan.id, status: "cancelled" }), mandate({ planId: plan.id, expiresAt: NOW })];
    const s = subscribeState(view({ mandates: gone }));
    expect(s.kind === "ready" && s.deposit).toBe(LATER_DEPOSIT_UGNOT);
  });

  it("one plan per creator: another active plan of the same creator uses the key", () => {
    const s = subscribeState(view({ mandates: [mandate({ planId: 1n })], sessions: [session()] }));
    expect(s.kind === "blocked" && s.title).toBe("One plan per creator");
  });

  it("resumes when the permission exists with the plan's terms and no mandate uses it", () => {
    const end = NOW + 200n * DAY;
    const s = subscribeState(view({ sessions: [session({ expiresAt: end })] }));
    expect(s.kind).toBe("ready");
    if (s.kind !== "ready") return;
    expect(s.resume).toBe(true);
    expect(s.end).toBe(end); // the mandate ends with its permission
    expect(s.fees).toBe(25_000n); // no permission approval left
  });

  it("a leftover permission that ends too late for a mandate gets the default end", () => {
    const s = subscribeState(view({ sessions: [session({ expiresAt: NOW + 400n * DAY })] }));
    expect(s.kind === "ready" && s.end).toBe(defaultEnd(NOW));
  });

  it("asks to remove a leftover permission whose terms do not fit", () => {
    for (const bad of [
      session({ spendLimit: 2_000_000n }),
      session({ spendPeriod: 86_400n }),
      session({ allowPaths: [allowPath(), "vm/exec:gno.land/r/other"] }),
      session({ allowPaths: ["vm/exec:gno.land/r/other"] }),
      session({ expiresAt: NOW + 3600n }),
    ]) {
      expect(subscribeState(view({ sessions: [bad] })).kind).toBe("fix-permission");
    }
  });

  it("a full wallet: 16 permissions, or 16 active mandates", () => {
    expect(subscribeState(view({ sessions: others(16) })).kind).toBe("blocked");
    expect(subscribeState(view({ sessions: others(15) })).kind).toBe("ready");
    const mandates = Array.from({ length: 16 }, (_, i) => mandate({ id: BigInt(i + 10), planId: BigInt(i + 10), session: `s${i}` }));
    const s = subscribeState(view({ mandates }));
    expect(s.kind === "blocked" && s.title).toBe("Your wallet is full");
  });

  it("not enough GNOT for the deposit and fees", () => {
    const need = FIRST_DEPOSIT_UGNOT + 7_500n + 25_000n;
    expect(subscribeState(view({ balance: need - 1n })).kind).toBe("blocked");
    expect(subscribeState(view({ balance: need })).kind).toBe("ready");
  });

  it("carries paid time only while it is still in the future", () => {
    const later = subscribeState(view({ paidThrough: NOW + 10n * DAY }));
    expect(later.kind === "ready" && later.paidThrough).toBe(NOW + 10n * DAY);
    const past = subscribeState(view({ paidThrough: NOW - 1n }));
    expect(past.kind === "ready" && past.paidThrough).toBe(0n);
  });
});

describe("permissionFits", () => {
  it("accepts the exact terms, including a permission without an end", () => {
    expect(permissionFits(session(), plan, NOW)).toBeNull();
    expect(permissionFits(session({ expiresAt: 0n }), plan, NOW)).toBeNull();
  });
});

describe("stopState", () => {
  it("an active mandate with its permission: revoke, then cancel", () => {
    const m = mandate();
    expect(stopState(m, [m], [session()], NOW)).toEqual({ kind: "ready", session: session(), cancel: true });
  });

  it("permission already gone: cancel only", () => {
    const m = mandate();
    expect(stopState(m, [m], [], NOW)).toEqual({ kind: "ready", session: null, cancel: true });
  });

  it("already cancelled with a leftover permission: remove it only", () => {
    const m = mandate({ status: "cancelled", cancelledAt: NOW - 10n });
    expect(stopState(m, [m], [session()], NOW)).toEqual({ kind: "ready", session: session(), cancel: false });
  });

  it("nothing left to do", () => {
    const m = mandate({ status: "expired" });
    expect(stopState(m, [m], [], NOW).kind).toBe("nothing");
  });

  it("never removes a permission another active mandate still uses", () => {
    const old = mandate({ id: 1n, status: "cancelled", cancelledAt: NOW - 10n });
    const current = mandate({ id: 2n, planId: 2n });
    expect(stopState(old, [current, old], [session()], NOW).kind).toBe("nothing");
    expect(stopState(current, [current, old], [session()], NOW)).toEqual({ kind: "ready", session: session(), cancel: true });
  });
});
