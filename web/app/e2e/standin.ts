// A stand-in for the Adena wallet in end-to-end tests: the same injected API
// (window.adena: AddEstablish, GetAccount, SwitchNetwork, AddNetwork,
// DoContract, On) and the same reply shapes as Adena v1.22.5, but it signs
// with a throwaway key of the LOCAL test chain through gnokey (explicit -home
// and -remote, chain id "dev").
//
// Like Adena (pages/popup/wallet/approve-transaction-main/index.tsx):
// - with `commit: true` it waits for the block: success carries
//   {hash, height, check_tx, deliver_tx}; a refusal by the mempool or inside
//   the block comes back as {status: "failure", type: "TRANSACTION_FAILED",
//   data: {hash, error, log}};
// - without it (or with `queuedOnly`, an Adena that ignores commit) it answers
//   at once with {hash, Log, data, error} and the block happens later.
// Differences, on purpose: it signs the gas the page sends (Adena simulates a
// request that contains a realm call and signs its own estimate); in the
// queued mode it does not know the hash yet (Adena would) and a refusal by
// the mempool also arrives later; it never shows a popup, tests decide.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";

const run = promisify(execFile);
const PW = "throwaway-local-only";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  before?: (params: any) => Promise<void> | void;
  /** answer at once, before the block, whatever the page asks (an Adena that ignores `commit`) */
  queuedOnly?: boolean;
  /** wait this long before broadcasting: a slow block */
  delayMs?: number;
  /** replace the reply with something of another shape (after the transaction went out, unless `skipSend`) */
  mangle?: (reply: any) => any;
  skipSend?: boolean;
}

async function gnokey(c: StandinChain, args: string[], input?: string): Promise<{ out: string; ok: boolean }> {
  const p = run("gnokey", args, { env: { ...process.env, GNOHOME: c.gnohome } });
  if (input !== undefined) {
    p.child.stdin!.write(input);
    p.child.stdin!.end();
  }
  try {
    const r = await p;
    return { out: r.stdout + r.stderr, ok: true };
  } catch (e: any) {
    return { out: String(e.stdout ?? "") + String(e.stderr ?? ""), ok: false };
  }
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

/** Signs and broadcasts one request and waits for the block: the chain's answer. */
async function signAndBroadcast(c: StandinChain, o: { key: string; address: string }, params: any): Promise<{ ok: boolean; hash: string; height: string; out: string }> {
  const dir = mkdtempSync(join(tmpdir(), "standin-"));
  try {
    const q = await gnokey(c, ["query", `auth/accounts/${o.address}`, "-remote", c.rpc, "-home", c.kb]);
    const acct = JSON.parse(q.out.split("data:")[1]);
    const base = acct.BaseAccount ?? acct;
    const tx = { msg: params.messages.map(toAmino), fee: { gas_wanted: String(params.gasWanted), gas_fee: `${params.gasFee}ugnot` }, signatures: null, memo: params.memo ?? "" };
    const f = join(dir, "tx.json");
    writeFileSync(f, JSON.stringify(tx));
    // gnokey sign writes the signature (not the signed tx) to -output-document
    const sig = join(dir, "sig.json");
    const s = await gnokey(
      c,
      ["sign", "-tx-path", f, "-chainid", "dev", "-account-number", base.account_number, "-account-sequence", base.sequence ?? "0", "-output-document", sig, "-home", c.kb, "-insecure-password-stdin", o.key],
      PW + "\n",
    );
    if (!s.ok) throw new Error("stand-in could not sign: " + s.out);
    writeFileSync(f, JSON.stringify({ ...tx, signatures: [JSON.parse(readFileSync(sig, "utf8"))] }));
    const b = await gnokey(c, ["broadcast", f, "-remote", c.rpc, "-home", c.kb]);
    return {
      ok: b.ok && /^OK!/m.test(b.out),
      hash: /TX HASH:\s*(\S+)/.exec(b.out)?.[1] ?? "",
      height: /HEIGHT:\s*(\d+)/.exec(b.out)?.[1] ?? "0",
      out: b.out,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const failure = (type: string, data: any = {}) => ({ code: 4000, status: "failure", type, message: type, data });

/** Signs and sends one request the way Adena does; returns what Adena's DoContract would. */
export async function signAndSend(c: StandinChain, o: StandinOptions, params: any): Promise<any> {
  if (!params || !Array.isArray(params.messages) || !Number.isSafeInteger(params.gasWanted) || !Number.isSafeInteger(params.gasFee) || params.gasWanted <= 0 || params.gasFee <= 0)
    return failure("INVALID_FORMAT");
  if (o.refuse?.(params.messages)) return failure("TRANSACTION_REJECTED");
  await o.before?.(params);
  const mangle = (r: any) => (o.mangle ? o.mangle(r) : r);
  if (o.skipSend) return mangle(failure("TRANSACTION_FAILED", { hash: "", error: null }));
  const go = async () => {
    if (o.delayMs) await sleep(o.delayMs);
    return signAndBroadcast(c, o, params);
  };
  if (params.commit !== true || o.queuedOnly) {
    // the mempool took it; the block comes later
    void go().catch(() => undefined);
    return mangle({ code: 0, status: "success", type: "TRANSACTION_SUCCESS", message: "", data: { hash: "", Log: "", data: null, error: null } });
  }
  const r = await go();
  if (r.ok)
    return mangle({
      code: 0,
      status: "success",
      type: "TRANSACTION_SUCCESS",
      message: "",
      data: { hash: r.hash, height: r.height, check_tx: { ResponseBase: { Error: null, Log: "" } }, deliver_tx: { ResponseBase: { Error: null, Log: "" }, GasWanted: String(params.gasWanted), GasUsed: "0" } },
    });
  // Adena: TRANSACTION_FAILED with the TM2Error's text and the chain's log
  return mangle(failure("TRANSACTION_FAILED", { hash: r.hash, error: "unknown error: refused", log: r.out }));
}

/** Installs the stand-in in a page. Call before page.goto. */
export async function installStandin(page: Page, c: StandinChain, o: StandinOptions): Promise<{ calls: any[] }> {
  const calls: any[] = [];
  await page.exposeFunction("__standinDoContract", async (params: any) => {
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

/** Signs and sends a request outside the page (another tab of the same wallet), waiting for the block; true if the chain took it. */
export async function sendDirect(c: StandinChain, o: { key: string; address: string }, params: any): Promise<boolean> {
  return (await signAndBroadcast(c, o, params)).ok;
}

export function chainFromEnv(): StandinChain & { keys: any; realm: string; tmp: string } {
  const j = JSON.parse(readFileSync(process.env.MD_CHAIN!, "utf8"));
  return { kb: j.kb, gnohome: j.gnohome, rpc: j.rpc, keys: j.keys, realm: j.realm, tmp: j.tmp };
}

/** The wallet's permissions as the chain lists them (addresses of the keys). */
export async function sessionKeys(c: StandinChain, address: string): Promise<string[]> {
  const q = await gnokey(c, ["query", `auth/accounts/${address}/sessions`, "-remote", c.rpc, "-home", c.kb]);
  const d = JSON.parse(q.out.split("data:")[1] || "null") ?? [];
  return d.map((s: any) => s?.BaseSessionAccount?.BaseAccount?.address ?? "");
}

/** Runs the repository's collector once for Fluxen's plans (the creator's side of a payment). */
export async function runCollector(c: StandinChain & { keys: any; realm: string; tmp: string }): Promise<string> {
  const repo = join(process.cwd(), "..", ".."); // tests run from web/app
  const p = run(
    join(repo, "scripts/collect.sh"),
    ["-home", c.kb, "-key", "collector", "-payee", c.keys.fluxen.addr, "-remote", c.rpc, "-chainid", "dev", "-realm", c.realm, "-state", join(c.tmp, "collect.state"), "-insecure-password-stdin"],
    { env: { ...process.env, GNOHOME: c.gnohome, XDG_STATE_HOME: join(c.tmp, "xdg") } },
  );
  p.child.stdin!.write(PW + "\n");
  p.child.stdin!.end();
  const r = await p;
  return r.stdout + r.stderr;
}

/** A plain transfer from one test key to an address (used to make an address an account). */
export async function sendCoins(c: StandinChain, fromKey: string, to: string, amount: string): Promise<void> {
  const r = await gnokey(
    c,
    ["maketx", "send", "-to", to, "-send", amount, "-gas-fee", "100000ugnot", "-gas-wanted", "2000000", "-broadcast", "-chainid", "dev", "-remote", c.rpc, "-home", c.kb, "-insecure-password-stdin", fromKey],
    PW + "\n",
  );
  if (!r.ok) throw new Error("send failed: " + r.out);
}
