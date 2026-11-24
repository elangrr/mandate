// Pure view-model helpers for mandate payment timelines and proportional
// meters. Kept in src/ui (no chain or wallet logic); driven strictly by the
// values the page already reads.

import { date, plural, thousands } from "../lib/format";

export const MAX_PAID_MARKS = 6;
export const MAX_POSSIBLE_MARKS = 12;

export type MandateTimelineStatus = "active" | "stopped" | "permission-expired" | "cancelled" | "expired";

export interface MandateTimelineInput {
  pulls: bigint;
  period: bigint;
  nextPullAt: bigint;
  paidThrough: bigint;
  expiresAt: bigint;
  now: bigint;
  status: MandateTimelineStatus;
  permissionExpiresAt?: bigint;
}

export type MandateNowState =
  | { kind: "paid-until"; carriedOver: boolean; label: string }
  | { kind: "due"; carriedOver: false; label: string }
  | { kind: "inactive"; carriedOver: false; label: string };

export interface MandateTimelineModel {
  paidTotal: bigint;
  paidMarks: number;
  paidEarlier: bigint;
  paidSummary: string;
  nowState: MandateNowState;
  possibleTotal: bigint;
  possibleMarks: number;
  possibleMore: bigint;
  stoppedReason: string | null;
  /** Plain-language summary of all three facts for assistive technology. */
  summaryText: string;
}

/**
 * Maximum number of payments still possible from `firstAllowed` (inclusive)
 * strictly before `expiresAt` (payments are refused from `expiresAt` on):
 *   0 if firstAllowed >= expiresAt,
 *   else floor((expiresAt - 1 - firstAllowed) / period) + 1.
 */
export function possiblePayments(firstAllowed: bigint, expiresAt: bigint, period: bigint): bigint {
  if (period <= 0n || firstAllowed >= expiresAt) return 0n;
  return (expiresAt - 1n - firstAllowed) / period + 1n;
}

function inactiveReason(status: Exclude<MandateTimelineStatus, "active">, expiresAt: bigint, permissionExpiresAt?: bigint): { short: string; reason: string } {
  switch (status) {
    case "stopped":
      return { short: "stopped on chain", reason: "Stopped on chain: the permission is gone, so no more payments can be taken." };
    case "permission-expired":
      return {
        short: "permission expired",
        reason:
          permissionExpiresAt && permissionExpiresAt > 0n
            ? `Permission expired on ${date(permissionExpiresAt)}: no more payments can be taken.`
            : "Permission expired: no more payments can be taken.",
      };
    case "cancelled":
      return { short: "cancelled", reason: "Cancelled: no more payments can be taken." };
    case "expired":
      return { short: "ended", reason: `Ended on ${date(expiresAt)}: no more payments can be taken.` };
  }
}

/** Whether a mandate's current period is still covered by carried-over time. */
export function isCarriedPeriodCurrent(m: { status: string; pulls: bigint; paidThrough: bigint }, now: bigint): boolean {
  return m.status === "active" && m.pulls === 0n && m.paidThrough > 0n && now < m.paidThrough;
}

/**
 * Facts-only view of a mandate:
 * 1. Payments made = exact `pulls` (at most 6 marks + "+N earlier"). Never inferred from dates.
 * 2. Now = "paid until <date>" (noting "carried over" when pulls == 0), or "payment due" when active, or inactive state.
 * 3. Still possible before end = only when active; 0 and a reason when stopped/cancelled/expired.
 */
export function buildMandateTimeline(input: MandateTimelineInput): MandateTimelineModel {
  const { pulls, period, nextPullAt, paidThrough, expiresAt, now, status, permissionExpiresAt } = input;
  const effectiveStatus: MandateTimelineStatus = status === "active" && now >= expiresAt ? "expired" : status;
  const safePulls = pulls < 0n ? 0n : pulls;
  const paidMarks = safePulls > BigInt(MAX_PAID_MARKS) ? MAX_PAID_MARKS : Number(safePulls);
  const paidEarlier = safePulls > BigInt(MAX_PAID_MARKS) ? safePulls - BigInt(MAX_PAID_MARKS) : 0n;
  const hasCarriedOver = safePulls === 0n && paidThrough > 0n;

  let paidSummary: string;
  if (safePulls === 0n && !hasCarriedOver) {
    paidSummary = "none yet";
  } else if (safePulls === 0n && hasCarriedOver) {
    paidSummary = "0 payments on this mandate (time carried over)";
  } else {
    paidSummary = `${thousands(safePulls)} ${safePulls === 1n ? "payment" : "payments"}`;
  }

  let nowState: MandateNowState;
  if (now < paidThrough) {
    nowState = {
      kind: "paid-until",
      carriedOver: safePulls === 0n,
      label: safePulls === 0n ? `paid until ${date(paidThrough)} (carried over)` : `paid until ${date(paidThrough)}`,
    };
  } else if (effectiveStatus === "active") {
    nowState = { kind: "due", carriedOver: false, label: "payment due" };
  } else {
    const info = inactiveReason(effectiveStatus, expiresAt, permissionExpiresAt);
    nowState = { kind: "inactive", carriedOver: false, label: info.short };
  }

  let possibleTotal = 0n;
  let stoppedReason: string | null = null;
  if (effectiveStatus === "active") {
    const firstAllowed = now > nextPullAt ? now : nextPullAt;
    possibleTotal = possiblePayments(firstAllowed, expiresAt, period);
  } else {
    stoppedReason = inactiveReason(effectiveStatus, expiresAt, permissionExpiresAt).reason;
  }

  const possibleMarks = possibleTotal > BigInt(MAX_POSSIBLE_MARKS) ? MAX_POSSIBLE_MARKS : Number(possibleTotal);
  const possibleMore = possibleTotal > BigInt(MAX_POSSIBLE_MARKS) ? possibleTotal - BigInt(MAX_POSSIBLE_MARKS) : 0n;

  const possibleSentence =
    effectiveStatus !== "active"
      ? stoppedReason!
      : possibleTotal === 0n
        ? `No more payments possible before ${date(expiresAt)}.`
        : `Up to ${plural(Number(possibleTotal > 1_000_000n ? 1_000_000n : possibleTotal), "payment").replace(/^1,000,000/, thousands(possibleTotal))} still possible before ${date(expiresAt)}.`;

  const summaryText = `Payments made: ${paidSummary}. Now: ${nowState.label}. ${possibleSentence}`;

  return {
    paidTotal: safePulls,
    paidMarks,
    paidEarlier,
    paidSummary,
    nowState,
    possibleTotal,
    possibleMarks,
    possibleMore,
    stoppedReason,
    summaryText,
  };
}

export interface CapMeterScale {
  pricePct: number;
  feePct: number;
  beyondPct: number;
  notToScale: boolean;
}

const MIN_CAP_SLIVER = 2; // % of full track width

/**
 * Proportional widths for CapMeter (price + fee allowance inside `capBand`%,
 * beyond-cap refused zone in the remaining `100 - capBand`%).
 * Applies a minimum visible sliver only when a segment would disappear, and
 * flags `notToScale: true` whenever clamping was needed.
 */
export function scaleCapMeter(amount: bigint, feeAllowance: bigint, capBand = 82): CapMeterScale {
  const cap = amount + feeAllowance;
  const beyondPct = 100 - capBand;
  if (cap <= 0n) return { pricePct: capBand, feePct: 0, beyondPct, notToScale: true };
  const rawPrice = (Number((amount * 10_000n) / cap) / 10_000) * capBand;
  const rawFee = capBand - rawPrice;

  let pricePct = rawPrice;
  let feePct = rawFee;
  let notToScale = false;

  if (amount > 0n && rawPrice < MIN_CAP_SLIVER) {
    pricePct = MIN_CAP_SLIVER;
    feePct = capBand - MIN_CAP_SLIVER;
    notToScale = true;
  } else if (feeAllowance > 0n && rawFee < MIN_CAP_SLIVER) {
    feePct = MIN_CAP_SLIVER;
    pricePct = capBand - MIN_CAP_SLIVER;
    notToScale = true;
  }

  return {
    pricePct: Math.round(pricePct * 10) / 10,
    feePct: Math.round(feePct * 10) / 10,
    beyondPct,
    notToScale,
  };
}

export interface BarHeightScale {
  heightPct: number;
  notToScale: boolean;
}

const MIN_BAR_HEIGHT = 12;
const MAX_BAR_HEIGHT = 96;

/** Proportional bar height (amount / cap * 100%), flagging `notToScale` when clamped to stay visible below the cap line. */
export function scaleBarHeight(amount: bigint, cap: bigint): BarHeightScale {
  if (cap <= 0n) return { heightPct: MIN_BAR_HEIGHT, notToScale: true };
  const rawPct = Number((amount * 1000n) / cap) / 10;
  if (amount > 0n && rawPct < MIN_BAR_HEIGHT) return { heightPct: MIN_BAR_HEIGHT, notToScale: true };
  if (rawPct > MAX_BAR_HEIGHT) return { heightPct: MAX_BAR_HEIGHT, notToScale: true };
  return { heightPct: Math.round(rawPct * 10) / 10, notToScale: false };
}
