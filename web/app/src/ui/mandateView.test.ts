import { describe, expect, it } from "vitest";
import { buildMandateTimeline, isCarriedPeriodCurrent, possiblePayments, scaleBarHeight, scaleCapMeter } from "./mandateView";

const DAY = 86_400n;
const MIN = 60n;
const BASE = 1_795_478_400n; // 2026-11-24T00:00:00Z

describe("possiblePayments", () => {
  it("counts 13 possible payments for a 365-day term on a 30-day plan (first due at once)", () => {
    expect(possiblePayments(BASE, BASE + 365n * DAY, 30n * DAY)).toBe(13n);
  });

  it("returns 0 when firstAllowed equals or exceeds expiresAt", () => {
    expect(possiblePayments(BASE, BASE, 30n * DAY)).toBe(0n);
    expect(possiblePayments(BASE + 1n, BASE, 30n * DAY)).toBe(0n);
  });
});

describe("buildMandateTimeline", () => {
  it("on-time payments: exact paid count, paid-until now state, and remaining possible payments", () => {
    const period = 30n * DAY;
    const now = BASE + 45n * DAY;
    const paidThrough = BASE + 60n * DAY;
    const expiresAt = BASE + 365n * DAY;
    const m = buildMandateTimeline({
      pulls: 2n,
      period,
      nextPullAt: paidThrough,
      paidThrough,
      expiresAt,
      now,
      status: "active",
    });
    expect(m.paidTotal).toBe(2n);
    expect(m.paidMarks).toBe(2);
    expect(m.paidEarlier).toBe(0n);
    expect(m.nowState.kind).toBe("paid-until");
    expect(m.nowState.carriedOver).toBe(false);
    expect(m.nowState.label).toContain("paid until");
    expect(m.nowState.label).not.toContain("carried over");
    // Remaining from day 60 to day 365: floor((305*DAY - 1) / (30*DAY)) + 1 = 10 + 1 = 11
    expect(m.possibleTotal).toBe(11n);
    expect(m.possibleMarks).toBe(11);
    expect(m.possibleMore).toBe(0n);
    expect(m.stoppedReason).toBeNull();
  });

  it("one missed period then a payment: paid marks stay 2 (never inferred from elapsed time)", () => {
    const period = 30n * DAY;
    // Payment 1 at day 0, missed day 30..60, payment 2 collected late at day 70 -> paidThrough day 100
    const now = BASE + 80n * DAY;
    const paidThrough = BASE + 100n * DAY;
    const expiresAt = BASE + 365n * DAY;
    const m = buildMandateTimeline({
      pulls: 2n,
      period,
      nextPullAt: paidThrough,
      paidThrough,
      expiresAt,
      now,
      status: "active",
    });
    expect(m.paidTotal).toBe(2n);
    expect(m.paidMarks).toBe(2);
    expect(m.nowState.kind).toBe("paid-until");
    // Remaining from day 100 to day 365: floor((265*DAY - 1) / (30*DAY)) + 1 = 8 + 1 = 9
    expect(m.possibleTotal).toBe(9n);
    expect(m.possibleMarks).toBe(9);
  });

  it("a 60-second plan collected every 5 minutes: paid marks equal 1 pull, caps possible marks at 12 with +more", () => {
    const period = MIN;
    // 10 minutes elapsed, only 1 payment taken at minute 10
    const now = BASE + 10n * MIN + 20n;
    const paidThrough = BASE + 11n * MIN;
    const expiresAt = BASE + 60n * MIN;
    const m = buildMandateTimeline({
      pulls: 1n,
      period,
      nextPullAt: paidThrough,
      paidThrough,
      expiresAt,
      now,
      status: "active",
    });
    expect(m.paidTotal).toBe(1n);
    expect(m.paidMarks).toBe(1);
    expect(m.nowState.kind).toBe("paid-until");
    // floor((49*60 - 1) / 60) + 1 = 48 + 1 = 49 possible
    expect(m.possibleTotal).toBe(49n);
    expect(m.possibleMarks).toBe(12);
    expect(m.possibleMore).toBe(37n);
  });

  it("carried-over time with no payment yet: notes carried over and never says 'none yet'", () => {
    const period = 30n * DAY;
    const now = BASE;
    const paidThrough = BASE + 15n * DAY;
    const expiresAt = BASE + 365n * DAY;
    const m = buildMandateTimeline({
      pulls: 0n,
      period,
      nextPullAt: paidThrough,
      paidThrough,
      expiresAt,
      now,
      status: "active",
    });
    expect(m.paidTotal).toBe(0n);
    expect(m.paidMarks).toBe(0);
    expect(m.paidSummary).not.toBe("none yet");
    expect(m.paidSummary).toContain("carried over");
    expect(m.nowState.kind).toBe("paid-until");
    expect(m.nowState.carriedOver).toBe(true);
    expect(m.nowState.label).toContain("paid until");
    expect(m.nowState.label).toContain("carried over");
    expect(m.summaryText).not.toContain("none yet");
  });

  it("carried-over time that has passed: keeps carried-over paidSummary, shows payment due (not carried over) now", () => {
    const period = 30n * DAY;
    const paidThrough = BASE + 15n * DAY;
    const now = BASE + 20n * DAY;
    const expiresAt = BASE + 365n * DAY;
    const m = buildMandateTimeline({
      pulls: 0n,
      period,
      nextPullAt: paidThrough,
      paidThrough,
      expiresAt,
      now,
      status: "active",
    });
    expect(m.paidSummary).toBe("0 payments on this mandate (time carried over)");
    expect(m.paidSummary).not.toBe("none yet");
    expect(m.nowState.kind).toBe("due");
    expect(m.nowState.label).toBe("payment due");
    expect(m.nowState.carriedOver).toBe(false);
    expect(isCarriedPeriodCurrent({ status: "active", pulls: 0n, paidThrough }, BASE + 10n * DAY)).toBe(true);
    expect(isCarriedPeriodCurrent({ status: "active", pulls: 0n, paidThrough }, now)).toBe(false);
  });

  it("active status when now >= expiresAt: treated as expired so it never shows payment due", () => {
    const period = 30n * DAY;
    const expiresAt = BASE + 90n * DAY;
    const now = expiresAt;
    const m = buildMandateTimeline({
      pulls: 1n,
      period,
      nextPullAt: BASE + 30n * DAY,
      paidThrough: BASE + 30n * DAY,
      expiresAt,
      now,
      status: "active",
    });
    expect(m.nowState.kind).toBe("inactive");
    expect(m.nowState.label).toBe("ended");
    expect(m.possibleTotal).toBe(0n);
    expect(m.stoppedReason).toContain("Ended");
  });

  it("a mandate that paid 3 times and was stopped: keeps 3 paid marks, 0 possible marks, and states why", () => {
    const period = 30n * DAY;
    const now = BASE + 100n * DAY;
    const m = buildMandateTimeline({
      pulls: 3n,
      period,
      nextPullAt: BASE + 90n * DAY,
      paidThrough: BASE + 90n * DAY,
      expiresAt: BASE + 365n * DAY,
      now,
      status: "stopped",
    });
    expect(m.paidTotal).toBe(3n);
    expect(m.paidMarks).toBe(3);
    expect(m.possibleTotal).toBe(0n);
    expect(m.possibleMarks).toBe(0);
    expect(m.stoppedReason).toContain("Stopped on chain");
    expect(m.summaryText).toContain("3 payments");
    expect(m.summaryText).toContain("Stopped on chain");
  });

  it("never paid: says 'none yet' and 'payment due' when active", () => {
    const period = 30n * DAY;
    const now = BASE;
    const m = buildMandateTimeline({
      pulls: 0n,
      period,
      nextPullAt: BASE,
      paidThrough: 0n,
      expiresAt: BASE + 365n * DAY,
      now,
      status: "active",
    });
    expect(m.paidSummary).toBe("none yet");
    expect(m.paidMarks).toBe(0);
    expect(m.nowState.kind).toBe("due");
    expect(m.nowState.label).toBe("payment due");
    expect(m.possibleTotal).toBe(13n);
    expect(m.possibleMarks).toBe(12);
    expect(m.possibleMore).toBe(1n);
    expect(m.summaryText).toContain("none yet");
    expect(m.summaryText).toContain("payment due");
  });

  it("expired: shows past payments, 0 possible marks, and explains why", () => {
    const period = 30n * DAY;
    const expiresAt = BASE + 90n * DAY;
    const now = expiresAt + 10n * DAY;
    const m = buildMandateTimeline({
      pulls: 8n,
      period,
      nextPullAt: expiresAt,
      paidThrough: expiresAt,
      expiresAt,
      now,
      status: "expired",
    });
    expect(m.paidTotal).toBe(8n);
    expect(m.paidMarks).toBe(6);
    expect(m.paidEarlier).toBe(2n);
    expect(m.possibleTotal).toBe(0n);
    expect(m.possibleMarks).toBe(0);
    expect(m.stoppedReason).toContain("Ended");
  });

  it("the last period before the end: exactly 1 payment still possible", () => {
    const period = 30n * DAY;
    const expiresAt = BASE + 365n * DAY;
    const now = expiresAt - 3600n; // 1 hour before end
    const m = buildMandateTimeline({
      pulls: 12n,
      period,
      nextPullAt: now,
      paidThrough: now,
      expiresAt,
      now,
      status: "active",
    });
    expect(m.possibleTotal).toBe(1n);
    expect(m.possibleMarks).toBe(1);
    expect(m.possibleMore).toBe(0n);
    expect(m.nowState.kind).toBe("due");
  });

  it("expiresAt equal to nextPullAt: 0 payments still possible", () => {
    const period = 30n * DAY;
    const expiresAt = BASE + 360n * DAY;
    const now = BASE + 340n * DAY;
    const m = buildMandateTimeline({
      pulls: 12n,
      period,
      nextPullAt: expiresAt,
      paidThrough: expiresAt,
      expiresAt,
      now,
      status: "active",
    });
    expect(m.nowState.kind).toBe("paid-until");
    expect(m.possibleTotal).toBe(0n);
    expect(m.possibleMarks).toBe(0);
    expect(m.summaryText).toContain("No more payments possible");
  });
});

describe("proportional scaling helpers", () => {
  it("scaleCapMeter draws normal ratios to scale and flags extreme ratios as not to scale", () => {
    // 1 GNOT price, 0.1 GNOT fee allowance -> 74.5% / 7.5% inside 82% band (to scale)
    const normal = scaleCapMeter(1_000_000n, 100_000n);
    expect(normal.notToScale).toBe(false);
    expect(normal.pricePct).toBeCloseTo(74.5, 1);
    expect(normal.feePct).toBeCloseTo(7.5, 1);

    // 0.001 GNOT price vs 0.1 GNOT fee -> clamped to sliver, flagged not to scale
    const tiny = scaleCapMeter(1_000n, 100_000n);
    expect(tiny.notToScale).toBe(true);
    expect(tiny.pricePct).toBe(2);

    // 1000 GNOT price vs 0.1 GNOT fee -> fee clamped to sliver, flagged not to scale
    const huge = scaleCapMeter(1_000_000_000n, 100_000n);
    expect(huge.notToScale).toBe(true);
    expect(huge.feePct).toBe(2);
  });

  it("scaleBarHeight draws normal ratios proportionally and flags clamped extremes", () => {
    const normal = scaleBarHeight(1_000_000n, 1_100_000n);
    expect(normal.notToScale).toBe(false);
    expect(normal.heightPct).toBeCloseTo(90.9, 1);

    const tiny = scaleBarHeight(1_000n, 101_000n);
    expect(tiny.notToScale).toBe(true);
    expect(tiny.heightPct).toBe(12);

    const huge = scaleBarHeight(1_000_000_000n, 1_000_100_000n);
    expect(huge.notToScale).toBe(true);
    expect(huge.heightPct).toBe(96);
  });
});
