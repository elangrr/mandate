// Strict decoders for the realm values read through `vm/qeval_json`.
//
// qeval_json returns each result as amino JSON: strings as JSON strings,
// integers as 8-byte little-endian base64 ("N"), zero values omitted. Every
// decoder checks the exact shape (type ids, field count, primitive kinds) and
// throws DecodeError on anything else, so a change in the node shows up as an
// error rather than as wrong numbers. Field orders are the deployed realm's
// (r/mandate/reads.gno), which can never change.

export class DecodeError extends Error {
  constructor(message: string) {
    super("Unexpected data from the chain: " + message);
    this.name = "DecodeError";
  }
}

const KIND = { bool: "4", string: "16", int: "32", int64: "1024", uint64: "65536" } as const;

type Json = unknown;
type Obj = Record<string, Json>;

function isObj(v: Json): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function need(cond: boolean, what: string): asserts cond {
  if (!cond) throw new DecodeError(what);
}

/** All results of a qeval_json body; `count` of them expected. */
export function results(body: string, count: number): Obj[] {
  let parsed: Json;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new DecodeError("not JSON");
  }
  need(isObj(parsed) && Array.isArray(parsed.results), "no results array");
  const rs = parsed.results as Json[];
  need(rs.length === count, `expected ${count} results, got ${rs.length}`);
  rs.forEach((r, i) => need(isObj(r), `result ${i} is not an object`));
  return rs as Obj[];
}

function decodeN(n: Json, signed: boolean, what: string): bigint {
  if (n === undefined) return 0n; // zero values are omitted
  need(typeof n === "string", `${what}: N is not a string`);
  let bin: string;
  try {
    bin = atob(n as string);
  } catch {
    throw new DecodeError(`${what}: N is not base64`);
  }
  need(bin.length === 8, `${what}: N is ${bin.length} bytes, expected 8`);
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bin.charCodeAt(i));
  if (signed && v >= 1n << 63n) v -= 1n << 64n;
  return v;
}

function primitiveKind(t: Json): string | undefined {
  return isObj(t) && t["@type"] === "/gno.PrimitiveType" && typeof t.value === "string" ? t.value : undefined;
}

function refId(t: Json): string | undefined {
  return isObj(t) && t["@type"] === "/gno.RefType" && typeof t.ID === "string" ? t.ID : undefined;
}

function prim(tv: Json, kind: string, what: string): Obj {
  need(isObj(tv), `${what}: not an object`);
  need(primitiveKind(tv.T) === kind, `${what}: expected kind ${kind}, got ${JSON.stringify(tv.T)}`);
  return tv;
}

function stringValue(V: Json, what: string): string {
  if (V === undefined) return "";
  need(isObj(V) && V["@type"] === "/gno.StringValue" && typeof V.value === "string", `${what}: not a StringValue`);
  return V.value as string;
}

export function str(tv: Json, what: string): string {
  return stringValue(prim(tv, KIND.string, what).V, what);
}

export function address(tv: Json, what: string): string {
  need(isObj(tv) && refId(tv.T) === ".uverse.address", `${what}: not an address`);
  const a = stringValue(tv.V, what);
  need(a === "" || /^g1[02-9ac-hj-np-z]{38}$/.test(a), `${what}: malformed address`);
  return a;
}

export function u64(tv: Json, what: string): bigint {
  return decodeN(prim(tv, KIND.uint64, what).N, false, what);
}

export function i64(tv: Json, what: string): bigint {
  return decodeN(prim(tv, KIND.int64, what).N, true, what);
}

export function int(tv: Json, what: string): number {
  return Number(decodeN(prim(tv, KIND.int, what).N, true, what));
}

export function bool(tv: Json, what: string): boolean {
  const v = decodeN(prim(tv, KIND.bool, what).N, false, what);
  need(v === 0n || v === 1n, `${what}: bool is ${v}`);
  return v === 1n;
}

function structFields(r: Json, typeSuffix: string, count: number): Json[] {
  need(isObj(r), `${typeSuffix}: not an object`);
  const id = refId(r.T);
  need(id !== undefined && id.endsWith(typeSuffix), `expected ${typeSuffix}, got ${JSON.stringify(r.T)}`);
  need(isObj(r.V) && r.V["@type"] === "/gno.StructValue" && Array.isArray(r.V.Fields), `${typeSuffix}: not a struct`);
  const fields = (r.V as { Fields: Json[] }).Fields;
  need(fields.length === count, `${typeSuffix}: ${fields.length} fields, expected ${count}`);
  return fields;
}

/** The elements of a slice result whose element type ends with eltSuffix. */
function sliceElems(r: Json, eltSuffix: string): Json[] {
  need(isObj(r) && isObj(r.T) && r.T["@type"] === "/gno.SliceType", `expected a slice of ${eltSuffix}`);
  need((refId((r.T as Obj).Elt) ?? "").endsWith(eltSuffix), `expected a slice of ${eltSuffix}`);
  if (r.V === undefined) return []; // nil slice
  need(isObj(r.V) && r.V["@type"] === "/gno.SliceValue", "not a SliceValue");
  const v = r.V as Obj;
  const offset = Number(v.Offset ?? "0");
  const length = Number(v.Length ?? "0");
  if (length === 0) return [];
  need(isObj(v.Base) && (v.Base as Obj)["@type"] === "/gno.ArrayValue" && Array.isArray((v.Base as Obj).List), "slice has no array");
  const list = (v.Base as { List: Json[] }).List;
  need(Number.isInteger(offset) && Number.isInteger(length) && offset >= 0 && offset + length <= list.length, "slice bounds");
  return list.slice(offset, offset + length);
}

// ------------------------------------------------------------------ types

export interface Plan {
  id: bigint;
  payee: string;
  title: string;
  amount: bigint; // ugnot per period
  period: bigint; // seconds
  createdAt: bigint;
  mandates: number; // ever recorded
  cancelled: number;
  paidThisPeriod: number; // payments in the current period window
  paidLastPeriod: number;
  periodStart: bigint;
  pulls: bigint;
  paid: bigint;
  lastPullAt: bigint;
}

export type MandateStatus = "active" | "expired" | "cancelled";

export interface Mandate {
  id: bigint;
  planId: bigint;
  payer: string;
  payee: string;
  session: string;
  sessionPubKey: string;
  amount: bigint;
  period: bigint;
  createdAt: bigint;
  expiresAt: bigint;
  nextPullAt: bigint;
  lastPullAt: bigint;
  paidThrough: bigint;
  pulls: bigint;
  paid: bigint;
  cancelledAt: bigint;
  cancelledBy: string;
  status: MandateStatus; // the realm's view; a revoked session is not visible here
  due: boolean;
  sessionQuery: string;
}

export interface Payee {
  addr: string;
  plans: number;
  pulls: bigint;
  paid: bigint;
  lastPullAt: bigint;
  collectorKey: string; // gpub1…, "" if not published
  collectorAddr: string;
  collectorFunded: boolean; // its address holds coins: new sessions are refused
}

export interface Totals {
  plans: number;
  mandates: number;
  pulls: bigint;
  paid: bigint;
}

export interface PlanCounts {
  paidThisPeriod: number;
  paidLastPeriod: number;
  unpaid: number;
  unpaidExact: boolean;
}

// ------------------------------------------------------------------ decoders

function plan(tv: Json): Plan {
  const f = structFields(tv, "/mandate.PlanInfo", 14);
  return {
    id: u64(f[0], "ID"),
    payee: address(f[1], "Payee"),
    title: str(f[2], "Title"),
    amount: i64(f[3], "Amount"),
    period: i64(f[4], "Period"),
    createdAt: i64(f[5], "CreatedAt"),
    mandates: int(f[6], "Mandates"),
    cancelled: int(f[7], "Cancelled"),
    paidThisPeriod: int(f[8], "PaidThisPeriod"),
    paidLastPeriod: int(f[9], "PaidLastPeriod"),
    periodStart: i64(f[10], "PeriodStart"),
    pulls: i64(f[11], "Pulls"),
    paid: i64(f[12], "Paid"),
    lastPullAt: i64(f[13], "LastPullAt"),
  };
}

function mandate(tv: Json): Mandate {
  const f = structFields(tv, "/mandate.MandateInfo", 20);
  const status = str(f[17], "Status");
  need(status === "active" || status === "expired" || status === "cancelled", `Status: unknown value ${status}`);
  return {
    id: u64(f[0], "ID"),
    planId: u64(f[1], "PlanID"),
    payer: address(f[2], "Payer"),
    payee: address(f[3], "Payee"),
    session: address(f[4], "Session"),
    sessionPubKey: str(f[5], "SessionPubKey"),
    amount: i64(f[6], "Amount"),
    period: i64(f[7], "Period"),
    createdAt: i64(f[8], "CreatedAt"),
    expiresAt: i64(f[9], "ExpiresAt"),
    nextPullAt: i64(f[10], "NextPullAt"),
    lastPullAt: i64(f[11], "LastPullAt"),
    paidThrough: i64(f[12], "PaidThrough"),
    pulls: i64(f[13], "Pulls"),
    paid: i64(f[14], "Paid"),
    cancelledAt: i64(f[15], "CancelledAt"),
    cancelledBy: address(f[16], "CancelledBy"),
    status,
    due: bool(f[18], "Due"),
    sessionQuery: str(f[19], "SessionQuery"),
  };
}

function payee(tv: Json): Payee {
  const f = structFields(tv, "/mandate.PayeeInfo", 8);
  return {
    addr: address(f[0], "Addr"),
    plans: int(f[1], "Plans"),
    pulls: i64(f[2], "Pulls"),
    paid: i64(f[3], "Paid"),
    lastPullAt: i64(f[4], "LastPullAt"),
    collectorKey: str(f[5], "CollectorKey"),
    collectorAddr: address(f[6], "CollectorAddr"),
    collectorFunded: bool(f[7], "CollectorFunded"),
  };
}

/** GetPlan(id) -> the plan, or null when there is none. */
export function decodeGetPlan(body: string): Plan | null {
  const [p, ok] = results(body, 2);
  return bool(ok, "found") ? plan(p) : null;
}

/** GetPayee(addr) -> the payee, or null. */
export function decodeGetPayee(body: string): Payee | null {
  const [p, ok] = results(body, 2);
  return bool(ok, "found") ? payee(p) : null;
}

/** MandateOf(payer, session) -> the mandate, or null. */
export function decodeMandateOf(body: string): Mandate | null {
  const [m, ok] = results(body, 2);
  return bool(ok, "found") ? mandate(m) : null;
}

/** Plans(page), PlansOf(payee, page). */
export function decodePlans(body: string): Plan[] {
  return sliceElems(results(body, 1)[0], "/mandate.PlanInfo").map(plan);
}

/** MandatesOf(payer, page), SupportersOf(plan, page). */
export function decodeMandates(body: string): Mandate[] {
  return sliceElems(results(body, 1)[0], "/mandate.MandateInfo").map(mandate);
}

/** PayingSupporters(plan, from) -> the page and the cursor (-1: the list is exhausted; stop). */
export function decodePayingSupporters(body: string): { list: Mandate[]; next: number } {
  const [l, n] = results(body, 2);
  return { list: sliceElems(l, "/mandate.MandateInfo").map(mandate), next: int(n, "next") };
}

export function decodePlanCounts(body: string): PlanCounts {
  const [a, b, c, d] = results(body, 4);
  return { paidThisPeriod: int(a, "paidThisPeriod"), paidLastPeriod: int(b, "paidLastPeriod"), unpaid: int(c, "unpaid"), unpaidExact: bool(d, "unpaidExact") };
}

export function decodeTotals(body: string): Totals {
  const [a, b, c, d] = results(body, 4);
  return { plans: int(a, "plans"), mandates: int(b, "mandates"), pulls: i64(c, "pulls"), paid: i64(d, "paid") };
}

export function decodeInt64(body: string): bigint {
  return i64(results(body, 1)[0], "int64");
}

export function decodeBool(body: string): boolean {
  return bool(results(body, 1)[0], "bool");
}
