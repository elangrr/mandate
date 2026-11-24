// Genesis transactions for the LOCAL gnodev chain the e2e tests use.
//
//   node e2e/seed.mjs <realm path> <payee addr> <payee pubkey gpub> <collector gpub> <collector addr> <out dir>
//
// gnodev applies genesis transactions without checking signatures, so the
// supporters below exist only as public keys: no private half is ever made.
// The payee and the collector are real throwaway keys in the e2e keybase
// (made by e2e/run-e2e.mjs), so they can sign live transactions later.
//
// Every example is a supporter page under the Fluxen name only.
import { createECDH, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [realm, payee, payeeGpub, collGpub, coll, out] = process.argv.slice(2);
if (!out) {
  console.error("usage: seed.mjs <realm> <payee> <payee gpub> <collector gpub> <collector addr> <out dir>");
  process.exit(2);
}

const CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(v) {
  const g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let c = 1;
  for (const x of v) {
    const b = c >>> 25;
    c = ((c & 0x1ffffff) << 5) ^ x;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= g[i];
  }
  return c >>> 0;
}
function to5(bytes) {
  let acc = 0, bits = 0;
  const o = [];
  for (const x of bytes) {
    acc = (acc << 8) | x;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      o.push((acc >>> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits) o.push((acc << (5 - bits)) & 31);
  return o;
}
function bech(hrp, bytes) {
  const d = to5(bytes);
  const hx = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const p = polymod(hx.concat(d, [0, 0, 0, 0, 0, 0])) ^ 1;
  const cs = [0, 1, 2, 3, 4, 5].map((i) => (p >>> (5 * (5 - i))) & 31);
  return hrp + "1" + d.concat(cs).map((x) => CH[x]).join("");
}
function unbech(s) {
  const data = [...s.slice(s.lastIndexOf("1") + 1)].map((c) => CH.indexOf(c)).slice(0, -6);
  let acc = 0, bits = 0;
  const o = [];
  for (const x of data) {
    acc = (acc << 5) | x;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      o.push((acc >>> bits) & 255);
    }
    acc &= (1 << bits) - 1;
  }
  return Buffer.from(o);
}
const addrOf = (pub) => bech("g", createHash("ripemd160").update(createHash("sha256").update(pub).digest()).digest());
function newPub() {
  const e = createECDH("secp256k1");
  e.generateKeys();
  return e.getPublicKey(null, "compressed");
}

const now = Math.floor(Date.now() / 1000);
const year = now + 360 * 86400;
const pubOf = (gpub) => unbech(gpub).subarray(-33);
const tx = (pub, msgs) => ({
  tx: {
    msg: msgs,
    fee: { gas_wanted: "100000000", gas_fee: "1ugnot" },
    signatures: [{ pub_key: { "@type": "/tm.PubKeySecp256k1", value: pub.toString("base64") }, signature: "" }],
    memo: "",
  },
});
const call = (caller, fn, args) => ({ "@type": "/vm.m_call", caller, send: "", max_deposit: "", pkg_path: realm, func: fn, args });
const session = (creator, spend, period) => ({
  "@type": "/auth.m_create_session",
  creator,
  session_key: { "@type": "/tm.PubKeySecp256k1", value: pubOf(collGpub).toString("base64") },
  expires_at: String(year),
  allow_paths: ["vm/exec:" + realm],
  spend_limit: spend + "ugnot",
  spend_period: String(period),
});

const ppub = pubOf(payeeGpub);
// Plans: id 1..3. Plan 3 has a one-minute period so the e2e collector can
// pull it again during a test run.
const plans = [
  ["Support Fluxen's work", "1000000", "2592000"],
  ["Fluxen's weekly notes", "500000", "604800"],
  ["Fluxen test plan (one minute)", "100000", "60"],
  // Plan titles are written by strangers: this one must show as plain text.
  ['Fluxen <img src=x onerror="window.__xss=1"> **b** [a](https://x.example)', "100000", "86400"],
];
const txs = plans.map(([t, a, p]) => tx(ppub, [call(payee, "Offer", [t, a, p])]));
txs.push(tx(ppub, [call(payee, "SetCollectorKey", [collGpub])]));

// Supporters who set up a session and a mandate (the collector pulls them
// live); some on each plan.
const balances = [`${payee}=1000000000ugnot`]; // never the collector key (see chain.mjs)
const supporters = [];
const counts = { 1: 5, 2: 3, 3: 2 };
for (const [plan, n] of Object.entries(counts)) {
  const [, amount, period] = plans[Number(plan) - 1];
  for (let i = 0; i < n; i++) {
    const pub = newPub();
    const a = addrOf(pub);
    balances.push(`${a}=100000000ugnot`);
    supporters.push({ plan: Number(plan), addr: a });
    txs.push(tx(pub, [session(a, String(Number(amount) + 100000), period), call(a, "Subscribe", [plan, coll, String(year)])]));
  }
}
// Never-paid mandates recorded without a session (junk): shown only as a number.
for (let i = 0; i < 3; i++) {
  const pub = newPub();
  const a = addrOf(pub);
  balances.push(`${a}=100000000ugnot`);
  txs.push(tx(pub, [call(a, "Subscribe", ["1", coll, String(year)])]));
}

writeFileSync(join(out, "txs.jsonl"), txs.map((t) => JSON.stringify(t)).join("\n") + "\n");
writeFileSync(join(out, "balances.txt"), balances.join("\n") + "\n");
writeFileSync(join(out, "supporters.json"), JSON.stringify(supporters, null, 1));
