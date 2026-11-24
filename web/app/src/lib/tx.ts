// The messages the app asks Adena to sign, and the gas it sends with them.
//
// Shapes are the ones Adena v1.22.5's DoContract accepts (checked through its
// own code by web/adena-check, as in M1.2): JSON-safe values, integers as
// decimal strings, a session key as a protobuf Any whose value is base64 of
// PubKeySecp256k1{key}. Every builder checks its inputs and throws TxError on
// anything unexpected, before a wallet ever sees it.

import { config, rules } from "../config";
import type { Plan } from "./amino";

export class TxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxError";
  }
}

const PUBKEY_TYPE = "/tm.PubKeySecp256k1";
const ADDRESS = /^g1[02-9ac-hj-np-z]{38}$/;

export interface MsgCreateSession {
  type: "/auth.m_create_session";
  value: {
    creator: string;
    session_key: { type_url: string; value: string };
    expires_at: string;
    allow_paths: string[];
    spend_limit: string;
    spend_period: string;
  };
}

export interface MsgRevokeSession {
  type: "/auth.m_revoke_session";
  value: { creator: string; session_key: { type_url: string; value: string } };
}

export interface MsgCall {
  type: "/vm.m_call";
  value: { caller: string; send: string; pkg_path: string; func: "Subscribe" | "Cancel"; args: string[] };
}

export type Msg = MsgCreateSession | MsgRevokeSession | MsgCall;

/** Gas sent with a request: gasWanted in gas units, gasFee in ugnot, both whole and non-zero. */
export interface Gas {
  gasWanted: number;
  gasFee: number;
}

// ------------------------------------------------------------------ keys

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(v: number[]): number {
  const g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let c = 1;
  for (const x of v) {
    const b = c >>> 25;
    c = ((c & 0x1ffffff) << 5) ^ x;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= g[i];
  }
  return c >>> 0;
}

function hrpExpand(h: string): number[] {
  const r: number[] = [];
  for (const ch of h) r.push(ch.charCodeAt(0) >> 5);
  r.push(0);
  for (const ch of h) r.push(ch.charCodeAt(0) & 31);
  return r;
}

/** Decodes a bech32 string (checksum verified) into its prefix and bytes. */
export function bech32Decode(s: string): { hrp: string; bytes: Uint8Array } {
  if (s !== s.toLowerCase() || s.length > 200) throw new TxError("not a bech32 string");
  const sep = s.lastIndexOf("1");
  if (sep < 1 || sep + 7 > s.length) throw new TxError("not a bech32 string");
  const hrp = s.slice(0, sep);
  const data: number[] = [];
  for (const ch of s.slice(sep + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) throw new TxError("not a bech32 string");
    data.push(v);
  }
  if (polymod(hrpExpand(hrp).concat(data)) !== 1) throw new TxError("bad bech32 checksum");
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 255);
    }
    acc &= (1 << bits) - 1;
  }
  return { hrp, bytes: new Uint8Array(out) };
}

function checkPub(b: Uint8Array): Uint8Array {
  if (b.length !== 33 || (b[0] !== 2 && b[0] !== 3)) throw new TxError("not a compressed secp256k1 public key");
  return b;
}

/** The 33-byte key inside a gpub1… key (bech32 of Any{"/tm.PubKeySecp256k1", PubKeySecp256k1{key}}). */
export function pubFromGpub(gpub: string): Uint8Array {
  const { hrp, bytes: b } = bech32Decode(gpub.trim());
  const t = new TextEncoder().encode(PUBKEY_TYPE);
  if (hrp !== "gpub" || b.length !== 4 + t.length + 35 || b[0] !== 0x0a || b[1] !== t.length) throw new TxError("not a secp256k1 gpub key");
  for (let i = 0; i < t.length; i++) if (b[2 + i] !== t[i]) throw new TxError("not a secp256k1 gpub key");
  const o = 2 + t.length;
  if (b[o] !== 0x12 || b[o + 1] !== 35 || b[o + 2] !== 0x0a || b[o + 3] !== 0x21) throw new TxError("not a secp256k1 gpub key");
  return checkPub(b.slice(o + 4));
}

function base64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}

function sessionKeyAny(pub33: Uint8Array): { type_url: string; value: string } {
  const v = new Uint8Array(35);
  v[0] = 0x0a; // PubKeySecp256k1{key}: field 1, 33 bytes
  v[1] = 0x21;
  v.set(checkPub(pub33), 2);
  return { type_url: PUBKEY_TYPE, value: base64(v) };
}

function checkAddr(a: string, what: string): string {
  if (!ADDRESS.test(a)) throw new TxError(`${what} is not a g1 address`);
  return a;
}

function positiveInt(n: bigint, what: string): string {
  if (n <= 0n) throw new TxError(`${what} must be positive`);
  return n.toString();
}

// ------------------------------------------------------------------ the messages

/** The one allow path every Mandate permission uses: exactly this realm, nothing under it. */
export function allowPath(): string {
  return "vm/exec:" + config.realmPath;
}

/** The cap per period: the plan's price plus the realm's fee allowance. */
export function capFor(plan: Plan): bigint {
  return plan.amount + rules.feeAllowanceUgnot;
}

/** The permission for a plan, exactly as the realm's own plan page prints it. */
export function buildCreateSession(o: { creator: string; collectorKey: string; plan: Plan; expiresAt: bigint }): MsgCreateSession {
  if (o.plan.period <= 0n || o.plan.period > BigInt(rules.maxPeriod)) throw new TxError("the plan's period is outside what the chain allows");
  return {
    type: "/auth.m_create_session",
    value: {
      creator: checkAddr(o.creator, "the supporter"),
      session_key: sessionKeyAny(pubFromGpub(o.collectorKey)),
      expires_at: positiveInt(o.expiresAt, "the end date"),
      allow_paths: [allowPath()],
      spend_limit: `${capFor(o.plan)}ugnot`,
      spend_period: positiveInt(o.plan.period, "the period"),
    },
  };
}

export function buildRevokeSession(o: { creator: string; pub33: Uint8Array }): MsgRevokeSession {
  return { type: "/auth.m_revoke_session", value: { creator: checkAddr(o.creator, "the supporter"), session_key: sessionKeyAny(o.pub33) } };
}

export function buildSubscribe(o: { payer: string; planId: bigint; sessionAddr: string; expiresAt: bigint }): MsgCall {
  return {
    type: "/vm.m_call",
    value: {
      caller: checkAddr(o.payer, "the supporter"),
      send: "",
      pkg_path: config.realmPath,
      func: "Subscribe",
      args: [positiveInt(o.planId, "the plan"), checkAddr(o.sessionAddr, "the collector key"), positiveInt(o.expiresAt, "the end date")],
    },
  };
}

/** Cancel, signed by the supporter (the realm also lets the creator cancel). */
export function buildCancel(o: { payer: string; sessionAddr: string }): MsgCall {
  return {
    type: "/vm.m_call",
    value: { caller: checkAddr(o.payer, "the supporter"), send: "", pkg_path: config.realmPath, func: "Cancel", args: [checkAddr(o.payer, "the supporter"), checkAddr(o.sessionAddr, "the permission")] },
  };
}

// ------------------------------------------------------------------ gas

/**
 * Gas for each request. Adena signs a session-only request with exactly the
 * gas and fee the page sends (it never estimates those), so they must be
 * sane: creating a permission used 1.36M gas, revoking 0.93M. For a request
 * with a realm call Adena simulates and signs its own estimate (×1.1); the
 * values here only seed that simulation. A realm call is sized for the
 * worst measured Subscribe (31.5M, a wallet with 15 mandates on a list
 * boundary) and Cancel (under 10M).
 */
export const GAS = {
  session: 5_000_000,
  call: 60_000_000,
  sessionAndCall: 65_000_000,
} as const;

/** The smallest fee the chain accepts for this much gas at its current price (auth/gasprice). */
export function minFee(gasWanted: number, price: { gas: bigint; amount: bigint }): number {
  if (price.gas <= 0n || price.amount < 0n) throw new TxError("odd gas price from the chain");
  const fee = (BigInt(gasWanted) * price.amount + price.gas - 1n) / price.gas;
  return Number(fee < 1n ? 1n : fee);
}

/** A fee with a margin of a half over the current minimum, so a small price rise does not refuse it. */
export function gasFor(kind: keyof typeof GAS, price: { gas: bigint; amount: bigint }): Gas {
  const gasWanted = GAS[kind];
  const fee = minFee(gasWanted, price);
  return checkGas({ gasWanted, gasFee: fee + Math.ceil(fee / 2) });
}

const MAX_GAS_WANTED = 100_000_000;
const MAX_GAS_FEE = 1_000_000; // 1 GNOT: a typo guard for an approval's network fee

export function checkGas(g: Gas): Gas {
  if (!Number.isSafeInteger(g.gasWanted) || g.gasWanted < 100_000 || g.gasWanted > MAX_GAS_WANTED) throw new TxError("gas wanted out of range");
  // 0 or a missing value would silently become Adena's 2,000,000,000 gas default.
  if (!Number.isSafeInteger(g.gasFee) || g.gasFee < 1 || g.gasFee > MAX_GAS_FEE) throw new TxError("gas fee out of range");
  return g;
}

/** Adena's DoContract parameters: the messages, an empty memo and the explicit gas. */
export function doContractParams(messages: Msg[], gas: Gas): { messages: Msg[]; memo: string; gasWanted: number; gasFee: number } {
  if (messages.length === 0 || messages.length > 2) throw new TxError("one or two messages per approval");
  const g = checkGas(gas);
  return { messages, memo: "", gasWanted: g.gasWanted, gasFee: g.gasFee };
}

/** One year from now (chain time), the end date of a new mandate and its permission. */
export function defaultEnd(now: bigint): bigint {
  return now + 365n * 86400n;
}
