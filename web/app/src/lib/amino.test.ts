import { describe, expect, it } from "vitest";
import fixture from "../__fixtures__/chain.json";
import {
  DecodeError,
  decodeBool,
  decodeGetPayee,
  decodeGetPlan,
  decodeInt64,
  decodeMandateOf,
  decodeMandates,
  decodePayingSupporters,
  decodePlanCounts,
  decodePlans,
  decodeTotals,
} from "./amino";
import { parseAccountExists, parsePackageStatus, parseSession } from "./rpc";

// Real responses from a local chain (e2e/capture-fixtures.mjs): plan 1 has 5
// supporters with sessions (all paid by one collector run) and 3 never-paid
// mandates recorded without a session; plans 2 and 3 have 3 and 2 paid.
const q = (expr: string) => {
  const r = (fixture.qeval_json as Record<string, { data: string; error: string | null }>)[expr];
  if (!r) throw new Error("no fixture for " + expr);
  return r;
};
const k = fixture.keys;
const exprFor = (prefix: string) => Object.keys(fixture.qeval_json).find((e) => e.startsWith(prefix))!;

describe("decoders on real chain data", () => {
  it("Totals", () => {
    const t = decodeTotals(q("Totals()").data);
    expect(t.plans).toBe(3);
    expect(t.mandates).toBe(13);
    expect(t.pulls).toBe(10n);
    expect(t.paid).toBe(5n * 1_000_000n + 3n * 500_000n + 2n * 100_000n);
  });

  it("GetPlan: found and missing", () => {
    const p = decodeGetPlan(q("GetPlan(1)").data)!;
    expect(p.id).toBe(1n);
    expect(p.title).toBe("Support Fluxen's work");
    expect(p.amount).toBe(1_000_000n);
    expect(p.period).toBe(2_592_000n);
    expect(p.payee).toBe(k.fluxen);
    expect(p.mandates).toBe(8);
    expect(p.paidThisPeriod).toBe(5);
    expect(p.pulls).toBe(5n);
    expect(p.paid).toBe(5_000_000n);
    expect(p.lastPullAt > 0n).toBe(true);
    expect(decodeGetPlan(q("GetPlan(99)").data)).toBeNull();
  });

  it("Plans and PlansOf", () => {
    const all = decodePlans(q("Plans(1)").data);
    expect(all.map((p) => p.title).sort()).toEqual(["Fluxen test plan (one minute)", "Fluxen's weekly notes", "Support Fluxen's work"]);
    expect(decodePlans(q(exprFor("PlansOf(")).data)).toHaveLength(3);
  });

  it("GetPayee: the collector key and its funded flag", () => {
    const pe = decodeGetPayee(q(exprFor(`GetPayee(address("${k.fluxen}`)).data)!;
    expect(pe.addr).toBe(k.fluxen);
    expect(pe.plans).toBe(3);
    expect(pe.collectorAddr).toBe(k.collector);
    expect(pe.collectorKey.startsWith("gpub1")).toBe(true);
    expect(pe.collectorFunded).toBe(false);
    expect(decodeGetPayee(q(exprFor(`GetPayee(address("${k.stranger}`)).data)).toBeNull();
  });

  it("MandateOf and MandatesOf", () => {
    const m = decodeMandateOf(q(exprFor("MandateOf(")).data)!;
    expect(m.payer).toBe(k.paid);
    expect(m.session).toBe(k.collector);
    expect(m.status).toBe("active");
    expect(m.pulls).toBe(1n);
    expect(m.paidThrough).toBe(m.nextPullAt);
    expect(m.sessionQuery).toBe(`auth/accounts/${k.paid}/session/${k.collector}`);
    expect(decodeMandates(q(exprFor("MandatesOf(")).data)).toHaveLength(1);
  });

  it("SupportersOf, PayingSupporters (cursor) and PlanCounts", () => {
    expect(decodeMandates(q("SupportersOf(1, 1)").data)).toHaveLength(8);
    const ps = decodePayingSupporters(q("PayingSupporters(1, -1)").data);
    expect(ps.list).toHaveLength(5);
    expect(ps.next).toBe(-1); // exhausted: a client stops here
    expect(decodePlanCounts(q("PlanCounts(1)").data)).toEqual({ paidThisPeriod: 5, paidLastPeriod: 0, unpaid: 3, unpaidExact: true });
  });

  it("PaidThrough, HasMandate and constants", () => {
    expect(decodeInt64(q(exprFor("PaidThrough(")).data) > 0n).toBe(true);
    expect(decodeBool(q(exprFor("HasMandate(")).data)).toBe(true);
    expect(decodeInt64(q("FeeAllowance").data)).toBe(100_000n);
    expect(decodeInt64(q("MaxPeriod").data)).toBe(2_592_000n);
  });

  it("refuses the wrong shape instead of guessing", () => {
    expect(() => decodeGetPlan(q("Totals()").data)).toThrow(DecodeError);
    expect(() => decodePlans(q("SupportersOf(1, 1)").data)).toThrow(DecodeError);
    expect(() => decodeTotals("not json")).toThrow(DecodeError);
    expect(() => decodeTotals('{"results":[]}')).toThrow(DecodeError);
  });
});

describe("auth queries", () => {
  const a = fixture.abci as Record<string, { data: string; error: string | null; log: string }>;
  it("a session the chain has", () => {
    const s = parseSession(a[`auth/accounts/${k.paid}/session/${k.collector}`] as any)!;
    expect(s.spendLimit).toBe(1_100_000n);
    expect(s.spendPeriod).toBe(2_592_000n);
    expect(s.allowPaths).toEqual(["vm/exec:" + fixture.realm]);
    expect(s.expiresAt > 0n).toBe(true);
  });
  it("no such session", () => {
    expect(parseSession(a[`auth/accounts/${k.stranger}/session/${k.collector}`] as any)).toBeNull();
  });
  it("whether an address is an account", () => {
    expect(parseAccountExists(a[`auth/accounts/${k.collector}`] as any)).toBe(false);
    expect(parseAccountExists(a[`auth/accounts/${k.stranger}`] as any)).toBe(true);
  });
  it("package status", () => {
    expect(parsePackageStatus({ data: '{"path":"x","status":"inert","reason":"waiting for a package approver to enable it","pending":true}', error: null, log: "" })).toEqual({
      status: "inert",
      reason: "waiting for a package approver to enable it",
    });
    expect(parsePackageStatus({ data: '{"path":"x","status":"live"}', error: null, log: "" }).status).toBe("live");
    expect(parsePackageStatus({ data: "", error: "boom", log: "" }).status).toBe("unknown");
  });
});
