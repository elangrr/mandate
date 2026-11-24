// What a creator signs: publishing a plan (Offer) and publishing or replacing
// the collector key (SetCollectorKey). Every input is checked here with the
// realm's own rules (r/mandate/mandate.gno: validateTitle, MinAmount,
// MaxAmount, MinPeriod, MaxPeriod, SetCollectorKey) before a wallet ever
// sees it, so a refusal is explained on the page and never costs a fee.
// The app never asks for, makes or handles a private key, password or seed.

import { config, rules } from "../config";
import { addressOf, pubFromGpub, TxError, type MsgCall } from "./tx";

/** The realm's MaxAmount: 1,000,000 GNOT per period. */
export const MAX_AMOUNT_UGNOT = 1_000_000_000_000n;

/**
 * Storage deposits measured on a local chain (100 ugnot a byte): a plan
 * stores 8,100 to 8,300 bytes for a creator the realm does not know yet and
 * 4,100 to 4,600 bytes after that; a collector key 3,900 bytes for a new
 * creator, about 200 bytes once the creator has a record, nothing when it
 * replaces one. The figures below are rounded up.
 */
export const DEPOSIT = {
  planNewCreator: 860_000n,
  planLater: 480_000n,
  keyNewCreator: 400_000n,
  keyFirst: 25_000n,
  keyReplace: 0n,
} as const;
/** Gas measured: a plan 10M to 13M, a key 5M to 6M; Adena simulates both and signs its own estimate. */
export const MEASURED_GAS = { offer: 13_000_000, setKey: 6_500_000 } as const;

/** Why a title is refused, in the page's words, or null when the realm accepts it. Mirrors validateTitle. */
export function titleProblem(title: string): string | null {
  // a lone surrogate is not valid UTF-8 once encoded: the realm would see a different title
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(title)) return "The title contains a broken character. Type it again.";
  if (title.trim() === "") return "Give the plan a title.";
  const chars = [...title].length; // the realm counts characters (runes), not bytes
  if (chars > rules.maxTitleLen) return `The title is ${chars} characters long; the most is ${rules.maxTitleLen}.`;
  if (/[\p{Cc}\u2028\u2029]/u.test(title)) return "The title must be a single line, without tabs or other control characters.";
  if (/\p{Cf}/u.test(title)) return "The title contains invisible formatting characters (such as direction marks or zero-width spaces). Remove them.";
  return null;
}

/** Parses a GNOT amount typed by a person ("1", "0.5", "1,000.25") into ugnot. Null when it is not a plain decimal number. */
export function parseGnot(text: string): bigint | null {
  const t = text.trim().replace(/[,\s_]/g, "");
  const m = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(t);
  if (!m) return null;
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** Why a price is refused, or null. */
export function amountProblem(ugnot: bigint | null): string | null {
  if (ugnot === null) return "Enter the price as a number of GNOT, for example 1 or 0.5 (up to 6 decimals).";
  if (ugnot < rules.minAmountUgnot) return "The price must be at least 0.1 GNOT: below that, the collector’s network fee would eat most of each payment.";
  if (ugnot > MAX_AMOUNT_UGNOT) return "The price can be at most 1,000,000 GNOT a period.";
  return null;
}

export type PeriodUnit = "minutes" | "hours" | "days";
const UNIT_SECONDS: Record<PeriodUnit, bigint> = { minutes: 60n, hours: 3_600n, days: 86_400n };

/** Parses a period ("30" days) into seconds; null when it is not a whole number. */
export function parsePeriod(count: string, unit: PeriodUnit): bigint | null {
  const t = count.trim();
  if (!/^\d{1,7}$/.test(t)) return null;
  return BigInt(t) * UNIT_SECONDS[unit];
}

/** Why a period is refused, or null. */
export function periodProblem(seconds: bigint | null): string | null {
  if (seconds === null) return "Enter the period as a whole number.";
  if (seconds < BigInt(rules.minPeriod)) return "The period must be at least 1 minute.";
  if (seconds > BigInt(rules.maxPeriod)) return "The period can be at most 30 days: the chain does not allow a permission with a longer spend period.";
  return null;
}

export interface OfferInput {
  title: string;
  amount: bigint;
  period: bigint;
}

/** The plan as the realm will store it: Offer(title, amountUgnot, periodSeconds), signed by the creator. */
export function buildOffer(o: { payee: string } & OfferInput): MsgCall {
  const why = titleProblem(o.title) ?? amountProblem(o.amount) ?? periodProblem(o.period);
  if (why) throw new TxError(why);
  if (!/^g1[02-9ac-hj-np-z]{38}$/.test(o.payee)) throw new TxError("the creator is not a g1 address");
  return {
    type: "/vm.m_call",
    value: { caller: o.payee, send: "", pkg_path: config.realmPath, func: "Offer", args: [o.title, o.amount.toString(), o.period.toString()] },
  };
}

/** What the page knows about a pasted collector key. */
export type KeyCheck =
  | { ok: false; reason: string; address: string | null }
  | { ok: true; gpub: string; address: string };

/**
 * Checks a pasted public key the way SetCollectorKey will, plus what the
 * realm cannot see: the address must not be an account already (the chain
 * refuses every permission for such a key). `isAccount` asks the chain.
 */
export async function checkCollectorKey(text: string, creator: string, isAccount: (addr: string) => Promise<boolean>): Promise<KeyCheck> {
  const gpub = text.trim();
  if (gpub === "") return { ok: false, reason: "Paste the collector key’s public key (it starts with gpub1).", address: null };
  if (/(^|\s)(\w+\s+){11,}\w+/.test(gpub) || /^[0-9a-fA-F]{64}$/.test(gpub))
    return {
      ok: false,
      reason: "That looks like a seed phrase or a private key. Never paste those anywhere: paste only the public key, which starts with gpub1.",
      address: null,
    };
  if (gpub.length > 200 || !gpub.startsWith("gpub1")) return { ok: false, reason: "A public key starts with gpub1. Copy it from gnokey list.", address: null };
  let pub: Uint8Array;
  try {
    pub = pubFromGpub(gpub);
  } catch {
    return { ok: false, reason: "This is not a secp256k1 public key (gnokey’s default kind). Copy the gpub1… value from gnokey list again.", address: null };
  }
  const address = await addressOf(pub);
  if (address === creator)
    return { ok: false, reason: "This is your own wallet’s key. Make a separate key used only for collecting.", address };
  if (await isAccount(address))
    return {
      ok: false,
      reason: "This key’s address has already received coins, so it is an account, and the chain refuses every new permission for such a key. Make a new key and never send coins to it.",
      address,
    };
  return { ok: true, gpub, address };
}

/** SetCollectorKey(pubKey), signed by the creator. */
export function buildSetCollectorKey(o: { payee: string; gpub: string }): MsgCall {
  if (!/^g1[02-9ac-hj-np-z]{38}$/.test(o.payee)) throw new TxError("the creator is not a g1 address");
  pubFromGpub(o.gpub); // throws TxError unless it is a secp256k1 gpub
  return { type: "/vm.m_call", value: { caller: o.payee, send: "", pkg_path: config.realmPath, func: "SetCollectorKey", args: [o.gpub] } };
}

/** The storage deposit to expect for a plan or a key, from what the realm already holds for this creator. */
export function depositFor(action: "offer" | "key", known: { hasRecord: boolean; hasKey: boolean }): bigint {
  if (action === "offer") return known.hasRecord ? DEPOSIT.planLater : DEPOSIT.planNewCreator;
  if (!known.hasRecord) return DEPOSIT.keyNewCreator;
  return known.hasKey ? DEPOSIT.keyReplace : DEPOSIT.keyFirst;
}

/** The collector command for this creator, exactly as scripts/collect.sh takes it (it accepts only these remotes). */
export function collectorCommand(o: { payee: string; home: string; keyName: string }): string {
  const remote = config.rpcUrl.replace(/\/$/, "");
  return ["scripts/collect.sh", "-home", o.home, "-key", o.keyName, "-payee", o.payee, "-remote", remote, "-chainid", config.chainId, "-realm", config.realmPath].join(" ");
}
