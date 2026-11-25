import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorGuide } from "./creatorActions";
import { WalletProvider } from "./WalletContext";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ADDR = "g1lkf7akafx3xdq6ds4c8rknj5ha95wufhrgrd0k";
let unmount: (() => void) | null = null;
afterEach(() => {
  act(() => unmount?.());
  unmount = null;
});

async function guide(address: string): Promise<HTMLElement> {
  const el = document.createElement("div");
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <WalletProvider>
        <CollectorGuide address={address} />
      </WalletProvider>,
    ),
  );
  unmount = () => root.unmount();
  return el;
}

const crontab = (el: HTMLElement) => el.querySelector('[aria-label^="Two lines for crontab"]')?.textContent ?? "";

describe("CollectorGuide: running on a schedule is shown in every state", () => {
  it("no wallet and no address: the schedule, the crontab lines with the placeholder, and what to replace", async () => {
    const el = await guide("");
    const text = el.textContent ?? "";
    expect(text).toContain("Nothing takes a payment by itself: each payment is taken when the collector runs");
    expect(text).toContain("To run it unattended");
    expect(crontab(el)).toMatch(/\*\/10 \* \* \* \* cd ~\/mandate && scripts\/collect\.sh .*-payee YOUR_ADDRESS /);
    expect(text).toContain("Replace /home/YOU/go/bin with the folder where gnokey is, and YOUR_ADDRESS with your creator address.");
    expect(text).not.toContain("Copy the command");
  });

  it("with an address in the link: the same section, filled in, and no placeholder to replace", async () => {
    const el = await guide(ADDR);
    const text = el.textContent ?? "";
    expect(text).toContain("Nothing takes a payment by itself");
    expect(crontab(el)).toContain(`-payee ${ADDR} `);
    expect(text).not.toContain("YOUR_ADDRESS");
    expect(text).toContain("Replace /home/YOU/go/bin with the folder where gnokey is. */10 runs it every 10 minutes");
    expect(text).toContain("Copy the command");
  });
});
