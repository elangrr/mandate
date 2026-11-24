// What subscribing and stopping take, decided from the chain before any
// wallet popup opens. A half-finished subscription (a permission without a
// mandate) or a half-finished stop shows up here as a state to finish or
// undo, so every failure path ends in a state the page can explain.

import { rules } from "../config";
import type { Mandate, Payee, Plan } from "./amino";
import { gnot } from "./format";
import type { SessionEntry } from "./rpc";
import { allowPath, capFor, defaultEnd, GAS, minFee } from "./tx";

/** About what a first mandate stores (measured on a local chain: 5,367 bytes at 100 ugnot a byte). */
export const FIRST_DEPOSIT_UGNOT = 540_000n;
/** About what a later mandate stores (1,844 bytes). */
export const LATER_DEPOSIT_UGNOT = 190_000n;

export interface ChainView {
  now: bigint;
  plan: Plan;
  payee: Payee | null;
  collectorIsAccount: boolean;
  mandates: Mandate[]; // the supporter's, newest first
  sessions: SessionEntry[]; // the supporter's permissions on chain
  paidThrough: bigint; // PaidThrough(supporter, plan)
  balance: bigint; // ugnot
  gasPrice: { gas: bigint; amount: bigint };
}

export type SubscribeState =
  | { kind: "blocked"; title: string; reason: string }
  /** permission: false when the mandate's permission is gone or expired on chain, so nothing can be paid */
  | { kind: "already"; mandate: Mandate; permission: boolean }
  | { kind: "fix-permission"; session: SessionEntry; reason: string }
  | {
      kind: "ready";
      /** true: the permission already exists with the right terms; only the mandate is left to record */
      resume: boolean;
      session: SessionEntry | null;
      end: bigint;
      cap: bigint;
      paidThrough: bigint; // > now: the first payment waits until then
      deposit: bigint; // approximate storage deposit
      fees: bigint; // approximate network fees for the approvals
    };

function isActive(m: Mandate, now: bigint): boolean {
  return m.status === "active" && m.expiresAt > now;
}

/** Whether an existing permission already has exactly the terms the plan needs. */
export function permissionFits(s: SessionEntry, plan: Plan, now: bigint): string | null {
  if (s.allowPaths.length !== 1 || s.allowPaths[0] !== allowPath()) return "it is not limited to Mandate alone";
  if (s.spendPeriod !== plan.period) return `its period (${s.spendPeriod.toString()} s) is not the plan's`;
  if (s.spendLimit !== capFor(plan)) return `its cap (${gnot(s.spendLimit)} GNOT) is not the plan's ${gnot(capFor(plan))} GNOT`;
  if (s.expiresAt !== 0n && s.expiresAt <= now + 86400n) return "it ends within a day";
  return null;
}

export function subscribeState(v: ChainView): SubscribeState {
  const { plan, payee, now } = v;
  if (!payee?.collectorKey || !payee.collectorAddr)
    return { kind: "blocked", title: "Nobody can subscribe yet", reason: "The creator has not published a collector key." };
  if (payee.collectorFunded || v.collectorIsAccount)
    return {
      kind: "blocked",
      title: "New supporters cannot join right now",
      reason:
        "The creator’s collector key has received coins, which makes its address an account, and the chain refuses a permission for such a key. The creator must publish a new collector key.",
    };
  const active = v.mandates.filter((m) => isActive(m, now));
  const here = active.find((m) => m.planId === plan.id);
  if (here) {
    const p = v.sessions.find((s) => s.address === here.session);
    return { kind: "already", mandate: here, permission: !!p && (p.expiresAt === 0n || p.expiresAt > now) };
  }

  const key = payee.collectorAddr;
  const session = v.sessions.find((s) => s.address === key) ?? null;
  if (session) {
    const other = active.find((m) => m.session === key);
    if (other)
      return {
        kind: "blocked",
        title: "One plan per creator",
        reason: `You already support plan #${other.planId} of this creator. Every plan of a creator is collected by the same key, and the chain allows one permission per key, so stop that mandate first to switch.`,
      };
    const misfit = permissionFits(session, plan, now);
    if (misfit) return { kind: "fix-permission", session, reason: `You already gave this creator’s collector key a permission, but ${misfit}. Remove it first, then subscribe.` };
  } else {
    if (v.sessions.length >= rules.maxActive)
      return { kind: "blocked", title: "Your wallet is full", reason: `Your wallet already holds the ${rules.maxActive} permissions the chain allows. Stop a mandate you no longer need first.` };
  }
  if (active.length >= rules.maxActive)
    return { kind: "blocked", title: "Your wallet is full", reason: `You already hold ${rules.maxActive} active mandates, the most a wallet can. Stop one you no longer need first.` };

  const end = session && session.expiresAt > now + 86400n && session.expiresAt <= now + BigInt(rules.maxTermDays) * 86400n ? session.expiresAt : defaultEnd(now);
  const deposit = v.mandates.length === 0 ? FIRST_DEPOSIT_UGNOT : LATER_DEPOSIT_UGNOT;
  const fees = BigInt(session ? 0 : Math.ceil(minFee(GAS.session, v.gasPrice) * 1.5)) + BigInt(minFee(25_000_000, v.gasPrice)); // a Subscribe signs about 10M to 25M gas
  if (v.balance < deposit + fees)
    return {
      kind: "blocked",
      title: "Not enough GNOT",
      reason: `Subscribing needs about ${gnot(deposit + fees)} GNOT for the storage deposit and network fees; this wallet has ${gnot(v.balance)} GNOT. The first payment of ${gnot(plan.amount)} GNOT is taken later.`,
    };
  return { kind: "ready", resume: session !== null, session, end, cap: capFor(plan), paidThrough: v.paidThrough > now ? v.paidThrough : 0n, deposit, fees };
}

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
