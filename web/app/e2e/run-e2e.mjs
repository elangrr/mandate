// End-to-end check against a LOCAL gnodev chain (chain id "dev"; never a
// public network):
//  1. start the chain with e2e/seed.mjs's Fluxen plans and supporters
//     (e2e/chain.mjs) and run the repository's collector once, so payments exist;
//  2. build the app pointed at that chain and serve it under /mandate/, the
//     same sub-path as GitHub Pages;
//  3. run the Playwright tests in e2e/*.spec.ts (headless Chromium).
// The throwaway keys and the chain are deleted on exit.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { startChain, app, realm, freePort } from "./chain.mjs";

const out = join(app, "e2e/out");
mkdirSync(out, { recursive: true });
const chain = await startChain({ log: join(out, "gnodev.log") });
let server;
const stop = () => {
  try {
    server?.close();
  } catch {
    /* closed */
  }
  chain.stop();
};
process.on("exit", stop);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

console.log(chain.collect().split("\n").filter((l) => /done:|plans,/.test(l)).join("\n"));
// What the tests need to sign as the stand-in wallet and to run the collector:
// the throwaway keybase and the local chain only.
writeFileSync(
  join(out, "chain.json"),
  JSON.stringify({ keys: chain.keys, supporters: chain.supporters, realm, kb: chain.kb, gnohome: chain.gnohome, rpc: chain.rpc, tmp: chain.tmp }, null, 1),
);

execFileSync("npx", ["vite", "build", "--outDir", "e2e/out/dist", "--emptyOutDir"], {
  cwd: app,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_CHAIN_ID: "dev",
    VITE_NETWORK_NAME: "local test chain",
    VITE_RPC_URL: chain.rpcUrl,
    VITE_REALM_PATH: realm,
    VITE_GNOWEB_URL: chain.webUrl,
    VITE_GNOT_USD: "0.05", // a fixed dollar figure: tests make no outside requests
    VITE_CONFIRM_WAIT_MS: "5000", // how long the page waits for a sent transaction to show on chain; short so the slow-block test is quick
  },
});

const dist = join(app, "e2e/out/dist");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2" };
const port = await freePort();
server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (!url.pathname.startsWith("/mandate/")) return void res.writeHead(404).end("not under /mandate/");
  let p = join(dist, decodeURIComponent(url.pathname.slice("/mandate/".length)) || "index.html");
  if (!p.startsWith(dist) || !existsSync(p) || statSync(p).isDirectory()) p = join(dist, "index.html");
  const type = types[extname(p)] ?? "application/octet-stream";
  if (/^(text\/|image\/svg|application\/json)/.test(type) && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
    return void res.writeHead(200, { "Content-Type": type, "Content-Encoding": "gzip", Vary: "Accept-Encoding" }).end(gzipSync(readFileSync(p)));
  }
  res.writeHead(200, { "Content-Type": type }).end(readFileSync(p));
}).listen(port, "127.0.0.1");
console.log(`app at http://127.0.0.1:${port}/mandate/`);

const tests = spawn("npx", ["playwright", "test", "--config", "e2e/playwright.config.ts", ...process.argv.slice(2)], {
  cwd: app,
  stdio: "inherit",
  env: { ...process.env, MD_APP_URL: `http://127.0.0.1:${port}/mandate/`, MD_CHAIN: join(out, "chain.json"), MD_RPC: chain.rpcUrl },
});
tests.on("exit", (code) => process.exit(code ?? 1));
