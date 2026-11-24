import { beforeEach, describe, expect, it, vi } from "vitest";

// the chain, as the reads would answer
const chain = vi.hoisted(() => ({ plans: [] as any[][], payee: null as any, now: 1_800_000_000n }));
vi.mock("./rpc", () => ({
  read: {
    chainTime: async () => chain.now,
    plansOf: async (_payee: string, page: number) => chain.plans[page - 1] ?? [],
    payee: async () => chain.payee,
    sessions: async () => [],
    mandateOf: async () => null,
  },
}));
import { onChain } from "./pending";

const CREATOR = "g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj";
const plan = (o: Partial<{ title: string; amount: bigint; period: bigint; createdAt: bigint }>) => ({ title: "Support Fluxen's work", amount: 1_000_000n, period: 2_592_000n, createdAt: 1_800_000_000n, ...o });
const check = { kind: "plan" as const, key: CREATOR, title: "Support Fluxen's work", amount: "1000000", period: "2592000", after: "1799999990" };

beforeEach(() => {
  chain.plans = [];
  chain.payee = null;
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
