import { describe, expect, it } from "vitest";
import type { Mandate, Payee, Plan } from "./amino";
import { FIRST_DEPOSIT_UGNOT, LATER_DEPOSIT_UGNOT, permissionFits, removeCheck, stopCheck, stopState, subscribeState, type ChainView } from "./flows";
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
  return {
    now: NOW, plan, payee, keyProblem: null, collectorIsAccount: false, byKey: null, hasForPlan: false, planMandate: null, activeCount: 0, hasHistory: false,
    sessions: [], paidThrough: 0n, balance: 10_000_000n, gasPrice: { gas: 1000n, amount: 1n }, ...o,
  };
}

const others = (n: number) => Array.from({ length: n }, (_, i) => session({ address: `other-${i}` }));
const cancelled = (o: Partial<Mandate> = {}) => mandate({ status: "cancelled", cancelledAt: NOW - 10n, ...o });

describe("subscribeState", () => {
  it("is ready for a first mandate: a new permission for a year, the first deposit, both fees", () => {
    const s = subscribeState(view());
    expect(s.kind).toBe("ready");
    if (s.kind !== "ready") return;
    expect(s.resume).toBe(false);
    expect(s.leftover).toBeNull();
    expect(s.end).toBe(defaultEnd(NOW));
    expect(s.cap).toBe(1_100_000n);
    expect(s.deposit).toBe(FIRST_DEPOSIT_UGNOT);
    expect(s.fees).toBe(7_500n + 25_000n);
    expect(s.paidThrough).toBe(0n);
    expect(s.lowBalance).toBe(false);
  });

  it("blocks without a collector key, with an unusable key, and when the key is an account", () => {
    expect(subscribeState(view({ payee: null })).kind).toBe("blocked");
    expect(subscribeState(view({ payee: { ...payee, collectorKey: "" } })).kind).toBe("blocked");
    expect(subscribeState(view({ keyProblem: "not-secp256k1" })).kind).toBe("blocked");
    expect(subscribeState(view({ keyProblem: "mismatch" })).kind).toBe("blocked");
    const funded = subscribeState(view({ payee: { ...payee, collectorFunded: true } }));
    expect(funded.kind === "blocked" && funded.title).toBe("New supporters cannot join right now");
    expect(subscribeState(view({ collectorIsAccount: true })).kind).toBe("blocked");
  });

  it("shows the active mandate for this plan (MandateOf for the key) instead of a second one", () => {
    const m = mandate({ planId: plan.id });
    expect(subscribeState(view({ byKey: m, hasForPlan: true, sessions: [session()] }))).toEqual({ kind: "already", mandate: m, permission: true });
  });

  it("says when the permission behind an active mandate is gone or expired", () => {
    const m = mandate({ planId: plan.id });
    expect(subscribeState(view({ byKey: m, hasForPlan: true }))).toEqual({ kind: "already", mandate: m, permission: false });
    expect(subscribeState(view({ byKey: m, hasForPlan: true, sessions: [session({ expiresAt: NOW })] }))).toEqual({ kind: "already", mandate: m, permission: false });
  });

  it("an active mandate for this plan under an older key still counts (HasMandate), even when the history scan cannot find it", () => {
    expect(subscribeState(view({ hasForPlan: true }))).toEqual({ kind: "already", mandate: null, permission: null });
    const old = mandate({ planId: plan.id, session: "g1old" });
    expect(subscribeState(view({ hasForPlan: true, planMandate: old }))).toEqual({ kind: "already", mandate: old, permission: false });
  });

  it("a cancelled or ended mandate for the key is not active; the deposit is the later one", () => {
    for (const gone of [cancelled({ planId: plan.id }), mandate({ planId: plan.id, expiresAt: NOW })]) {
      const s = subscribeState(view({ byKey: gone, hasHistory: true }));
      expect(s.kind === "ready" && s.deposit).toBe(LATER_DEPOSIT_UGNOT);
    }
  });

  it("one plan per creator: another active plan of the same creator uses the key", () => {
    const s = subscribeState(view({ byKey: mandate({ planId: 1n }), sessions: [session()] }));
    expect(s.kind === "blocked" && s.title).toBe("One plan per creator");
  });

  it("resumes a half-finished subscription: the permission exists, no mandate was ever recorded for it", () => {
    const end = NOW + 200n * DAY;
    const s = subscribeState(view({ sessions: [session({ expiresAt: end })] }));
    expect(s.kind).toBe("ready");
    if (s.kind !== "ready") return;
    expect(s.resume).toBe(true);
    expect(s.leftover).toBeNull();
    expect(s.end).toBe(end); // the mandate ends with its permission
    expect(s.fees).toBe(25_000n); // no permission approval left
  });

  it("a permission left from an ended mandate is told as such, with its own end date", () => {
    const old = cancelled({ planId: 1n, expiresAt: NOW + 30n * DAY });
    const s = subscribeState(view({ byKey: old, sessions: [session({ expiresAt: NOW + 30n * DAY })], hasHistory: true }));
    expect(s.kind === "ready" && s.leftover).toEqual(old);
    expect(s.kind === "ready" && s.end).toBe(NOW + 30n * DAY);
  });

  it("a permission given after an earlier mandate ended is a half-finished subscription, not a leftover", () => {
    const old = cancelled({ planId: 1n, expiresAt: NOW + 30n * DAY });
    const s = subscribeState(view({ byKey: old, sessions: [session({ expiresAt: NOW + 365n * DAY })], hasHistory: true }));
    expect(s.kind === "ready" && s.resume).toBe(true);
    expect(s.kind === "ready" && s.leftover).toBeNull();
  });

  it("asks to remove a leftover permission whose terms do not fit", () => {
    for (const bad of [
      session({ spendLimit: 2_000_000n }),
      session({ spendPeriod: 86_400n }),
      session({ allowPaths: [allowPath(), "vm/exec:gno.land/r/other"] }),
      session({ allowPaths: ["vm/exec:gno.land/r/other"] }),
      session({ expiresAt: NOW + 3600n }),
      session({ expiresAt: NOW + 400n * DAY }),
    ]) {
      expect(subscribeState(view({ sessions: [bad] })).kind).toBe("fix-permission");
    }
  });

  it("a permission that ends before the time already paid for runs out cannot carry a mandate", () => {
    const s = subscribeState(view({ sessions: [session({ expiresAt: NOW + 10n * DAY })], paidThrough: NOW + 20n * DAY }));
    expect(s.kind).toBe("fix-permission");
  });

  it("a full wallet: 16 permissions (any app, expired ones too), or 16 active mandates; an unknown count does not block", () => {
    const full = subscribeState(view({ sessions: others(16) }));
    expect(full.kind === "blocked" && full.reason).toMatch(/other apps and ones that have expired count too/);
    expect(subscribeState(view({ sessions: others(15) })).kind).toBe("ready");
    expect(subscribeState(view({ activeCount: 16 })).kind).toBe("blocked");
    expect(subscribeState(view({ activeCount: null })).kind).toBe("ready");
  });

  it("not enough GNOT for the deposit and fees blocks; not enough for the first payment too only warns", () => {
    const need = FIRST_DEPOSIT_UGNOT + 7_500n + 25_000n;
    expect(subscribeState(view({ balance: need - 1n })).kind).toBe("blocked");
    const low = subscribeState(view({ balance: need }));
    expect(low.kind === "ready" && low.lowBalance).toBe(true);
    const enough = subscribeState(view({ balance: need + 1_000_000n + 100_000n }));
    expect(enough.kind === "ready" && enough.lowBalance).toBe(false);
    // already paid: no payment is due now, so the deposit and fees are enough
    const paid = subscribeState(view({ balance: need, paidThrough: NOW + 10n * DAY }));
    expect(paid.kind === "ready" && paid.lowBalance).toBe(false);
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

describe("stopState (what the page offers)", () => {
  it("an active mandate with its permission: revoke, then cancel", () => {
    const m = mandate();
    expect(stopState(m, [m], [session()], NOW)).toEqual({ kind: "ready", session: session(), cancel: true });
  });
  it("permission already gone: cancel only; cancelled with a leftover permission: remove it only; nothing left", () => {
    expect(stopState(mandate(), [mandate()], [], NOW)).toEqual({ kind: "ready", session: null, cancel: true });
    const c = cancelled();
    expect(stopState(c, [c], [session()], NOW)).toEqual({ kind: "ready", session: session(), cancel: false });
    expect(stopState(mandate({ status: "expired" }), [], [], NOW).kind).toBe("nothing");
  });
});

describe("stopCheck (fresh reads right before signing)", () => {
  const fresh = (byKey: Mandate | null, sessions: SessionEntry[]) => ({ now: NOW, byKey, sessions });
  it("stops the mandate shown: revoke its permission and cancel it", () => {
    const m = mandate();
    expect(stopCheck(m, fresh(m, [session()]), "stop")).toEqual({ kind: "go", revoke: session(), cancel: true });
  });
  it("never cancels or revokes for another mandate that now uses the key", () => {
    const shown = mandate({ id: 1n });
    const now = mandate({ id: 2n, planId: 3n });
    const c = stopCheck(shown, fresh(now, [session()]), "stop");
    expect(c.kind === "changed" && c.reason).toMatch(/plan #3/);
    expect(stopCheck(cancelled({ id: 1n }), fresh(now, [session()]), "tidy").kind).toBe("changed");
  });
  it("a stop of a mandate cancelled meanwhile sends nothing and says so", () => {
    const c = stopCheck(mandate(), fresh(cancelled(), [session()]), "stop");
    expect(c.kind === "changed" && c.reason).toMatch(/leftover permission/);
  });
  it("tidy: removes only a permission no active mandate uses", () => {
    const c = cancelled();
    expect(stopCheck(c, fresh(c, [session()]), "tidy")).toEqual({ kind: "go", revoke: session(), cancel: false });
    expect(stopCheck(c, fresh(c, []), "tidy").kind).toBe("changed");
  });
  it("removeCheck: not while a mandate uses the key, not when it is gone", () => {
    expect(removeCheck(KEY, fresh(mandate(), [session()]))).toMatch(/now uses this permission/);
    expect(removeCheck(KEY, fresh(null, []))).toMatch(/already gone/);
    expect(removeCheck(KEY, fresh(cancelled(), [session()]))).toBeNull();
  });
});
