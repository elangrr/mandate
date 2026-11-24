// Amounts, periods and times. Integer maths only (bigint for ugnot), and the
// same wording as the realm's own pages, so the app and gnoweb agree.

/** ugnot -> "1.25" (GNOT, up to 6 decimals, no trailing zeros). */
export function gnot(ugnot: bigint): string {
  const neg = ugnot < 0n;
  const v = neg ? -ugnot : ugnot;
  const whole = v / 1_000_000n;
  const frac = v % 1_000_000n;
  let s = thousands(whole);
  if (frac !== 0n) s += "." + frac.toString().padStart(6, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + s;
}

const NUMBER = new Intl.NumberFormat("en-US");

export function thousands(n: bigint | number): string {
  return NUMBER.format(n);
}

/** Seconds -> "week", "2 weeks", "30 days", "minute" (as the realm says it, after "every"). */
export function period(sec: bigint | number): string {
  const s = BigInt(sec);
  const unit = (n: bigint, one: string, many: string) => (n === 1n ? one : `${n} ${many}`);
  if (s > 0n && s % 604800n === 0n) return unit(s / 604800n, "week", "weeks");
  if (s > 0n && s % 86400n === 0n) return unit(s / 86400n, "day", "days");
  if (s > 0n && s % 3600n === 0n) return unit(s / 3600n, "hour", "hours");
  if (s > 0n && s % 60n === 0n) return unit(s / 60n, "minute", "minutes");
  return unit(s, "second", "seconds");
}

/** "1 GNOT every week". */
export function price(amount: bigint, periodSec: bigint): string {
  return `${gnot(amount)} GNOT every ${period(periodSec)}`;
}

/** A period shorter than a day is a test plan (the realm's pages flag it too). */
export function isTestPeriod(periodSec: bigint): boolean {
  return periodSec < 86400n;
}

const DATE = new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const DATETIME = new Intl.DateTimeFormat("en-GB", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

/** Unix seconds -> "24 Nov 2026 UTC": the day in UTC, which says so (east of UTC+3 a late evening is already the next day). */
export function date(unix: bigint): string {
  return DATE.format(new Date(Number(unix) * 1000)) + " UTC";
}

/** Unix seconds -> "24 Nov 2026, 10:05 UTC". */
export function dateTime(unix: bigint): string {
  return DATETIME.format(new Date(Number(unix) * 1000)) + " UTC";
}

/** "in 3 days", "in 5 minutes", "2 hours ago": the gap between two unix times. */
export function relative(target: bigint, now: bigint): string {
  const d = target - now;
  const a = d < 0n ? -d : d;
  let s: string;
  if (a < 60n) s = "less than a minute";
  else if (a < 3600n) s = plural(Number((a + 30n) / 60n), "minute");
  else if (a < 2n * 86400n) s = plural(Number((a + 1800n) / 3600n), "hour");
  else s = plural(Number((a + 43200n) / 86400n), "day");
  if (a < 60n) return d < 0n ? "just now" : "in " + s;
  return d < 0n ? `${s} ago` : `in ${s}`;
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${thousands(n)} ${n === 1 ? one : many}`;
}

/** The noun alone, singular for exactly 1: a label beside its count ("1" / "plan", "4" / "plans"). */
export function word(n: number | bigint, one: string, many = one + "s"): string {
  return BigInt(n) === 1n ? one : many;
}

/**
 * A plan's payment counts as the realm keeps them: in its current counting
 * window, which began at `start` (the realm's PeriodStart, a whole multiple of
 * the period on the UTC clock, the same for every supporter), and in the
 * window of one period before that. "1 payment since 3 Nov 2026, 00:00 UTC · 0 in the 30 days before that".
 */
export function windowCounts(thisWindow: number, windowBefore: number, start: bigint, periodSec: bigint): string {
  return `${plural(thisWindow, "payment")} since ${dateTime(start)} · ${thousands(windowBefore)} in the ${period(periodSec)} before that`;
}

/** g1jg8mtu…sqf5 for tables. */
export function shortAddr(a: string): string {
  return a.length > 14 ? a.slice(0, 8) + "…" + a.slice(-4) : a;
}
