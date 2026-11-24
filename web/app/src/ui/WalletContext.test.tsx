import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWallet, WalletProvider } from "./WalletContext";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const A = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";
const B = "g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj";
const ok = (data: unknown) => ({ code: 0, status: "success", type: "SUCCESS", message: "", data });

/** A stand-in for Adena whose GetAccount replies the test releases one by one, in any order. */
function fakeAdena() {
  const handlers: Record<string, (() => void)[]> = {};
  // a reply is an address, or an Error for a GetAccount() that rejects (Adena locked, the site disconnected in Adena)
  const replies: ((address: string | Error) => void)[] = [];
  const adena = {
    AddEstablish: async () => ok({}),
    GetAccount: () =>
      new Promise((resolve, reject) => replies.push((address) => (address instanceof Error ? reject(address) : resolve(ok({ address, chainId: "onyx-1" }))))),
    SwitchNetwork: async () => ok({}),
    AddNetwork: async () => ok({}),
    DoContract: async () => ok({}),
    On: (event: string, cb: () => void) => {
      (handlers[event] ??= []).push(cb);
    },
  };
  return { adena, handlers, replies, fire: (event: string) => act(async () => handlers[event]?.forEach((h) => h())) };
}

let wallet: ReturnType<typeof useWallet>;
function Probe() {
  wallet = useWallet();
  return null;
}

let root: Root;
let fake: ReturnType<typeof fakeAdena>;
beforeEach(() => {
  fake = fakeAdena();
  (globalThis as any).adena = fake.adena;
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  delete (globalThis as any).adena;
});

async function connect(address: string) {
  let done!: Promise<void>;
  await act(async () => {
    done = wallet.connect();
  });
  await act(async () => fake.replies.shift()!(address));
  await act(async () => done);
}

describe("WalletProvider and Adena's events", () => {
  it("registers each listener once per wallet, whatever re-renders, StrictMode and reconnections happen", async () => {
    await act(async () =>
      root.render(
        <StrictMode>
          <WalletProvider>
            <Probe />
          </WalletProvider>
        </StrictMode>,
      ),
    );
    await connect(A);
    await act(async () => wallet.disconnect());
    await connect(A);
    expect(fake.handlers.changedAccount).toHaveLength(1);
    expect(fake.handlers.changedNetwork).toHaveLength(1);
  });

  it("follows an account change while connected; ignores events once disconnected (never reconnects on its own)", async () => {
    await act(async () =>
      root.render(
        <WalletProvider>
          <Probe />
        </WalletProvider>,
      ),
    );
    await fake.fire("changedAccount"); // not connected yet: nothing is asked
    expect(fake.replies).toHaveLength(0);
    await connect(A);
    expect(wallet.address).toBe(A);
    await fake.fire("changedAccount");
    await act(async () => fake.replies.shift()!(B));
    expect(wallet.address).toBe(B);
    await act(async () => wallet.disconnect());
    await fake.fire("changedAccount");
    await fake.fire("changedNetwork");
    expect(fake.replies).toHaveLength(0);
    expect(wallet.address).toBeNull();
  });

  it("a GetAccount() that rejects after an event clears the address and the network; later events are ignored until connecting again", async () => {
    await act(async () =>
      root.render(
        <WalletProvider>
          <Probe />
        </WalletProvider>,
      ),
    );
    await connect(A);
    expect(wallet.chainId).toBe("onyx-1");
    await fake.fire("changedAccount");
    await act(async () => fake.replies.shift()!(new Error("locked")));
    expect(wallet.address).toBeNull();
    expect(wallet.chainId).toBeNull();
    expect(wallet.onRightNetwork).toBe(false);
    await fake.fire("changedAccount");
    await fake.fire("changedNetwork");
    expect(fake.replies).toHaveLength(0);
    expect(wallet.address).toBeNull();
    await connect(B);
    expect(wallet.address).toBe(B);
    expect(wallet.chainId).toBe("onyx-1");
    await fake.fire("changedAccount"); // connected again: events count again
    expect(fake.replies).toHaveLength(1);
  });

  it("an older GetAccount reply that arrives late does not overwrite a newer one, nor a disconnect", async () => {
    await act(async () =>
      root.render(
        <WalletProvider>
          <Probe />
        </WalletProvider>,
      ),
    );
    await connect(A);
    await fake.fire("changedAccount");
    await fake.fire("changedAccount");
    const [older, newer] = fake.replies.splice(0);
    await act(async () => newer(B));
    await act(async () => older(A));
    expect(wallet.address).toBe(B);
    await fake.fire("changedAccount");
    await act(async () => wallet.disconnect());
    await act(async () => fake.replies.shift()!(A));
    expect(wallet.address).toBeNull();
  });
});
