import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Plan } from "./amino";
import { buildCancel, buildCreateSession, buildRevokeSession, buildSubscribe, checkGas, doContractParams, fromBase64, gasFor, minFee, pubFromGpub, TxError } from "./tx";

// A fixed plan and keys (from a local test chain), so the requests are stable.
const GPUB = "gpub1pgfj7ard9eg82cjtv4u4xetrwqer2dntxyfzxz3pqfp0696ldln2nm7kd33zfpgypg6u0e7upl03hyeexa6mccn4ce8mkswg65c";
const COLLECTOR = "g1psdsf789f4xw3qrpjue54g2h28syd09yfkrxdh";
const SUPPORTER = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";
const plan: Plan = {
  id: 1n, payee: "g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj", title: "Support Fluxen's work", amount: 1_000_000n, period: 2_592_000n,
  createdAt: 0n, mandates: 0, cancelled: 0, paidThisPeriod: 0, paidLastPeriod: 0, periodStart: 0n, pulls: 0n, paid: 0n, lastPullAt: 0n,
};
const END = 1_826_000_000n;
const ONYX = { gas: 1000n, amount: 1n };

/** Every request the app sends, as Adena's DoContract receives it. */
export function appRequests() {
  const session = buildCreateSession({ creator: SUPPORTER, collectorKey: GPUB, plan, expiresAt: END });
  const subscribe = buildSubscribe({ payer: SUPPORTER, planId: plan.id, sessionAddr: COLLECTOR, expiresAt: END });
  const revoke = buildRevokeSession({ creator: SUPPORTER, pub33: pubFromGpub(GPUB) });
  const cancel = buildCancel({ payer: SUPPORTER, sessionAddr: COLLECTOR });
  const p = (x: unknown) => JSON.parse(JSON.stringify(x));
  return {
    subscribeStep1: p(doContractParams([session], gasFor("session", ONYX))),
    subscribeStep2: p(doContractParams([subscribe], gasFor("call", ONYX))),
    subscribeOneApproval: p(doContractParams([session, subscribe], gasFor("sessionAndCall", ONYX))),
    stopStep1: p(doContractParams([revoke], gasFor("session", ONYX))),
    stopStep2: p(doContractParams([cancel], gasFor("call", ONYX))),
    stopOneApproval: p(doContractParams([revoke, cancel], gasFor("sessionAndCall", ONYX))),
  };
}

describe("transaction builders", () => {
  it("the permission is exactly the plan's terms", () => {
    const m = buildCreateSession({ creator: SUPPORTER, collectorKey: GPUB, plan, expiresAt: END });
    expect(m.value.spend_limit).toBe("1100000ugnot");
    expect(m.value.spend_period).toBe("2592000");
    expect(m.value.allow_paths).toEqual(["vm/exec:gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate"]);
    expect(m.value.expires_at).toBe("1826000000");
    expect(m.value.session_key.type_url).toBe("/tm.PubKeySecp256k1");
    expect(Array.from(fromBase64(m.value.session_key.value).subarray(0, 2))).toEqual([0x0a, 0x21]);
  });

  it("refuses what the chain or the realm would", () => {
    expect(() => buildCreateSession({ creator: "g1nope", collectorKey: GPUB, plan, expiresAt: END })).toThrow(TxError);
    expect(() => buildCreateSession({ creator: SUPPORTER, collectorKey: "gpub1xyz", plan, expiresAt: END })).toThrow(TxError);
    expect(() => buildCreateSession({ creator: SUPPORTER, collectorKey: GPUB.slice(0, -1) + "x", plan, expiresAt: END })).toThrow(TxError); // checksum
    expect(() => buildCreateSession({ creator: SUPPORTER, collectorKey: GPUB, plan: { ...plan, period: 2_592_001n }, expiresAt: END })).toThrow(TxError);
    expect(() => buildSubscribe({ payer: SUPPORTER, planId: 0n, sessionAddr: COLLECTOR, expiresAt: END })).toThrow(TxError);
    expect(() => buildCancel({ payer: SUPPORTER, sessionAddr: "x" })).toThrow(TxError);
  });

  it("gas: never zero, never Adena's default, at least the chain's minimum fee", () => {
    expect(() => checkGas({ gasWanted: 0, gasFee: 10 })).toThrow(TxError);
    expect(() => checkGas({ gasWanted: 5_000_000, gasFee: 0 })).toThrow(TxError);
    expect(() => checkGas({ gasWanted: 2_000_000_000, gasFee: 100_000 })).toThrow(TxError);
    for (const kind of ["session", "call", "sessionAndCall"] as const) {
      const g = gasFor(kind, ONYX);
      expect(g.gasFee).toBeGreaterThanOrEqual(minFee(g.gasWanted, ONYX));
    }
    expect(gasFor("session", ONYX)).toEqual({ gasWanted: 5_000_000, gasFee: 7_500 });
    expect(minFee(1, { gas: 1000n, amount: 1n })).toBe(1);
  });

  it("requests are one or two messages, and match web/adena-check/app-requests.json", () => {
    expect(() => doContractParams([], gasFor("session", ONYX))).toThrow(TxError);
    const file = "../adena-check/app-requests.json";
    const now = JSON.stringify(appRequests(), null, 1) + "\n";
    if (process.env.UPDATE_ADENA_REQUESTS) writeFileSync(file, now);
    expect(readFileSync(file, "utf8")).toBe(now);
  });
});
