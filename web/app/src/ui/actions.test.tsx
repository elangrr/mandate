import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { clearPending, onChain } from "../lib/pending";
import type { Msg } from "../lib/tx";
import { send, type Outcome } from "../lib/wallet";
import { useRunner, type Runner, type StepPlan } from "./actions";

vi.mock("../lib/wallet", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/wallet")>()), send: vi.fn() }));
vi.mock("../lib/pending", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/pending")>()), onChain: vi.fn() }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SIGNER = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";
const KEY = "g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj";
const msg = { type: "/vm.m_call", value: {} } as unknown as Msg;
const step = (label: string, extra: Partial<StepPlan> = {}): StepPlan => ({
  label,
  messages: () => [msg],
  gas: { gasWanted: 5_000_000, gasFee: 10_000 },
  check: { kind: "permission-gone", key: KEY },
  ...extra,
});
const inBlock: Outcome = { kind: "in-block", hash: "ABC", height: 5n };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sendMock = vi.mocked(send);
const onChainMock = vi.mocked(onChain);

let runner: Runner;
function Probe() {
  runner = useRunner();
  return null;
}

let root: Root;
let mounted = false;
beforeEach(async () => {
  sendMock.mockReset();
  onChainMock.mockReset();
  clearPending(SIGNER);
  sessionStorage.clear();
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  mounted = true;
});
afterEach(async () => {
  await leave();
  vi.useRealTimers();
  clearPending(SIGNER);
});

/** The page is left: the runner's panel unmounts. */
async function leave() {
  if (!mounted) return;
  mounted = false;
  await act(async () => root.unmount());
}

/** Waits for the run to end, with the page's last updates applied. */
async function settle(out: Promise<string>): Promise<string> {
  let r = "";
  await act(async () => {
    r = await out;
  });
  return r;
}

/** Starts a run and returns as soon as it is under way (the run itself is in `out`). */
async function start(prepare: () => Promise<StepPlan[] | string>): Promise<{ out: Promise<string> }> {
  let out!: Promise<string>;
  await act(async () => {
    out = runner.run(SIGNER, prepare);
  });
  return { out }; // wrapped: an async function returning a promise would wait for it
}

describe("useRunner: no popup once the page is left; a step already sent is still watched", () => {
  it("control: while the page stays open, approval 2 opens once approval 1 is on chain", async () => {
    sendMock.mockResolvedValue(inBlock);
    onChainMock.mockResolvedValue(true);
    const { out } = await start(async () => [step("Approval 1"), step("Approval 2")]);
    expect(await settle(out)).toBe("done");
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("left while the fresh read before approval 1 is in flight: approval 1 is never requested", async () => {
    const prep = deferred<StepPlan[]>();
    const { out } = await start(() => prep.promise);
    await leave();
    prep.resolve([step("Approval 1"), step("Approval 2")]);
    const r = await out;
    expect(sendMock).not.toHaveBeenCalled();
    expect(r).toBe("left");
  });

  it("left after approval 1 is sent, and it confirms: approval 2 is never requested", async () => {
    const sent = deferred<Outcome>();
    sendMock.mockImplementationOnce(() => sent.promise);
    onChainMock.mockResolvedValue(true);
    const { out } = await start(async () => [step("Approval 1"), step("Approval 2")]);
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    await leave();
    sent.resolve(inBlock);
    const r = await out;
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(onChainMock).toHaveBeenCalled(); // approval 1 was still watched until the chain showed it
    expect(r).toBe("left");
    expect(sessionStorage.getItem("mandate.pending.v1") ?? "{}").toBe("{}");
  });

  it("left after a step is sent, and the chain does not show it in time: it is still recorded as pending", async () => {
    vi.useFakeTimers();
    const sent = deferred<Outcome>();
    sendMock.mockImplementationOnce(() => sent.promise);
    onChainMock.mockResolvedValue(false);
    const { out } = await start(async () => [step("Approval 1"), step("Approval 2")]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    await leave();
    sent.resolve({ kind: "unconfirmed", hash: "ABC" });
    await vi.advanceTimersByTimeAsync(config.confirmWaitMs + 5_000);
    expect(await out).toBe("pending");
    const stored = JSON.parse(sessionStorage.getItem("mandate.pending.v1") ?? "{}");
    expect(stored[SIGNER]).toEqual({ payer: SIGNER, label: "Approval 1", hash: "ABC", check: { kind: "permission-gone", key: KEY }, tries: 0 });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("left while the check right before approval 2 is in flight: approval 2 is never requested", async () => {
    const pre = deferred<string | null>();
    const precheck = vi.fn(() => pre.promise);
    sendMock.mockResolvedValue(inBlock);
    onChainMock.mockResolvedValue(true);
    const { out } = await start(async () => [step("Approval 1"), step("Approval 2", { precheck })]);
    await vi.waitFor(() => expect(precheck).toHaveBeenCalledTimes(1));
    expect(sendMock).toHaveBeenCalledTimes(1);
    await leave();
    pre.resolve(null); // nothing changed on chain
    const r = await out;
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(r).toBe("left");
  });
});

describe("useRunner: when the check before a later step stops it", () => {
  it("says what changed and that the step was not sent, never that what went before stays on chain", async () => {
    sendMock.mockResolvedValue(inBlock);
    onChainMock.mockResolvedValue(true);
    const { out } = await start(async () => [step("Approval 1"), step("Approval 2", { precheck: async () => "Your permission for the creator’s collector key is gone." })]);
    expect(await settle(out)).toBe("changed");
    expect(runner.error).toBe("Your permission for the creator’s collector key is gone. So “Approval 2” was not sent. The page now shows the current state.");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("a check that cannot read the chain: the step was not sent; try again", async () => {
    sendMock.mockResolvedValue(inBlock);
    onChainMock.mockResolvedValue(true);
    const { out } = await start(async () => [step("Approval 1"), step("Approval 2", { precheck: () => Promise.reject(new Error("timed out")) })]);
    expect(await settle(out)).toBe("changed");
    expect(runner.error).toBe("Unable to read the chain just now. So “Approval 2” was not sent. Try again in a moment.");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
