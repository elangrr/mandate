import { describe, expect, it } from "vitest";
import { parseBalance, parseSession, parseSessions, ReadError } from "./rpc";

const ok = (data: string) => ({ data, error: null, log: "" });

describe("chain answers parsed strictly", () => {
  it("a permission's expiry that does not parse is an error, never 'no expiry'", () => {
    const s = (expires: unknown) => ok(JSON.stringify({ expires_at: expires, spend_limit: "1100000ugnot", spend_period: "60", allow_paths: [] }));
    expect(parseSession(s("1800000000"))!.expiresAt).toBe(1_800_000_000n);
    expect(parseSession(ok(JSON.stringify({ spend_limit: "1ugnot" })))!.expiresAt).toBe(0n); // omitted = zero in amino JSON
    for (const bad of ["soon", "-5", { x: 1 }, true, 1.5]) expect(() => parseSession(s(bad))).toThrow(ReadError);
  });

  it("the balance counts the exact ugnot denomination only", () => {
    expect(parseBalance(ok('"123ugnot"'))).toBe(123n);
    expect(parseBalance(ok('"5foo,123ugnot"'))).toBe(123n);
    expect(parseBalance(ok('"999ugnotx,7ugnot"'))).toBe(7n);
    expect(parseBalance(ok('"999xugnot"'))).toBe(0n);
    expect(parseBalance(ok("123ugnot"))).toBe(123n);
    expect(parseBalance(ok('""'))).toBe(0n);
  });

  it("a wallet's permission list: JSON null is none; an empty or malformed answer is unreadable, never none", () => {
    expect(parseSessions(ok("null"))).toEqual([]);
    for (const bad of ["", "{}", "[{}]", '[{"BaseSessionAccount":{"BaseAccount":{"address":"nope"}}}]']) expect(() => parseSessions(ok(bad))).toThrow(ReadError);
  });
});
