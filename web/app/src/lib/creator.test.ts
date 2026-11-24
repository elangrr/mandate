import { describe, expect, it } from "vitest";
import {
  mustRemove,
  normalizeKeyText,
  amountProblem,
  buildOffer,
  buildSetCollectorKey,
  checkCollectorKey,
  collectorCommand,
  DEPOSIT,
  depositFor,
  parseGnot,
  parsePeriod,
  periodProblem,
  titleProblem,
} from "./creator";
import { TxError } from "./tx";

const GPUB = "gpub1pgfj7ard9eg82cjtv4u4xetrwqer2dntxyfzxz3pqfp0696ldln2nm7kd33zfpgypg6u0e7upl03hyeexa6mccn4ce8mkswg65c";
const COLLECTOR = "g1psdsf789f4xw3qrpjue54g2h28syd09yfkrxdh";
const CREATOR = "g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj";
const REALM = "gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate";

describe("plan title: the realm's validateTitle", () => {
  it("accepts one line of 1 to 80 characters, counted as characters (not bytes)", () => {
    expect(titleProblem("Support Fluxen's work")).toBeNull();
    expect(titleProblem("é".repeat(80))).toBeNull(); // 160 bytes, 80 characters
    expect(titleProblem("🎨".repeat(80))).toBeNull(); // astral characters count once each
  });
  it("refuses empty, too long, control, line and format characters, and broken characters", () => {
    expect(titleProblem("")).toMatch(/Give the plan a title/);
    expect(titleProblem("   ")).toMatch(/Give the plan a title/);
    expect(titleProblem("x".repeat(81))).toMatch(/81 characters long; the most is 80/);
    for (const bad of ["a\nb", "a\tb", "a\u0000b", "a\u007fb", "a\u0085b", "a\u2028b", "a\u2029b"]) expect(titleProblem(bad), JSON.stringify(bad)).toMatch(/single line/);
    for (const bad of ["a\u202eb", "a\u200bb", "a\u2066b", "a\ufeffb", "a\u00adb"]) expect(titleProblem(bad), JSON.stringify(bad)).toMatch(/invisible formatting/);
    expect(titleProblem("a\ud800b")).toMatch(/broken character/);
  });
});

describe("price and period", () => {
  it("parses GNOT exactly into ugnot: a dot for decimals, a comma only between thousands", () => {
    expect(parseGnot("1")).toBe(1_000_000n);
    expect(parseGnot("0.1")).toBe(100_000n);
    expect(parseGnot(" 1,000.25 ")).toBe(1_000_250_000n);
    expect(parseGnot("1,234,567")).toBe(1_234_567_000_000n);
    expect(parseGnot("0.000001")).toBe(1n);
    for (const bad of ["", "abc", "1.0000001", "-1", "1e3", "0x10", "1.2.3"]) expect(parseGnot(bad), bad).toBeNull();
  });
  it("never guesses a decimal comma, a space or an underscore", () => {
    for (const bad of ["0,5", "1,5", "1.000,50", "1 5", "1_000", "1,00", "10,0000", ",5", "1,000,", "12345,678"]) expect(parseGnot(bad), bad).toBeNull();
    expect(amountProblem(parseGnot("0,5"))).toMatch(/dot for decimals/);
  });
  it("enforces 0.1 GNOT to 1,000,000 GNOT", () => {
    expect(amountProblem(null)).toMatch(/price in GNOT with a dot for decimals/);
    expect(amountProblem(99_999n)).toMatch(/at least 0.1 GNOT/);
    expect(amountProblem(100_000n)).toBeNull();
    expect(amountProblem(1_000_000_000_000n)).toBeNull();
    expect(amountProblem(1_000_000_000_001n)).toMatch(/at most 1,000,000 GNOT/);
  });
  it("enforces 1 minute to 30 days", () => {
    expect(parsePeriod("30", "days")).toBe(2_592_000n);
    expect(parsePeriod("2", "hours")).toBe(7_200n);
    expect(parsePeriod("1.5", "days")).toBeNull();
    expect(periodProblem(null)).toMatch(/whole number/);
    expect(periodProblem(59n)).toMatch(/at least 1 minute/);
    expect(periodProblem(60n)).toBeNull();
    expect(periodProblem(2_592_000n)).toBeNull();
    expect(periodProblem(2_592_001n)).toMatch(/at most 30 days/);
  });
});

describe("Offer", () => {
  it("is exactly Offer(title, amount, period), signed by the creator, no coins", () => {
    expect(buildOffer({ payee: CREATOR, title: "Support Fluxen's work", amount: 1_000_000n, period: 2_592_000n })).toEqual({
      type: "/vm.m_call",
      value: { caller: CREATOR, send: "", pkg_path: REALM, func: "Offer", args: ["Support Fluxen's work", "1000000", "2592000"] },
    });
  });
  it("never builds a plan the realm would refuse", () => {
    expect(() => buildOffer({ payee: CREATOR, title: "", amount: 1_000_000n, period: 60n })).toThrow(TxError);
    expect(() => buildOffer({ payee: CREATOR, title: "ok", amount: 1n, period: 60n })).toThrow(TxError);
    expect(() => buildOffer({ payee: CREATOR, title: "ok", amount: 1_000_000n, period: 59n })).toThrow(TxError);
    expect(() => buildOffer({ payee: "nope", title: "ok", amount: 1_000_000n, period: 60n })).toThrow(TxError);
  });
});

describe("collector key", () => {
  const never = async () => false;
  it("derives the address of a secp256k1 gpub", async () => {
    expect(await checkCollectorKey(`  ${GPUB}\n`, CREATOR, never)).toEqual({ ok: true, gpub: GPUB, address: COLLECTOR });
  });
  it("accepts the key as gnokey list prints it, with its trailing comma", async () => {
    expect(normalizeKeyText(` ${GPUB}, `)).toBe(GPUB);
    expect(await checkCollectorKey(`${GPUB},`, CREATOR, never)).toEqual({ ok: true, gpub: GPUB, address: COLLECTOR });
  });
  it("anything that does not start with gpub1 is marked for removal: it may be a secret", async () => {
    for (const secret of [
      "abandon ability able about above absent absorb abstract absurd abuse access accident",
      "abandon,ability,able,about,above,absent,absorb,abstract,absurd,abuse,access,accident",
      "0x" + "ab".repeat(32),
      "ab".repeat(32),
      "ábaco abdomen abeja abierto abogado abono aborto abrazo abrir abuelo abuso acabar",
      "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5",
    ]) {
      expect(mustRemove(secret), secret).toBe(true);
      expect(await checkCollectorKey(secret, CREATOR, never)).toMatchObject({ ok: false, cleared: true, reason: expect.stringMatching(/removed it/) });
    }
    expect(mustRemove(GPUB)).toBe(false);
    expect(mustRemove("")).toBe(false);
    expect(mustRemove("gpub1 broken")).toBe(false); // starts with gpub1: kept, refused as not a key
  });
  it("refuses what is not a public key, before anything else", async () => {
    expect(await checkCollectorKey("", CREATOR, never)).toMatchObject({ ok: false, reason: expect.stringMatching(/starts with gpub1/) });
    expect(await checkCollectorKey("gpub1 abc", CREATOR, never)).toMatchObject({ ok: false, reason: expect.stringMatching(/one word starting with gpub1/) });
    expect(await checkCollectorKey(GPUB.slice(0, -1) + "q", CREATOR, never)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a secp256k1/) });
  });
  it("refuses the creator's own key and a key whose address is already an account", async () => {
    expect(await checkCollectorKey(GPUB, COLLECTOR, never)).toMatchObject({ ok: false, address: COLLECTOR, reason: expect.stringMatching(/your own wallet/) });
    expect(await checkCollectorKey(GPUB, CREATOR, async (a) => a === COLLECTOR)).toMatchObject({ ok: false, address: COLLECTOR, reason: expect.stringMatching(/already received coins/) });
  });
  it("SetCollectorKey(gpub), signed by the creator", () => {
    expect(buildSetCollectorKey({ payee: CREATOR, gpub: GPUB })).toEqual({ type: "/vm.m_call", value: { caller: CREATOR, send: "", pkg_path: REALM, func: "SetCollectorKey", args: [GPUB] } });
    expect(() => buildSetCollectorKey({ payee: CREATOR, gpub: "gpub1zzz" })).toThrow();
  });
});

describe("deposits and the collector command", () => {
  it("estimates from what the realm holds for the creator", () => {
    expect(depositFor("offer", { hasRecord: false, hasKey: false })).toBe(DEPOSIT.planNewCreator);
    expect(depositFor("offer", { hasRecord: true, hasKey: false })).toBe(DEPOSIT.planLater);
    expect(depositFor("key", { hasRecord: false, hasKey: false })).toBe(DEPOSIT.keyNewCreator);
    expect(depositFor("key", { hasRecord: true, hasKey: false })).toBe(DEPOSIT.keyFirst);
    expect(depositFor("key", { hasRecord: true, hasKey: true })).toBe(0n);
  });
  it("prints the command collect.sh accepts for Onyx", () => {
    expect(collectorCommand({ payee: CREATOR, home: "~/mandate-collector", keyName: "collector" })).toBe(
      `scripts/collect.sh -home ~/mandate-collector -key collector -payee ${CREATOR} -remote https://rpc.onyx.testnets.gno.land:443 -chainid onyx-1 -realm ${REALM}`,
    );
  });
});
