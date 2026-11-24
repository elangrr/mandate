import { beforeEach, describe, expect, it, vi } from "vitest";

// the chain, as the reads would answer
const chain = vi.hoisted(() => ({ plans: [] as any[][], payee: null as any, now: 1_800_000_000n, sessions: [] as any[] }));
vi.mock("./rpc", () => ({
  read: {
    chainTime: async () => chain.now,
    plansOf: async (_payee: string, page: number) => chain.plans[page - 1] ?? [],
    payee: async () => chain.payee,
    sessions: async () => chain.sessions,
    mandateOf: async () => null,
  },
}));
import { onChain, repeatAdvice, type PendingCheck } from "./pending";
import { allowPath } from "./tx";

const CREATOR = "g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj";
const plan = (o: Partial<{ title: string; amount: bigint; period: bigint; createdAt: bigint }>) => ({ title: "Support Fluxen's work", amount: 1_000_000n, period: 2_592_000n, createdAt: 1_800_000_000n, ...o });
const check = { kind: "plan" as const, key: CREATOR, title: "Support Fluxen's work", amount: "1000000", period: "2592000", after: "1799999990" };

beforeEach(() => {
  chain.plans = [];
  chain.payee = null;
  chain.sessions = [];
});

describe("on-chain confirmation of a creator's steps", () => {
  it("a plan counts only with exactly these terms, published after the step was sent", async () => {
    expect(await onChain(CREATOR, check)).toBe(false);
    chain.plans = [[plan({ createdAt: 1_799_999_000n })]]; // an older plan with the same terms
    expect(await onChain(CREATOR, check)).toBe(false);
    chain.plans = [[plan({ amount: 2_000_000n }), plan({ title: "Other" }), plan({ period: 86_400n })]];
    expect(await onChain(CREATOR, check)).toBe(false);
    chain.plans = [[plan({})]];
    expect(await onChain(CREATOR, check)).toBe(true);
  });
  it("a plan on a later page is found", async () => {
    chain.plans = [Array.from({ length: 20 }, (_, i) => plan({ title: `t${i}` })), [plan({})]];
    expect(await onChain(CREATOR, check)).toBe(true);
  });
  it("a collector key counts only when the creator's published key is this one", async () => {
    const k = { kind: "collector-key" as const, key: CREATOR, gpub: "gpub1new" };
    expect(await onChain(CREATOR, k)).toBe(false);
    chain.payee = { collectorKey: "gpub1old" };
    expect(await onChain(CREATOR, k)).toBe(false);
    chain.payee = { collectorKey: "gpub1new" };
    expect(await onChain(CREATOR, k)).toBe(true);
  });
});

describe("on-chain confirmation of a permission", () => {
  const KEY = "g1psdsf789f4xw3qrpjue54g2h28syd09yfkrxdh";
  const END = 1_830_000_000n;
  const permission = (o: object = {}) => ({ address: KEY, pubKey: "", expiresAt: END, spendLimit: 1_100_000n, spendPeriod: 2_592_000n, spendUsed: 0n, spendReset: 0n, allowPaths: [allowPath()], ...o });
  const check: PendingCheck = { kind: "permission", key: KEY, period: "2592000", cap: "1100000", end: END.toString() };
  it("counts only with the end date signed: a permission for the key with another end (another tab) is not this step", async () => {
    chain.sessions = [permission({ expiresAt: END - 86_400n })];
    expect(await onChain(CREATOR, check)).toBe(false);
    chain.sessions = [permission({ spendLimit: 2_000_000n })];
    expect(await onChain(CREATOR, check)).toBe(false);
    chain.sessions = [permission()];
    expect(await onChain(CREATOR, check)).toBe(true);
  });
  it("a record stored by an earlier build (no end date) still matches on the key, the period and the cap", async () => {
    const old = { kind: "permission" as const, key: KEY, period: "2592000", cap: "1100000" };
    chain.sessions = [permission({ expiresAt: END - 86_400n })];
    expect(await onChain(CREATOR, old)).toBe(true);
    chain.sessions = [];
    expect(await onChain(CREATOR, old)).toBe(false);
  });
  it("such a record is read back from sessionStorage as it was, with or without the end date", async () => {
    const records = {
      [CREATOR]: { payer: CREATOR, label: "Give the permission (approval 1 of 2)", hash: null, tries: 1, check: { kind: "permission", key: KEY, period: "2592000", cap: "1100000" } },
      [KEY]: { payer: KEY, label: "Give the permission (approval 1 of 2)", hash: "abc", tries: 0, check },
    };
    sessionStorage.setItem("mandate.pending.v1", JSON.stringify(records));
    vi.resetModules();
    const fresh = await import("./pending");
    expect(fresh.getPending(CREATOR)).toEqual(records[CREATOR]);
    expect(fresh.getPending(KEY)).toEqual(records[KEY]);
    sessionStorage.removeItem("mandate.pending.v1");
  });
});

describe("what a repeat costs (shown when a step is not on chain)", () => {
  const plan: PendingCheck = { kind: "plan", key: CREATOR, title: "t", amount: "1", period: "60", after: "0" };
  const others: PendingCheck[] = [
    { kind: "permission", key: CREATOR, period: "60", cap: "1" },
    { kind: "mandate", key: CREATOR, planId: "1" },
    { kind: "permission-gone", key: CREATOR },
    { kind: "cancelled", key: CREATOR, mandateId: "1" },
    { kind: "gone-and-cancelled", key: CREATOR, mandateId: "1" },
    { kind: "collector-key", key: CREATOR, gpub: "gpub1x" },
  ];
  it("a plan: a repeat publishes a second plan for good and pays the deposit again; look at the creator page first", () => {
    for (const when of ["cancelled", "missing"] as const) {
      const t = repeatAdvice(plan, when);
      expect(t).toMatch(/a second plan, which can never be removed, and pays the storage deposit again/);
      expect(t).toMatch(/creator page/);
      expect(t).not.toMatch(/network fee at most|at most a network fee/);
    }
  });
  it("every other step: a repeat of a step already done is refused, or a no-op with no extra storage deposit, so it costs a network fee at most", () => {
    for (const c of others) {
      expect(repeatAdvice(c, "cancelled")).toMatch(/a repeat costs a network fee at most/);
      expect(repeatAdvice(c, "missing")).toMatch(/repeating it then costs at most a network fee/);
    }
  });
});
