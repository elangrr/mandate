import { afterEach, describe, expect, it } from "vitest";
import { config } from "../config";
import { send, WalletError } from "./wallet";

const SIGNER = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";
const PARAMS = { messages: [{}], memo: "", gasWanted: 5_000_000, gasFee: 7_500, commit: true as const };

/** A fake injected wallet whose DoContract answers `reply`, as Adena v1.22.5 would. */
function wallet(reply: unknown) {
  const calls: unknown[] = [];
  (globalThis as any).adena = {
    GetAccount: async () => ({ status: "success", type: "SUCCESS", code: 0, message: "", data: { address: SIGNER, chainId: config.chainId } }),
    DoContract: async (p: unknown) => {
      calls.push(p);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return calls;
}
afterEach(() => delete (globalThis as any).adena);

const okBlock = {
  status: "success",
  type: "TRANSACTION_SUCCESS",
  data: { hash: "A1B2C3", height: "120", check_tx: { ResponseBase: { Error: null, Log: "" } }, deliver_tx: { ResponseBase: { Error: null, Log: "" } } },
};

describe("send: what the wallet's reply means", () => {
  it("passes commit: true and reads a block result as in the block", async () => {
    const calls = wallet(okBlock);
    expect(await send(SIGNER, PARAMS)).toEqual({ kind: "in-block", hash: "A1B2C3", height: 120n });
    expect((calls[0] as any).commit).toBe(true);
  });

  it("a reply without a block result (only queued) is unconfirmed: the page must read the chain", async () => {
    wallet({ status: "success", type: "TRANSACTION_SUCCESS", data: { hash: "A1B2C3", Log: "", data: null, error: null } });
    expect(await send(SIGNER, PARAMS)).toEqual({ kind: "unconfirmed", hash: "A1B2C3" });
  });

  it("a refusal in the block (TRANSACTION_FAILED with the chain's log) is a refusal in plain words", async () => {
    wallet({ status: "failure", type: "TRANSACTION_FAILED", data: { hash: "A1", error: "unauthorized error", log: "session key address collides with existing account" } });
    const e = await send(SIGNER, PARAMS).catch((x) => x);
    expect(e).toBeInstanceOf(WalletError);
    expect(e.kind).toBe("refused");
    expect(e.message).toMatch(/collector key can no longer be used/);
    expect(e.message).toMatch(/Check the page and try again/);
  });

  it("the realm's own words come through, cut to a sane length", async () => {
    wallet({ status: "failure", type: "TRANSACTION_FAILED", data: { hash: "A1", error: "unknown error: /vm.VMError", log: "panic: mandate: you already have an active mandate for this plan" + "x".repeat(500) } });
    const e = await send(SIGNER, PARAMS).catch((x) => x);
    expect(e.kind).toBe("refused");
    expect(e.message).toMatch(/^The chain refused it: mandate: you already have an active mandate for this plan/);
    expect(e.message.length).toBeLessThan(320);
  });

  it("a session limit and a missing session read plainly", async () => {
    wallet({ status: "failure", type: "TRANSACTION_FAILED", data: { hash: "A1", error: "x", log: "too many sessions: count=16, max=16" } });
    expect((await send(SIGNER, PARAMS).catch((x) => x)).message).toMatch(/16 permissions/);
    wallet({ status: "failure", type: "TRANSACTION_FAILED", data: { hash: "A1", error: "x", log: "session not found" } });
    expect((await send(SIGNER, PARAMS).catch((x) => x)).message).toMatch(/not on chain any more/);
  });

  it("a deliver_tx error inside a success reply is a refusal too", async () => {
    wallet({ ...okBlock, data: { ...okBlock.data, deliver_tx: { ResponseBase: { Error: { "@type": "/std.OutOfGasError" }, Log: "out of gas" } } } });
    expect((await send(SIGNER, PARAMS).catch((x) => x)).kind).toBe("refused");
  });

  it("cancelled in Adena: nothing was sent", async () => {
    wallet({ status: "failure", type: "TRANSACTION_REJECTED", data: {} });
    const e = await send(SIGNER, PARAMS).catch((x) => x);
    expect(e.kind).toBe("rejected");
  });

  it("a time-out, a failure without the chain's answer, a throw, or an odd shape: unconfirmed, never success", async () => {
    for (const reply of [
      { status: "failure", type: "NETWORK_TIMEOUT", data: {} },
      { status: "failure", type: "TRANSACTION_FAILED", data: { hash: "A1", error: "Error: timed out waiting for tx to be included in a block" } },
      { status: "failure", type: "TRANSACTION_FAILED", data: { hash: "A1", error: null } },
      new Error("boom"),
      null,
      "ok",
      { status: "success" },
      { status: "success", data: { hash: 42, height: "1" } },
      { status: "success", data: { hash: "A1", height: "-3", deliver_tx: { ResponseBase: {} } } },
      { status: "weird", data: {} },
    ]) {
      wallet(reply);
      const out = await send(SIGNER, PARAMS);
      expect(out.kind, JSON.stringify(reply)).toBe("unconfirmed");
    }
  });

  it("checks the network and the account before opening a popup", async () => {
    const calls = wallet(okBlock);
    (globalThis as any).adena.GetAccount = async () => ({ status: "success", data: { address: SIGNER, chainId: "other-1" } });
    expect((await send(SIGNER, PARAMS).catch((x) => x)).kind).toBe("wrong-network");
    (globalThis as any).adena.GetAccount = async () => ({ status: "success", data: { address: "g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj", chainId: config.chainId } });
    expect((await send(SIGNER, PARAMS).catch((x) => x)).kind).toBe("failed");
    expect(calls).toHaveLength(0);
  });
});
