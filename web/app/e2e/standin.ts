// A stand-in for the Adena wallet in end-to-end tests: the same injected API
// (window.adena: AddEstablish, GetAccount, SwitchNetwork, AddNetwork,
// DoContract, On) and the same response shapes, but it signs with a
// throwaway key of the LOCAL test chain through gnokey (explicit -home and
// -remote, chain id "dev"). Differences from Adena, on purpose: it signs the
// gas the page sends (Adena simulates a request that contains a realm call
// and signs its own estimate), and it never shows a popup; tests decide
// whether a request is approved or refused.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";

const PW = "throwaway-local-only";

export interface StandinChain {
  kb: string;
  gnohome: string;
  rpc: string; // 127.0.0.1:port
}

export interface StandinOptions {
  key: string; // name in the test keybase
  address: string;
  chainId?: string; // what GetAccount reports first (wrong network tests)
  /** refuse requests whose messages match: the test's "Reject" click */
  refuse?: (messages: any[]) => boolean;
  /** runs after the page's request arrives and before it is signed: a test changes the chain here */
  before?: (params: any) => void;
}

function gnokey(c: StandinChain, args: string[], input?: string): string {
  return execFileSync("gnokey", [...args], { input, env: { ...process.env, GNOHOME: c.gnohome }, stdio: ["pipe", "pipe", "pipe"] }).toString();
}

/** Adena's JSON message -> the chain's amino JSON message. */
function toAmino(m: any): any {
  const v = m.value;
  switch (m.type) {
    case "/vm.m_call":
      return { "@type": "/vm.m_call", caller: v.caller, send: v.send, max_deposit: "", pkg_path: v.pkg_path, func: v.func, args: v.args };
    case "/auth.m_create_session":
    case "/auth.m_revoke_session": {
      const any = Buffer.from(v.session_key.value, "base64");
      if (v.session_key.type_url !== "/tm.PubKeySecp256k1" || any.length !== 35 || any[0] !== 0x0a || any[1] !== 0x21) throw new Error("odd session key");
      const key = { "@type": "/tm.PubKeySecp256k1", value: any.subarray(2).toString("base64") };
      return m.type === "/auth.m_create_session"
        ? { "@type": "/auth.m_create_session", creator: v.creator, session_key: key, expires_at: v.expires_at, allow_paths: v.allow_paths, spend_limit: v.spend_limit, spend_period: v.spend_period }
        : { "@type": "/auth.m_revoke_session", creator: v.creator, session_key: key };
    }
  }
  throw new Error("unexpected message type " + m.type);
}

/** Signs and broadcasts one request; returns what Adena's DoContract would. */
export function signAndSend(c: StandinChain, o: StandinOptions, params: any): any {
  if (!params || !Array.isArray(params.messages) || !Number.isSafeInteger(params.gasWanted) || !Number.isSafeInteger(params.gasFee) || params.gasWanted <= 0 || params.gasFee <= 0)
    return { code: 4000, status: "failure", type: "INVALID_FORMAT", message: "bad request", data: {} };
  if (o.refuse?.(params.messages)) return { code: 4001, status: "failure", type: "TRANSACTION_REJECTED", message: "rejected", data: {} };
  o.before?.(params);
  const dir = mkdtempSync(join(tmpdir(), "standin-"));
  try {
    const acct = JSON.parse(gnokey(c, ["query", `auth/accounts/${o.address}`, "-remote", c.rpc, "-home", c.kb]).split("data:")[1]);
    const base = acct.BaseAccount ?? acct;
    const tx = { msg: params.messages.map(toAmino), fee: { gas_wanted: String(params.gasWanted), gas_fee: `${params.gasFee}ugnot` }, signatures: null, memo: params.memo ?? "" };
    const f = join(dir, "tx.json");
    writeFileSync(f, JSON.stringify(tx));
    // gnokey sign writes the signature (not the signed tx) to -output-document
    const sig = join(dir, "sig.json");
    gnokey(
      c,
      ["sign", "-tx-path", f, "-chainid", "dev", "-account-number", base.account_number, "-account-sequence", base.sequence ?? "0", "-output-document", sig, "-home", c.kb, "-insecure-password-stdin", o.key],
      PW + "\n",
    );
    writeFileSync(f, JSON.stringify({ ...tx, signatures: [JSON.parse(readFileSync(sig, "utf8"))] }));
    let out: string;
    try {
      out = gnokey(c, ["broadcast", f, "-remote", c.rpc, "-home", c.kb]);
    } catch (e: any) {
      out = String(e.stdout ?? "") + String(e.stderr ?? "");
    }
    const hash = /TX HASH:\s*(\S+)/.exec(out)?.[1] ?? "";
    const height = /HEIGHT:\s*(\d+)/.exec(out)?.[1] ?? "0";
    if (/^OK!/m.test(out)) return { code: 0, status: "success", type: "TRANSACTION_SUCCESS", message: "", data: { hash, height } };
    // a failure the chain reports: Adena returns it inside the response data
    return { code: 0, status: "success", type: "TRANSACTION_SUCCESS", message: "", data: { hash, height, deliverTx: { ResponseBase: { Error: { value: "error" }, Log: out } } } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Installs the stand-in in a page. Call before page.goto. */
export async function installStandin(page: Page, c: StandinChain, o: StandinOptions): Promise<{ calls: any[] }> {
  const calls: any[] = [];
  await page.exposeFunction("__standinDoContract", (params: any) => {
    calls.push(params);
    return signAndSend(c, o, params);
  });
  await page.addInitScript(
    ({ address, chainId }) => {
      let chain = chainId;
      const ok = (data: unknown) => ({ code: 0, status: "success", type: "SUCCESS", message: "", data });
      (window as any).adena = {
        AddEstablish: async () => ok({}),
        GetAccount: async () => ok({ address, chainId: chain, coins: "", status: "ACTIVE" }),
        SwitchNetwork: async (id: string) => {
          chain = id;
          return ok({});
        },
        AddNetwork: async () => ok({}),
        DoContract: async (p: unknown) => (window as any).__standinDoContract(p),
        On: () => undefined,
      };
    },
    { address: o.address, chainId: o.chainId ?? "dev" },
  );
  return { calls };
}

export function chainFromEnv(): StandinChain & { keys: any; realm: string; tmp: string } {
  const j = JSON.parse(readFileSync(process.env.MD_CHAIN!, "utf8"));
  return { kb: j.kb, gnohome: j.gnohome, rpc: j.rpc, keys: j.keys, realm: j.realm, tmp: j.tmp };
}

/** Runs the repository's collector once for Fluxen's plans (the creator's side of a payment). */
export function runCollector(c: StandinChain & { keys: any; realm: string; tmp?: string }): string {
  const repo = join(process.cwd(), "..", ".."); // tests run from web/app
  const tmp = (c as any).tmp as string;
  return execFileSync(
    join(repo, "scripts/collect.sh"),
    ["-home", c.kb, "-key", "collector", "-payee", c.keys.fluxen.addr, "-remote", c.rpc, "-chainid", "dev", "-realm", c.realm, "-state", join(tmp, "collect.state"), "-insecure-password-stdin"],
    { input: PW + "\n", env: { ...process.env, GNOHOME: c.gnohome, XDG_STATE_HOME: join(tmp, "xdg") } },
  ).toString();
}

/** A plain transfer from one test key to an address (used to make an address an account). */
export function sendCoins(c: StandinChain, fromKey: string, to: string, amount: string): void {
  gnokey(c, ["maketx", "send", "-to", to, "-send", amount, "-gas-fee", "100000ugnot", "-gas-wanted", "2000000", "-broadcast", "-chainid", "dev", "-remote", c.rpc, "-home", c.kb, "-insecure-password-stdin", fromKey], PW + "\n");
}
