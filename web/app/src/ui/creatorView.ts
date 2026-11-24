// Pure view functions for the creator screens (Publish, Creator): what the
// form says about its inputs, the plan preview, and the collector key's state.
// Tested in creatorView.test.ts. Truth rule (DESIGN.md): every label states
// only what the page knows.

import { rules } from "../config";
import type { Payee } from "../lib/amino";
import { amountProblem, parseGnot, parsePeriod, periodProblem, titleProblem, type OfferInput, type PeriodUnit } from "../lib/creator";
import type { PendingCheck } from "../lib/pending";
import { minFee } from "../lib/tx";

export interface PlanForm {
  title: string;
  price: string;
  count: string;
  unit: PeriodUnit;
}

export interface PlanFormRead {
  errors: { title?: string; price?: string; period?: string };
  /** set only when every field is valid */
  offer: OfferInput | null;
  /** what can be previewed so far (null parts are not valid yet) */
  amount: bigint | null;
  period: bigint | null;
  chars: number;
}

/** Reads the plan form with the realm's rules. */
export function readPlanForm(f: PlanForm): PlanFormRead {
  const amount = parseGnot(f.price);
  const period = parsePeriod(f.count, f.unit);
  const errors: PlanFormRead["errors"] = {};
  const t = titleProblem(f.title);
  if (t) errors.title = t;
  const a = amountProblem(amount);
  if (a) errors.price = a;
  const p = periodProblem(period);
  if (p) errors.period = p;
  const ok = !errors.title && !errors.price && !errors.period;
  return {
    errors,
    offer: ok ? { title: f.title, amount: amount!, period: period! } : null,
    amount: a ? null : amount,
    period: p ? null : period,
    chars: [...f.title].length,
  };
}

/** The cap a supporter gives for this plan: the price plus the fee allowance. */
export function capOf(amount: bigint): bigint {
  return amount + rules.feeAllowanceUgnot;
}

/** About what one approval costs in network fees at today's gas price, from the measured gas plus Adena's 10% margin. */
export function feeEstimate(gas: number, price: { gas: bigint; amount: bigint }): bigint {
  return BigInt(minFee(Math.ceil((gas * 11) / 10), price));
}

export type KeyState =
  | { kind: "none"; tone: "off"; label: "Not published"; note: string }
  | { kind: "blocked"; tone: "warn"; label: "Blocked"; note: string }
  | { kind: "ready"; tone: "ok"; label: "Ready"; note: string };

/** The collector key's state as the chain shows it: none, ready, or blocked (its address became an account). */
export function keyState(info: Pick<Payee, "collectorKey" | "collectorFunded"> | null, isAccount: boolean): KeyState {
  if (!info?.collectorKey) return { kind: "none", tone: "off", label: "Not published", note: "Not published yet: nobody can subscribe until it is." };
  if (info.collectorFunded || isAccount)
    return {
      kind: "blocked",
      tone: "warn",
      label: "Blocked",
      note: "This key’s address has received coins, so the chain refuses new permissions for it: nobody new can subscribe until the creator publishes a new collector key. Existing mandates keep being collected with this one until they end.",
    };
  return { kind: "ready", tone: "ok", label: "Ready", note: "Supporters give this key their permission. It must never receive coins." };
}

/**
 * What a Publish panel's button says while it cannot be used: its own step on
 * its way, the other panel's, or a step from elsewhere (subscribing,
 * stopping) that the warning at the top of the page is about.
 * `pending`: the kind of the wallet's step that is not on chain yet; `active`: the panel whose approval is running.
 */
export function waitLabel(panel: "key" | "plan", pending: PendingCheck["kind"] | null, active: "key" | "plan" | null): string {
  const owner = pending ? (pending === "collector-key" ? "key" : pending === "plan" ? "plan" : null) : active;
  if (owner === panel) return "Waiting for this step to reach the chain…";
  if (owner === null) return "Waiting for the step at the top of the page…";
  return "Waiting for the other step…";
}
