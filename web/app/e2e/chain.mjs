// A LOCAL gnodev chain (chain id "dev") for the e2e tests and fixtures.
//
// Never a public network: the chain id is fixed to "dev", gnodev listens on
// 127.0.0.1 only, and every gnokey call passes -remote 127.0.0.1:<port> and
// -home <a temporary keybase>. Keys are throwaway, made here, and deleted
// with everything else by stop().
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repo = resolve(app, "../..");
export const realm = /module = "([^"]+)"/.exec(readFileSync(join(repo, "r/mandate/gnomod.toml"), "utf8"))[1];
export const PW = "throwaway-local-only";

export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startChain({ keys = ["fluxen", "collector", "supporter", "stranger"], log = null } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "mandate-e2e-"));
  const kb = join(tmp, "kb");
  const gnohome = join(tmp, "gnohome");
  mkdirSync(gnohome);
  const gk = (args, input) =>
    execFileSync("gnokey", args, { input, env: { ...process.env, GNOHOME: gnohome }, stdio: ["pipe", "pipe", "pipe"] }).toString();
  const info = {};
  for (const k of keys) {
    gk(["add", "-home", kb, "-insecure-password-stdin", "-nobackup", "-quiet", k], `${PW}\n${PW}\n`);
  }
  for (const line of gk(["list", "-home", kb]).split("\n")) {
    const m = /^\d+\. (\S+) \(local\) - addr: (g1[a-z0-9]+) pub: (gpub1[a-z0-9]+),/.exec(line);
    if (m) info[m[1]] = { name: m[1], addr: m[2], gpub: m[3] };
  }
  execFileSync("node", [join(app, "e2e/seed.mjs"), realm, info.fluxen.addr, info.fluxen.gpub, info.collector.gpub, info.collector.addr, tmp]);
  const balances = readFileSync(join(tmp, "balances.txt"), "utf8").trim().split("\n").filter((l) => !l.startsWith(info.fluxen.addr) && !l.startsWith(info.collector.addr));
  // Never fund the collector key: an address that holds coins is an account,
  // and the chain refuses every session for a key whose address is one. The
  // supporter (the session's master) pays every Pull fee.
  for (const k of keys) if (k !== "collector") balances.push(`${info[k].addr}=1000000000ugnot`);
  writeFileSync(join(tmp, "balances.txt"), balances.join("\n") + "\n");

  const rpcPort = await freePort();
  const webPort = await freePort();
  const rpc = `127.0.0.1:${rpcPort}`;
  let out = "";
  const node = spawn(
    "gnodev",
    ["local", "-chain-id", "dev", "-no-watch", "-interactive=false", "-empty-blocks", "-txs-file", join(tmp, "txs.jsonl"), "-balance-file", join(tmp, "balances.txt"),
      "-node-rpc-listener", rpc, "-web-listener", `127.0.0.1:${webPort}`],
    { cwd: repo, env: { ...process.env, GNOHOME: gnohome }, stdio: ["ignore", "pipe", "pipe"] },
  );
  node.stdout.on("data", (d) => (out += d));
  node.stderr.on("data", (d) => (out += d));
  const stop = () => {
    try {
      node.kill();
    } catch {
      /* gone */
    }
    if (log) writeFileSync(log, out);
    rmSync(tmp, { recursive: true, force: true });
  };
  for (let i = 0; i < 120; i++) {
    try {
      gk(["query", "vm/qeval", "-data", `${realm}.Totals()`, "-remote", rpc, "-home", kb]);
      break;
    } catch {
      if (node.exitCode !== null) {
        stop();
        throw new Error("gnodev exited: " + out.slice(-500));
      }
      await sleep(1000);
    }
  }
  const failed = (out.match(/unable to deliver tx/g) || []).length;
  if (failed) {
    stop();
    throw new Error(`${failed} genesis transactions failed: ` + out.slice(-800));
  }
  const supporters = JSON.parse(readFileSync(join(tmp, "supporters.json"), "utf8"));

  /** gnokey with the throwaway keybase and the local node, never the defaults. */
  const gnokey = (args, input) => gk([...args, "-home", kb, "-remote", rpc], input);
  /** Runs the repository's collector once for Fluxen's plans. */
  const collect = (extra = []) =>
    execFileSync(join(repo, "scripts/collect.sh"), ["-home", kb, "-key", "collector", "-payee", info.fluxen.addr, "-remote", rpc, "-chainid", "dev", "-realm", realm,
      "-state", join(tmp, "collect.state"), "-insecure-password-stdin", ...extra], { input: PW + "\n", env: { ...process.env, GNOHOME: gnohome, XDG_STATE_HOME: join(tmp, "xdg") } }).toString();
  return { tmp, kb, gnohome, rpc, rpcUrl: `http://${rpc}`, webUrl: `http://127.0.0.1:${webPort}`, keys: info, supporters, gnokey, collect, stop, log: () => out };
}
