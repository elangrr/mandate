// A step that went to the wallet and is not on chain yet. It is kept in
// sessionStorage (this tab only) so that the warning "do not approve it
// again" survives a network switch, a locked wallet, leaving the page and a
// reload. It is dropped once the chain shows the step's result, when the
// connected wallet is another account, or when the person chooses to see the
// options again.

import { useSyncExternalStore } from "react";
import type { Mandate } from "./amino";
import { read, type SessionEntry } from "./rpc";
import { allowPath } from "./tx";

/** How to see on chain that the step happened; plain data, so it can be stored. */
export type PendingCheck =
  | { kind: "permission"; key: string; period: string; cap: string }
  | { kind: "mandate"; key: string; planId: string }
  | { kind: "permission-gone"; key: string }
  | { kind: "cancelled"; key: string; mandateId: string }
  | { kind: "gone-and-cancelled"; key: string; mandateId: string }
  /** a plan by this creator with exactly these terms, published at or after `after` (chain time before sending) */
  | { kind: "plan"; key: string; title: string; amount: string; period: string; after: string }
  /** the creator's published collector key is this one; `key` is the creator's address */
  | { kind: "collector-key"; key: string; gpub: string };

export interface Pending {
  payer: string;
  label: string;
  /** the transaction hash, when the wallet gave one: then it is known to have been sent */
  hash: string | null;
  check: PendingCheck;
  tries: number;
}

const KEY = "mandate.pending.v1";
let memory: Record<string, Pending> = {};
const listeners = new Set<() => void>();
let snapshot: Record<string, Pending> = load();

function storage(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

function valid(p: any): p is Pending {
  return (
    p &&
    typeof p.payer === "string" &&
    typeof p.label === "string" &&
    (p.hash === null || typeof p.hash === "string") &&
    typeof p.tries === "number" &&
    p.check &&
    typeof p.check.kind === "string" &&
    typeof p.check.key === "string"
  );
}

function load(): Record<string, Pending> {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return memory;
    const d = JSON.parse(raw);
    const out: Record<string, Pending> = {};
    for (const [k, v] of Object.entries(d ?? {})) if (valid(v)) out[k] = v;
    return out;
  } catch {
    return memory;
  }
}

function save(next: Record<string, Pending>) {
  memory = next;
  snapshot = next;
  try {
    storage()?.setItem(KEY, JSON.stringify(next));
  } catch {
    /* memory only */
  }
  for (const l of listeners) l();
}

export function setPending(p: Pending) {
  save({ ...snapshot, [p.payer]: p });
}

export function clearPending(payer: string) {
  if (!snapshot[payer]) return;
  const next = { ...snapshot };
  delete next[payer];
  save(next);
}

export function allPending(): Pending[] {
  return Object.values(snapshot);
}

export function getPending(payer: string): Pending | null {
  return snapshot[payer] ?? null;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Every pending step (normally one), re-rendering when it changes. */
export function usePendingAll(): Pending[] {
  const s = useSyncExternalStore(subscribe, () => snapshot);
  return Object.values(s);
}

/** The pending step of one wallet, if any. */
export function usePending(payer: string): Pending | null {
  const s = useSyncExternalStore(subscribe, () => snapshot);
  return s[payer] ?? null;
}

function alive(s: SessionEntry, now: bigint) {
  return s.expiresAt === 0n || s.expiresAt > now;
}

function active(m: Mandate | null, now: bigint) {
  return !!m && m.status === "active" && m.cancelledAt === 0n && m.expiresAt > now;
}

/** Reads the chain: is the step's result there? */
export async function onChain(payer: string, c: PendingCheck): Promise<boolean> {
  const now = await read.chainTime();
  switch (c.kind) {
    case "permission": {
      const s = (await read.sessions(payer)).find((x) => x.address === c.key);
      return (
        !!s &&
        alive(s, now) &&
        s.allowPaths.length === 1 &&
        s.allowPaths[0] === allowPath() &&
        s.spendPeriod.toString() === c.period &&
        s.spendLimit.toString() === c.cap
      );
    }
    case "mandate": {
      const m = await read.mandateOf(payer, c.key);
      return !!m && m.planId.toString() === c.planId && active(m, now);
    }
    case "permission-gone":
      return !(await read.sessions(payer)).some((x) => x.address === c.key);
    case "cancelled": {
      const m = await read.mandateOf(payer, c.key);
      return !m || m.id.toString() !== c.mandateId || !active(m, now);
    }
    case "plan": {
      // the newest plans come last; a creator rarely has more than a page, but walk them all (bounded)
      for (let page = 1; page <= 50; page++) {
        const list = await read.plansOf(c.key, page);
        if (list.some((p) => p.title === c.title && p.amount.toString() === c.amount && p.period.toString() === c.period && p.createdAt >= BigInt(c.after))) return true;
        if (list.length < 20) return false;
      }
      return false;
    }
    case "collector-key":
      return (await read.payee(c.key))?.collectorKey === c.gpub;
    case "gone-and-cancelled":
      return (await onChain(payer, { kind: "permission-gone", key: c.key })) && (await onChain(payer, { kind: "cancelled", key: c.key, mandateId: c.mandateId }));
  }
}
