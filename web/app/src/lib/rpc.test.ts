import { describe, expect, it } from "vitest";
import fixture from "../__fixtures__/chain.json";
import { config } from "../config";
import { evalError, parseBalance, parseSession, parseSessions, ReadError } from "./rpc";

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

describe("a failed realm query: 'not live' only when the realm's own package is missing", () => {
  // a real answer of gno v1.8.0 (local gnodev; Onyx answers the same) for a query on a package that is not there
  const missing = fixture.qeval_json["missing realm"] as { data: string; error: string; log: string };
  const forPath = (path: string) => ({ ...missing, log: missing.log.replaceAll("gno.land/r/nobody/here", path) });

  it("the realm's package not found: not live", () => {
    const e = evalError(forPath(config.realmPath));
    expect(e.kind).toBe("not-live");
    expect(e.message).toBe("Mandate is not live on the network yet.");
  });

  it("any other error is the chain's own words, even with 'not found' or 'inert' in it", () => {
    // another package (a longer path that starts with the realm's included)
    expect(evalError(forPath(config.realmPath + "/sub")).kind).toBe("chain");
    expect(evalError(missing).kind).toBe("chain");
    // the same words under another error type
    const other = { data: "", error: `object not found; package not found: ${config.realmPath}`, log: `package not found: ${config.realmPath}` };
    expect(evalError(other).kind).toBe("chain");
    expect(evalError(other).message).toBe(other.error);
    // what Onyx answers for a name the realm does not declare
    const undeclared = { data: "", error: `${config.realmPath}:0:0: name NoSuchFunc not declared`, log: "" };
    expect(evalError(undeclared)).toMatchObject({ kind: "chain", message: undeclared.error });
    expect(evalError({ data: "", error: "inert", log: "inert" }).kind).toBe("chain");
  });
});
