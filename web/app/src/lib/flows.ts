// What subscribing and stopping take, decided from the chain before any
// wallet popup opens. A half-finished subscription (a permission without a
// mandate) or a half-finished stop shows up here as a state to finish or
// undo, so every failure path ends in a state the page can explain.
//
// Every decision uses direct reads (MandateOf for the creator's collector key,
// HasMandate for the plan, the wallet's permission list), never only the
// first pages of a wallet's history.

import { rules } from "../config";
import type { Mandate, Payee, Plan } from "./amino";
import { date, gnot, period } from "./format";
import type { SessionEntry } from "./rpc";
import { allowPath, capFor, defaultEnd, GAS, minFee } from "./tx";

// Storage deposits, from the latest measurement (M1.5 in docs/design.md) at the chain's storage price of
// 100 ugnot a byte (params/vm:p:storage_price on Onyx). The balance check sets each one aside rounded up.
/** A wallet's first mandate: 5,367 bytes = 536,700 ugnot; shown as about 0.54 GNOT, and set aside as that. */
export const FIRST_DEPOSIT_UGNOT = 540_000n;
/** Each later mandate: 1,844 bytes = 184,400 ugnot; shown as about 0.18 GNOT. */
export const LATER_DEPOSIT_UGNOT = 180_000n;
/** What the balance check sets aside for a later mandate: the measured 184,400 ugnot rounded up, as for the first. */
export const LATER_DEPOSIT_SET_ASIDE_UGNOT = 190_000n;

const DAY = 86_400n;

export interface ChainView {
  /** the connected wallet: the supporter-to-be */
  payer: string;
  now: bigint;
  plan: Plan;
  payee: Payee | null;
  /** the published collector key cannot be used: not a secp256k1 key, or its address is not the one published */
  keyProblem: "not-secp256k1" | "mismatch" | null;
  collectorIsAccount: boolean;
  /** MandateOf(payer, collector address): the latest mandate for this key, active or not */
  byKey: Mandate | null;
  /** HasMandate(payer, plan) */
  hasForPlan: boolean;
  /** the active mandate for this plan when it uses another key (an older collector key), if found */
  planMandate: Mandate | null;
  /** active mandates in the realm; null when the wallet's history was too long to count */
  activeCount: number | null;
  /** whether the wallet ever recorded a mandate (the storage deposit is larger the first time) */
  hasHistory: boolean;
  sessions: SessionEntry[]; // the supporter's permissions on chain
  paidThrough: bigint; // PaidThrough(supporter, plan)
  balance: bigint; // ugnot
  gasPrice: { gas: bigint; amount: bigint };
}

export type SubscribeState =
  | { kind: "blocked"; title: string; reason: string }
  /** permission: false when the mandate's permission is gone or expired on chain, so nothing can be paid; null when unknown */
  | { kind: "already"; mandate: Mandate | null; permission: boolean | null }
  | { kind: "fix-permission"; session: SessionEntry; reason: string }
  | {
      kind: "ready";
      /** true: the permission already exists with the right terms; only the mandate is left to record */
      resume: boolean;
      session: SessionEntry | null;
      /** the earlier mandate (cancelled or ended) the existing permission was given for, if any */
      leftover: Mandate | null;
      end: bigint;
      cap: bigint;
      paidThrough: bigint; // > now: the first payment waits until then; 0: due at once
      deposit: bigint; // the storage deposit the balance checks set aside (rounded up)
      depositShown: bigint; // the approximate storage deposit the page states
      fees: bigint; // approximate network fees for the approvals
      /** the wallet covers the deposit and fees but not also the first payment and the fee allowance */
      lowBalance: boolean;
    };

export function isActive(m: Mandate, now: bigint): boolean {
  return m.status === "active" && m.cancelledAt === 0n && m.expiresAt > now;
}

function alive(s: SessionEntry | undefined, now: bigint): boolean {
  return !!s && (s.expiresAt === 0n || s.expiresAt > now);
}

/** Whether an existing permission already has exactly the terms the plan needs. */
export function permissionFits(s: SessionEntry, plan: Plan, now: bigint): string | null {
  if (s.allowPaths.length !== 1 || s.allowPaths[0] !== allowPath()) return "it is not limited to Mandate alone";
  if (s.spendPeriod !== plan.period) return `its period (${s.spendPeriod.toString()} s) is not the plan's`;
  if (s.spendLimit !== capFor(plan)) return `its cap (${gnot(s.spendLimit)} GNOT) is not the plan's ${gnot(capFor(plan))} GNOT`;
  if (s.expiresAt !== 0n && s.expiresAt <= now) return "it has expired";
  if (s.expiresAt !== 0n && s.expiresAt <= now + DAY) return "it ends within a day";
  if (s.expiresAt > now + BigInt(rules.maxTermDays) * DAY) return "it ends later than a mandate may";
  return null;
}

export function subscribeState(v: ChainView): SubscribeState {
  const { plan, payee, now } = v;
  // the realm refuses it ("you cannot subscribe to your own plan"): never let the first approval go out
  if (v.payer === plan.payee)
    return {
      kind: "blocked",
      title: "This is your own plan",
      reason: "Mandate does not let a creator subscribe to their own plan, so there is nothing to sign here. Supporters subscribe from their own wallets.",
    };
  if (!payee?.collectorKey || !payee.collectorAddr)
    return { kind: "blocked", title: "Nobody can subscribe yet", reason: "The creator has not published a collector key." };
  if (v.keyProblem)
    return {
      kind: "blocked",
      title: "Nobody can subscribe right now",
      reason:
        v.keyProblem === "not-secp256k1"
          ? "The creator’s collector key is not a kind of key this page can give a permission to. The creator must publish a new collector key."
          : "The creator’s collector key does not match the collector address published with it. The creator must publish the key again.",
    };
  if (payee.collectorFunded || v.collectorIsAccount)
    return {
      kind: "blocked",
      title: "New supporters cannot join right now",
      reason:
        "The creator’s collector key has received coins, which makes its address an account, and the chain refuses a permission for such a key. The creator must publish a new collector key.",
    };

  const key = payee.collectorAddr;
  const session = v.sessions.find((s) => s.address === key) ?? null;
  const byKeyActive = v.byKey && isActive(v.byKey, now) ? v.byKey : null;
  if (byKeyActive && byKeyActive.planId === plan.id) return { kind: "already", mandate: byKeyActive, permission: alive(session ?? undefined, now) };
  if (v.hasForPlan) {
    const m = v.planMandate;
    return { kind: "already", mandate: m, permission: m ? alive(v.sessions.find((s) => s.address === m.session), now) : null };
  }
  if (byKeyActive)
    return {
      kind: "blocked",
      title: "One plan per creator",
      reason: `You already support plan #${byKeyActive.planId} of this creator. Every plan of a creator is collected by the same key, and the chain allows one permission per key, so stop that mandate first to switch.`,
    };

  if (session) {
    const misfit = permissionFits(session, plan, now);
    if (misfit)
      return {
        kind: "fix-permission",
        session,
        reason: `Your wallet already gave this creator’s collector key a permission${v.byKey ? ", left from an earlier mandate" : ""}, but ${misfit}. Remove it first, then subscribe.`,
      };
  } else if (v.sessions.length >= rules.maxActive) {
    return {
      kind: "blocked",
      title: "Your wallet is full",
      reason: `Your wallet already holds the ${rules.maxActive} permissions the chain allows. Permissions given to other apps and ones that have expired count too. Remove one you no longer need, in Adena or from your mandates here, then come back.`,
    };
  }
  if (v.activeCount !== null && v.activeCount >= rules.maxActive)
    return { kind: "blocked", title: "Your wallet is full", reason: `You already hold ${rules.maxActive} active mandates, the most a wallet can. Stop one you no longer need first.` };

  const end = session && session.expiresAt !== 0n ? session.expiresAt : defaultEnd(now);
  const deposit = v.hasHistory ? LATER_DEPOSIT_SET_ASIDE_UGNOT : FIRST_DEPOSIT_UGNOT;
  const fees = BigInt(session ? 0 : Math.ceil(minFee(GAS.session, v.gasPrice) * 1.5)) + BigInt(minFee(25_000_000, v.gasPrice)); // a Subscribe signs about 10M to 25M gas
  const paidThrough = v.paidThrough > now ? v.paidThrough : 0n;
  if (v.balance < deposit + fees)
    return {
      kind: "blocked",
      title: "Not enough GNOT",
      reason: `Subscribing needs about ${gnot(deposit + fees)} GNOT for the storage deposit and network fees; this wallet has ${gnot(v.balance)} GNOT.`,
    };
  if (session && paidThrough > 0n && end <= paidThrough)
    return {
      kind: "fix-permission",
      session,
      reason: "You already paid for this plan until after this permission ends, so a mandate on it could never take a payment. Remove the permission, then subscribe again.",
    };
  const firstPayment = paidThrough > 0n ? 0n : plan.amount + rules.feeAllowanceUgnot;
  return {
    kind: "ready",
    resume: session !== null,
    session,
    // a permission given for an earlier mandate ends when that mandate ended (the page signs one end date for both);
    // a permission from a subscription started and not finished does not
    leftover: session && v.byKey && !isActive(v.byKey, now) && session.expiresAt === v.byKey.expiresAt ? v.byKey : null,
    end,
    cap: capFor(plan),
    paidThrough,
    deposit,
    depositShown: v.hasHistory ? LATER_DEPOSIT_UGNOT : FIRST_DEPOSIT_UGNOT,
    fees,
    lowBalance: v.balance < deposit + fees + firstPayment,
  };
}

/** What the permission was signed with in approval 1 of 2, to compare with the chain before approval 2. */
export interface SignedPermission {
  amount: bigint;
  period: bigint;
  collectorKey: string;
  collectorAddr: string;
  end: bigint;
}

/**
 * The last check before recording the terms (approval 2 of 2), from a fresh
 * read: the plan, the collector key, the permission just given (still there,
 * with the end date signed) and the wallet's mandates are as they were. A
 * sentence when something changed (then nothing is sent).
 */
export function termsCheck(v: ChainView, signed: SignedPermission): string | null {
  if (v.plan.amount !== signed.amount || v.plan.period !== signed.period) return "The plan’s price or period changed.";
  if (v.payee?.collectorKey !== signed.collectorKey || v.payee?.collectorAddr !== signed.collectorAddr) return "The creator’s collector key changed.";
  if (v.byKey && isActive(v.byKey, v.now)) return "A mandate now uses this permission.";
  if (v.hasForPlan) return "A mandate for this plan is now recorded.";
  const s = v.sessions.find((x) => x.address === signed.collectorAddr);
  if (!s) return "Your permission for the creator’s collector key is gone.";
  if (!alive(s, v.now)) return "Your permission for the creator’s collector key has expired.";
  if (s.expiresAt !== signed.end || permissionFits(s, v.plan, v.now)) return "Your permission for the creator’s collector key no longer has the terms you signed.";
  if (v.activeCount !== null && v.activeCount >= rules.maxActive) return `You now hold ${rules.maxActive} active mandates, the most a wallet can.`;
  return null;
}

/**
 * What a permission for Mandate without an active mandate still allows, in plain words (`now`: the chain's time).
 * `own`: the wallet that gave it is the connected one, so the words may say "yours".
 */
export function permissionAllows(s: SessionEntry, now: bigint, own = true): string {
  if (s.expiresAt !== 0n && s.expiresAt <= now)
    return `This permission expired on ${date(s.expiresAt)}: nobody can use it any more. It is still listed on chain, though, and takes one of the ${rules.maxActive} permissions this wallet can hold until it is removed.`;
  const still = `This permission is still on chain${s.expiresAt > 0n ? ` until ${date(s.expiresAt)}` : ""}. No payment can go through without an active mandate, but whoever holds its key (a creator’s collector) can still use it to call Mandate for this wallet and spend up to ${gnot(s.spendLimit)} GNOT`;
  return own
    ? `${still} every ${period(s.spendPeriod)} of yours on the network fees of those calls. Remove it unless you plan to subscribe again soon.`
    : `${still} from this wallet every ${period(s.spendPeriod)} on the network fees of those calls.`;
}

/** What the page shows for a mandate's stop controls (from the page's own reads). */
export type StopState =
  | { kind: "nothing"; reason: string }
  | {
      kind: "ready";
      /** the permission on chain, to revoke; null if it is already gone */
      session: SessionEntry | null;
      /** true while the realm still lists the mandate as active, so Cancel is still needed */
      cancel: boolean;
    };

/** What stopping a mandate takes: revoke the permission (stops payments at once), then cancel it in the realm. */
export function stopState(m: Mandate, all: Mandate[], sessions: SessionEntry[], now: bigint): StopState {
  const cancel = m.status === "active" && m.cancelledAt === 0n;
  // a permission another active mandate still uses is not this mandate's to remove
  const sharedWith = all.find((o) => o.id !== m.id && o.session === m.session && isActive(o, now));
  const session = sharedWith ? null : (sessions.find((s) => s.address === m.session) ?? null);
  if (!cancel && !session) return { kind: "nothing", reason: "This mandate is already stopped and its permission is gone." };
  return { kind: "ready", session, cancel };
}

/** What the chain says right before a stop or a removal (read afresh). */
export interface FreshKey {
  now: bigint;
  /** MandateOf(payer, key) */
  byKey: Mandate | null;
  sessions: SessionEntry[];
}

export type StopCheck = { kind: "go"; revoke: SessionEntry | null; cancel: boolean } | { kind: "changed"; reason: string };

/**
 * The last check before signing a stop: act only on what the page shows.
 * Cancel only the mandate shown (same id); remove the permission only when
 * no active mandate uses it, or when it is this mandate's own.
 * `intent`: "stop" (the page shows the mandate as active) or "tidy" (remove a leftover permission).
 */
export function stopCheck(m: Mandate, fresh: FreshKey, intent: "stop" | "tidy"): StopCheck {
  const session = fresh.sessions.find((s) => s.address === m.session) ?? null;
  const active = fresh.byKey && isActive(fresh.byKey, fresh.now) ? fresh.byKey : null;
  if (active && active.id !== m.id)
    return { kind: "changed", reason: `Another of your mandates (plan #${active.planId}) now uses this permission, so it was left in place.` };
  const cancel = active !== null; // it is this mandate
  if (intent === "stop" && !cancel)
    return {
      kind: "changed",
      reason: session ? "This mandate was already cancelled or has ended; only its leftover permission is left to remove." : "This mandate was already stopped.",
    };
  if (intent === "tidy" && cancel) return { kind: "changed", reason: "This mandate is active, so its permission was left in place." };
  if (!session && !cancel) return { kind: "changed", reason: "The permission is already gone." };
  return { kind: "go", revoke: session, cancel };
}

/** The last check before removing a permission from the plan page (undo, or a permission with the wrong terms). */
export function removeCheck(key: string, fresh: FreshKey): string | null {
  if (fresh.byKey && isActive(fresh.byKey, fresh.now)) return `A mandate (plan #${fresh.byKey.planId}) now uses this permission, so it was left in place.`;
  if (!fresh.sessions.some((s) => s.address === key)) return "The permission is already gone.";
  return null;
}
