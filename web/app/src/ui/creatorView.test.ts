import { describe, expect, it } from "vitest";
import { capOf, feeEstimate, keyState, readPlanForm, waitLabel } from "./creatorView";

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

describe("waitLabel (a Publish panel's button while it cannot be used)", () => {
  it("a pending step belongs to the panel of its kind, never by its label", () => {
    expect(waitLabel("key", "collector-key", null)).toBe("Waiting for this step to reach the chain…");
    expect(waitLabel("plan", "collector-key", null)).toBe("Waiting for the other step…");
    expect(waitLabel("plan", "plan", null)).toBe("Waiting for this step to reach the chain…");
    expect(waitLabel("key", "plan", null)).toBe("Waiting for the other step…");
  });
  it("a pending subscribe or stop step is neither panel's: both point to the warning at the top", () => {
    for (const k of ["permission", "mandate", "permission-gone", "cancelled", "gone-and-cancelled"] as const) {
      expect(waitLabel("key", k, null)).toBe("Waiting for the step at the top of the page…");
      expect(waitLabel("plan", k, "plan")).toBe("Waiting for the step at the top of the page…");
    }
  });
  it("without a pending step: the panel whose approval is running", () => {
    expect(waitLabel("key", null, "key")).toBe("Waiting for this step to reach the chain…");
    expect(waitLabel("plan", null, "key")).toBe("Waiting for the other step…");
  });
});
