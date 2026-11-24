import { describe, expect, it } from "vitest";
import { capOf, feeEstimate, keyState, readPlanForm } from "./creatorView";

describe("readPlanForm", () => {
  it("a valid form gives the exact offer", () => {
    const r = readPlanForm({ title: "Support Fluxen's work", price: "1", count: "30", unit: "days" });
    expect(r.errors).toEqual({});
    expect(r.offer).toEqual({ title: "Support Fluxen's work", amount: 1_000_000n, period: 2_592_000n });
    expect(r.chars).toBe(21);
  });
  it("names every problem, and previews only what is valid", () => {
    const r = readPlanForm({ title: "", price: "0.05", count: "31", unit: "days" });
    expect(r.offer).toBeNull();
    expect(r.errors.title).toMatch(/title/);
    expect(r.errors.price).toMatch(/at least 0.1 GNOT/);
    expect(r.errors.period).toMatch(/at most 30 days/);
    expect(r.amount).toBeNull();
    expect(r.period).toBeNull();
    const half = readPlanForm({ title: "x", price: "2", count: "", unit: "hours" });
    expect(half.amount).toBe(2_000_000n);
    expect(half.period).toBeNull();
  });
});

describe("cap, fee and key state", () => {
  it("the cap is the price plus 0.1 GNOT", () => expect(capOf(1_000_000n)).toBe(1_100_000n));
  it("the fee estimate is the chain's minimum for the measured gas plus Adena's 10%", () => {
    expect(feeEstimate(13_000_000, { gas: 1000n, amount: 1n })).toBe(14_300n);
  });
  it("the key's state says only what the chain shows", () => {
    expect(keyState(null, false).kind).toBe("none");
    expect(keyState({ collectorKey: "", collectorFunded: false }, false).kind).toBe("none");
    expect(keyState({ collectorKey: "gpub1x", collectorFunded: false }, false)).toMatchObject({ kind: "ready", label: "Ready" });
    expect(keyState({ collectorKey: "gpub1x", collectorFunded: true }, false)).toMatchObject({ kind: "blocked", label: "Blocked" });
    expect(keyState({ collectorKey: "gpub1x", collectorFunded: false }, true).kind).toBe("blocked");
  });
});
