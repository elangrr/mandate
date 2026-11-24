// Read-only access to the chain through the node's JSON-RPC (abci_query).
// No wallet is needed for anything in this file, and nothing here costs gas.

import { config } from "../config";
import {
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
  type Mandate,
  type Payee,
  type Plan,
  type PlanCounts,
  type Totals,
} from "./amino";

/** A problem the user should see in plain words. */
export class ReadError extends Error {
  kind: "network" | "not-live" | "chain";
  constructor(kind: ReadError["kind"], message: string) {
    super(message);
    this.name = "ReadError";
    this.kind = kind;
  }
}

interface AbciResult {
  data: string;
  error: string | null;
  log: string;
}

let rpcId = 0;

function b64decode(s: string): string {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function toBase64(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** No read waits longer than this: a silent network must never keep the page waiting (and its buttons disabled) for ever. */
export const READ_TIMEOUT_MS = 10_000;

/** fetch and read the JSON body, the whole of it within the time limit. Throws on a time-out or transport problem. */
export async function fetchJson(url: string, init: RequestInit = {}, fetchFn: typeof fetch = fetch, ms = READ_TIMEOUT_MS): Promise<{ ok: boolean; status: number; json: any }> {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl?.abort();
      reject(new Error("timed out"));
    }, ms);
  });
  try {
    return await Promise.race([
      (async () => {
        const res = await fetchFn(url, { ...init, signal: ctl?.signal });
        if (!res.ok) return { ok: false, status: res.status, json: null };
        return { ok: true, status: res.status, json: await res.json() };
      })(),
      limit,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const networkError = () => new ReadError("network", `Could not reach the ${config.networkName}. Check your connection and try again.`);

/** One abci_query call. Throws ReadError("network") on transport problems. */
export async function abciQuery(path: string, data: string, fetchFn: typeof fetch = fetch): Promise<AbciResult> {
  let r: { ok: boolean; status: number; json: any };
  try {
    r = await fetchJson(
      config.rpcUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "abci_query", params: { path, data: toBase64(data) } }),
      },
      fetchFn,
    );
  } catch {
    throw networkError();
  }
  if (!r.ok) throw new ReadError("network", `The ${config.networkName} did not answer (HTTP ${r.status}). Try again in a moment.`);
  const json = r.json;
  if (json.error) throw new ReadError("network", `The network returned an error: ${String(json.error.message ?? json.error.data ?? "unknown")}`);
  const base = json?.result?.response?.ResponseBase;
  if (!base) throw networkError();
  const err = base.Error;
  return {
    data: base.Data ? b64decode(base.Data) : "",
    error: err ? String(err.value ?? err["@type"] ?? "error") : null,
    log: typeof base.Log === "string" ? base.Log : "",
  };
}

/** Whether the realm is live, parked until the network's approver enables it, or not there. */
export interface PackageStatus {
  status: "live" | "inert" | "absent" | "unknown";
  reason: string;
}

export function parsePackageStatus(r: AbciResult): PackageStatus {
  if (r.error) return { status: "unknown", reason: r.error };
  try {
    const m = JSON.parse(r.data);
    const s = m.status === "live" || m.status === "inert" || m.status === "absent" ? m.status : "unknown";
    return { status: s, reason: typeof m.reason === "string" ? m.reason : "" };
  } catch {
    return { status: "unknown", reason: "" };
  }
}

export async function packageStatus(): Promise<PackageStatus> {
  return parsePackageStatus(await abciQuery("vm/qpkgmeta_json", config.realmPath));
}

async function evalJson(expr: string): Promise<string> {
  const r = await abciQuery("vm/qeval_json", `${config.realmPath}.${expr}`);
  if (r.error) {
    if (/InvalidPkgPath|package not found|not found|inert/i.test(r.error + r.log)) {
      throw new ReadError("not-live", "Mandate is not live on the network yet.");
    }
    throw new ReadError("chain", r.error);
  }
  return r.data;
}

/** A session as the chain sees it (auth/accounts/<payer>/session/<key>). */
export interface Session {
  expiresAt: bigint; // 0 = no expiry
  spendLimit: bigint; // ugnot per period
  spendPeriod: bigint;
  spendUsed: bigint;
  spendReset: bigint;
  allowPaths: string[];
}

/** The ugnot in a coins string such as "5ugnot,3foo": the exact denomination only. */
export function ugnotOf(coins: unknown): bigint {
  if (typeof coins !== "string") return 0n;
  let total = 0n;
  for (const part of coins.split(",")) {
    const m = /^(\d+)ugnot$/.exec(part.trim());
    if (m) total += BigInt(m[1]);
  }
  return total;
}

/** A bank/balances answer: a JSON string of coins ("123ugnot,4foo") or the bare coins string. */
export function parseBalance(r: AbciResult): bigint {
  if (r.error) throw new ReadError("chain", r.error);
  let coins: unknown = r.data.trim();
  try {
    coins = JSON.parse(r.data);
  } catch {
    /* the bare coins string */
  }
  return ugnotOf(coins);
}

/** Parses a session query; null when the chain says there is no such session. */
export function parseSession(r: AbciResult): Session | null {
  if (r.error) {
    if (/SessionNotFound/.test(r.error)) return null;
    throw new ReadError("chain", r.error);
  }
  let d: any;
  try {
    d = JSON.parse(r.data);
  } catch {
    throw new ReadError("chain", "unexpected session data");
  }
  if (d === null) return null;
  const s = d.BaseSessionAccount ?? d;
  // a value that does not parse is an error, never 0: an expiry of 0 would read as "never expires"
  const n = (v: unknown, what: string) => {
    if (typeof v === "string" && /^\d{1,19}$/.test(v)) return BigInt(v);
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
    if (v === undefined || v === null) return 0n; // amino JSON omits zero values
    throw new ReadError("chain", `unexpected session ${what}`);
  };
  return {
    expiresAt: n(s.expires_at, "expiry"),
    spendLimit: ugnotOf(s.spend_limit),
    spendPeriod: n(s.spend_period, "period"),
    spendUsed: ugnotOf(s.spend_used),
    spendReset: n(s.spend_reset, "reset"),
    allowPaths: Array.isArray(d.allow_paths) ? d.allow_paths.filter((p: unknown) => typeof p === "string") : [],
  };
}

/** One of a wallet's permissions as the chain lists them (auth/accounts/<payer>/sessions). */
export interface SessionEntry extends Session {
  address: string; // the session key's address
  pubKey: string; // base64 of its 33-byte public key, "" if unknown
}

/** Parses the sessions list (JSON array, or null when there are none). */
export function parseSessions(r: AbciResult): SessionEntry[] {
  if (r.error) throw new ReadError("chain", r.error);
  let d: any;
  try {
    // the chain answers JSON null for a wallet without permissions; an empty or other answer is unreadable, never "none"
    d = JSON.parse(r.data);
  } catch {
    throw new ReadError("chain", "unexpected sessions data");
  }
  if (d === null) return [];
  if (!Array.isArray(d)) throw new ReadError("chain", "unexpected sessions data");
  return d.map((item: any) => {
    const s = parseSession({ data: JSON.stringify(item), error: null, log: "" })!;
    const base = item?.BaseSessionAccount?.BaseAccount ?? {};
    if (typeof base.address !== "string" || !isAddress(base.address)) throw new ReadError("chain", "unexpected sessions data");
    const address = base.address;
    const pk = base.public_key;
    const pubKey = pk && pk["@type"] === "/tm.PubKeySecp256k1" && typeof pk.value === "string" ? pk.value : "";
    return { ...s, address, pubKey };
  });
}

/** The chain's gas price: `price.amount` ugnot per `price.gas` gas (auth/gasprice). */
export function parseGasPrice(r: AbciResult): { gas: bigint; amount: bigint } {
  if (r.error) throw new ReadError("chain", r.error);
  let d: any;
  try {
    d = JSON.parse(r.data);
  } catch {
    throw new ReadError("chain", "unexpected gas price data");
  }
  const m = typeof d?.price === "string" ? /^(\d+)ugnot$/.exec(d.price) : null;
  if (!m || typeof d.gas !== "string" || !/^[1-9]\d*$/.test(d.gas)) throw new ReadError("chain", "unexpected gas price data");
  return { gas: BigInt(d.gas), amount: BigInt(m[1]) };
}

/** Whether an address is an account on chain (it has received coins at some point). */
export function parseAccountExists(r: AbciResult): boolean {
  if (r.error) throw new ReadError("chain", r.error);
  const t = r.data.trim();
  return t !== "" && t !== "null";
}

// --- small cache: identical reads within a few seconds share one request ---

const TTL_MS = 4_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: now, value });
  value.catch(() => cache.delete(key));
  return value;
}

/** Forget cached reads (after a transaction). */
export function invalidate(): void {
  cache.clear();
}

export const isAddress = (a: string) => /^g1[02-9ac-hj-np-z]{38}$/.test(a);

function addr(a: string): string {
  if (!isAddress(a)) throw new ReadError("chain", "That is not a valid address.");
  return `address("${a}")`;
}

function id(n: bigint | number): string {
  return BigInt(n).toString();
}

export const read = {
  status: (): Promise<PackageStatus> => cached("status", packageStatus),
  totals: (): Promise<Totals> => cached("totals", async () => decodeTotals(await evalJson("Totals()"))),
  plan: (p: bigint): Promise<Plan | null> => cached(`plan${p}`, async () => decodeGetPlan(await evalJson(`GetPlan(${id(p)})`))),
  plans: (page: number): Promise<Plan[]> => cached(`plans${page}`, async () => decodePlans(await evalJson(`Plans(${page})`))),
  plansOf: (payee: string, page: number): Promise<Plan[]> => cached(`plansOf${payee}/${page}`, async () => decodePlans(await evalJson(`PlansOf(${addr(payee)}, ${page})`))),
  payee: (a: string): Promise<Payee | null> => cached(`payee${a}`, async () => decodeGetPayee(await evalJson(`GetPayee(${addr(a)})`))),
  mandateOf: (payer: string, session: string): Promise<Mandate | null> =>
    cached(`m${payer}/${session}`, async () => decodeMandateOf(await evalJson(`MandateOf(${addr(payer)}, ${addr(session)})`))),
  mandatesOf: (payer: string, page: number): Promise<Mandate[]> => cached(`ms${payer}/${page}`, async () => decodeMandates(await evalJson(`MandatesOf(${addr(payer)}, ${page})`))),
  payingSupporters: (p: bigint, from: number): Promise<{ list: Mandate[]; next: number }> =>
    cached(`ps${p}/${from}`, async () => decodePayingSupporters(await evalJson(`PayingSupporters(${id(p)}, ${from})`))),
  planCounts: (p: bigint): Promise<PlanCounts> => cached(`pc${p}`, async () => decodePlanCounts(await evalJson(`PlanCounts(${id(p)})`))),
  paidThrough: (payer: string, p: bigint): Promise<bigint> => cached(`pt${payer}/${p}`, async () => decodeInt64(await evalJson(`PaidThrough(${addr(payer)}, ${id(p)})`))),
  hasMandate: (payer: string, p: bigint): Promise<boolean> => cached(`hm${payer}/${p}`, async () => decodeBool(await evalJson(`HasMandate(${addr(payer)}, ${id(p)})`))),
  session: (payer: string, key: string): Promise<Session | null> =>
    cached(`s${payer}/${key}`, async () => parseSession(await abciQuery(`auth/accounts/${payer}/session/${key}`, ""))),
  sessions: (payer: string): Promise<SessionEntry[]> => cached(`ss${payer}`, async () => parseSessions(await abciQuery(`auth/accounts/${payer}/sessions`, ""))),
  gasPrice: (): Promise<{ gas: bigint; amount: bigint }> => cached("gasprice", async () => parseGasPrice(await abciQuery("auth/gasprice", ""))),
  /** The wallet's spendable ugnot (bank/balances). */
  balance: (a: string): Promise<bigint> =>
    cached(`bal${a}`, async () => {
      return parseBalance(await abciQuery(`bank/balances/${a}`, ""));
    }),
  accountExists: (a: string): Promise<boolean> => cached(`acct${a}`, async () => parseAccountExists(await abciQuery(`auth/accounts/${a}`, ""))),
  /** The time of the chain's latest block (unix seconds): "now" for due dates. */
  chainTime: (): Promise<bigint> =>
    cached("time", async () => {
      let j: any;
      try {
        j = (await fetchJson(config.rpcUrl.replace(/\/$/, "") + "/status")).json;
      } catch {
        throw networkError();
      }
      const t = j?.result?.sync_info?.latest_block_time;
      // RFC 3339 with nanoseconds: keep milliseconds, which every Date parser accepts.
      const ms = typeof t === "string" ? Date.parse(t.replace(/(\.\d{3})\d*(Z|[+-]\d\d:\d\d)$/, "$1$2")) : NaN;
      if (!Number.isFinite(ms)) throw networkError();
      return BigInt(Math.floor(ms / 1000));
    }),
};
