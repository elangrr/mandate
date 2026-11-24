import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAsync, type Async } from "./hooks";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Reads that resolve only when the test says so. */
function reads() {
  const waiting: { key: string; resolve: (v: string) => void }[] = [];
  return {
    load: (key: string) => () => new Promise<string>((resolve) => waiting.push({ key, resolve })),
    answer: async (value: (key: string) => string) => {
      await act(async () => {
        for (const w of waiting.splice(0)) w.resolve(value(w.key));
      });
    },
  };
}

let root: Root;
let host: HTMLElement;
const seen: Async<string>[] = [];
let reloadNow: () => void = () => undefined;

function Probe({ load, deps, refresh }: { load: () => Promise<string>; deps: unknown[]; refresh?: unknown[] }) {
  const [s, reload] = useAsync(load, deps, refresh);
  seen.push(s);
  reloadNow = reload;
  return <p>{s.status === "ready" ? s.value : s.status}</p>;
}

beforeEach(() => {
  seen.length = 0;
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

describe("useAsync", () => {
  it("new deps (another address): loading at once, never the value read for the old ones", async () => {
    const r = reads();
    await act(async () => root.render(<Probe load={r.load("A")} deps={["A"]} />));
    await r.answer((k) => `rows of ${k}`);
    expect(host.textContent).toBe("rows of A");
    seen.length = 0;
    await act(async () => root.render(<Probe load={r.load("B")} deps={["B"]} />));
    // not even the first render with the new deps shows A's rows
    expect(seen.every((s) => s.status === "loading")).toBe(true);
    expect(host.textContent).toBe("loading");
    await r.answer((k) => `rows of ${k}`);
    expect(host.textContent).toBe("rows of B");
  });

  it("a change in `refresh` (a pending step settled) or a reload reads again in place", async () => {
    const r = reads();
    await act(async () => root.render(<Probe load={r.load("A")} deps={["A"]} refresh={[0]} />));
    await r.answer(() => "first");
    seen.length = 0;
    await act(async () => root.render(<Probe load={r.load("A")} deps={["A"]} refresh={[1]} />));
    expect(seen.every((s) => s.status === "ready" && s.value === "first")).toBe(true);
    await r.answer(() => "second");
    expect(host.textContent).toBe("second");
    seen.length = 0;
    await act(async () => reloadNow());
    expect(seen.every((s) => s.status === "ready" && s.value === "second")).toBe(true);
    await r.answer(() => "third");
    expect(host.textContent).toBe("third");
  });

  it("an older read that answers late never replaces a newer one", async () => {
    const waiting: ((v: string) => void)[] = [];
    const load = () => new Promise<string>((resolve) => waiting.push(resolve));
    await act(async () => root.render(<Probe load={load} deps={["A"]} />));
    await act(async () => root.render(<Probe load={load} deps={["B"]} />));
    await act(async () => waiting[waiting.length - 1]("B's"));
    await act(async () => waiting[0]("A's"));
    expect(host.textContent).toBe("B's");
  });
});
