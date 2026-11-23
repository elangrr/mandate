// Unit tests for the request builders in web/adena-test.html.
// No dependencies: node web/adena-test.test.mjs
//
// The builders live between the BUILDERS START/END markers in the page; this
// file extracts that block and runs it in a fresh VM context, so the tests
// exercise exactly the code the page runs.
//
// The expected message shapes come from the Adena wallet source,
// onbloc/adena-wallet at e71fa1b (v1.22.5):
//   - packages/adena-extension/src/inject/executor/executor.ts: DoContract
//     validates each message; /auth.m_create_session and
//     /auth.m_revoke_session are accepted, anything unknown is
//     UNSUPPORTED_TYPE.
//   - packages/adena-extension/src/common/validation/validation-message.ts:
//     validateTransactionMessageOfCreateSession / ...RevokeSession (mirrored
//     below as adenaValidateCreate / adenaValidateRevoke).
//   - packages/adena-module/src/utils/messages.ts encodeMessageValue:
//     session_key goes through normalizeAnyField (a string value is
//     base64-decoded into the Any's bytes, which must be the protobuf
//     PubKeySecp256k1{key: <33 bytes>} = 0a 21 <key>), expires_at and
//     spend_period through toProtoBigInt (decimal strings are accepted),
//     spend_limit is a coin string. The page message crosses a JSON
//     round-trip inside the extension, so everything is JSON-safe.
//   - its own test, messages.spec.ts "round trips JSON-safe create session
//     messages through documentToTx", uses the same JSON-safe shape.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import vm from "node:vm";

const html = readFileSync(new URL("./adena-test.html", import.meta.url), "utf8");
const start = html.indexOf("/* BUILDERS START");
const end = html.indexOf("/* BUILDERS END */");
assert.ok(start > 0 && end > start, "builder block not found");
const ctx = vm.createContext({ TextEncoder, TextDecoder, BigInt, Uint8Array });
vm.runInContext(html.slice(start, end) + "\nthis.M = MandateAdena;", ctx);
const M = ctx.M;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("ok   " + name);
  } catch (e) {
    console.log("FAIL " + name);
    throw e;
  }
}
const plain = (x) => JSON.parse(JSON.stringify(x)); // values from the VM context

// Known keys and addresses (from a local gno.land chain and the gno repo).
const TEST1_PUB_B64 = "A+FhNtsXHjLfSJk1lB8FbiL4mGPjc50Kt81J7EKDnJ2y";
const TEST1_ADDR = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";
const GPUB_A = "gpub1pgfj7ard9eg82cjtv4u4xetrwqer2dntxyfzxz3pqfp0696ldln2nm7kd33zfpgypg6u0e7upl03hyeexa6mccn4ce8mkswg65c";
const ADDR_A = "g1psdsf789f4xw3qrpjue54g2h28syd09yfkrxdh";
const PUB_A_HEX = "0242fd175f6fe6a9efd66c622485040a35c7e7dc0fdf1b93393775bc6275c64fbb";

test("sha256 and ripemd160 test vectors", () => {
  const abc = new TextEncoder().encode("abc");
  assert.equal(M.toHex(M.sha256(abc)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(M.toHex(M.sha256(new Uint8Array(0))), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(M.toHex(M.ripemd160(abc)), "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc");
  assert.equal(M.toHex(M.ripemd160(new Uint8Array(0))), "9c1185a5c5e9fc54612808977ee8f548b2258d31");
  const long = new TextEncoder().encode("a".repeat(200));
  // multi-block input, checked against node's own sha256
  assert.equal(M.toHex(M.sha256(long)), createHash("sha256").update(long).digest("hex"));
});

test("base64 round trip", () => {
  for (const n of [0, 1, 2, 3, 4, 33, 35]) {
    const b = webcrypto.getRandomValues(new Uint8Array(n));
    assert.equal(M.toBase64(b), Buffer.from(b).toString("base64"));
    assert.deepEqual([...M.fromBase64(M.toBase64(b))], [...b]);
  }
  assert.throws(() => M.fromBase64("abc"), /not base64/);
});

test("address from a public key matches the chain (test1)", () => {
  const pub = new Uint8Array(Buffer.from(TEST1_PUB_B64, "base64"));
  assert.equal(M.addressFromPub(pub), TEST1_ADDR);
});

test("gpub decode/encode matches gnokey (key A)", () => {
  const pub = M.parsePubKey(GPUB_A);
  assert.equal(M.toHex(pub), PUB_A_HEX);
  assert.equal(M.gpubFromPub(pub), GPUB_A);
  assert.equal(M.addressFromPub(pub), ADDR_A);
  // the same key as hex and as base64
  assert.equal(M.toHex(M.parsePubKey(PUB_A_HEX)), PUB_A_HEX);
  assert.equal(M.toHex(M.parsePubKey(Buffer.from(PUB_A_HEX, "hex").toString("base64"))), PUB_A_HEX);
});

test("parsePubKey refuses bad input", () => {
  assert.throws(() => M.parsePubKey(""), /./);
  assert.throws(() => M.parsePubKey(GPUB_A.slice(0, -1) + "q"), /checksum/);
  assert.throws(() => M.parsePubKey(GPUB_A.toUpperCase().replace("GPUB", "gpub")), /mixed case/);
  assert.throws(() => M.parsePubKey("04" + "11".repeat(32)), /compressed/);
  assert.throws(() => M.parsePubKey(TEST1_ADDR), /./);
  assert.throws(() => M.parsePubKey(M.bech32Encode("gpub", new Uint8Array(10))), /secp256k1 gpub/);
});

test("secp256k1 public key derivation (k=1, k=2, k=n-1)", () => {
  const k = (hex) => M.fromHex(hex.padStart(64, "0"));
  assert.equal(M.toHex(M.pubFromPriv(k("1"))), "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
  assert.equal(M.toHex(M.pubFromPriv(k("2"))), "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5");
  assert.equal(M.toHex(M.pubFromPriv(k("3"))), "02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9");
  assert.equal(
    M.toHex(M.pubFromPriv(k("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140"))),
    "0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  );
  assert.throws(() => M.pubFromPriv(k("0")), /out of range/);
  const fresh = M.newTestPubKey((n) => webcrypto.getRandomValues(new Uint8Array(n)));
  assert.equal(fresh.length, 33);
  assert.ok(fresh[0] === 2 || fresh[0] === 3);
  assert.match(M.addressFromPub(fresh), /^g1[02-9ac-hj-np-z]{38}$/);
});

// Mirrors of Adena's validators (validation-message.ts, v1.22.5).
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function adenaValidateCreate(m) {
  if (!m.type || !m.value || m.type !== "/auth.m_create_session" || !isRecord(m.value)) return false;
  const v = m.value;
  if (typeof v.creator !== "string" || v.creator === "") return false;
  if (!isRecord(v.session_key) || typeof v.session_key.type_url !== "string" || v.session_key.type_url === "") return false;
  if (v.session_key.value === undefined || v.session_key.value === null) return false;
  if (!Array.isArray(v.allow_paths) || !v.allow_paths.every((p) => typeof p === "string" && p !== "")) return false;
  if (v.spend_limit !== undefined && typeof v.spend_limit !== "string") return false;
  return true;
}
function adenaValidateRevoke(m) {
  if (!m.type || !m.value || m.type !== "/auth.m_revoke_session" || !isRecord(m.value)) return false;
  const v = m.value;
  if (typeof v.creator !== "string" || v.creator === "") return false;
  return isRecord(v.session_key) && typeof v.session_key.type_url === "string" && v.session_key.value != null;
}
// Mirror of adena-module encodeMessageValue's normalisation for sessions.
function adenaNormalise(v) {
  return {
    keyBytes: new Uint8Array(Buffer.from(v.session_key.value, "base64")),
    expiresAt: BigInt(v.expires_at),
    spendPeriod: BigInt(v.spend_period ?? 0),
  };
}

test("MsgCreateSession: exact shape, accepted by Adena's validator, JSON-safe", () => {
  const pub = M.parsePubKey(GPUB_A);
  const msg = plain(M.buildCreateSession({
    creator: TEST1_ADDR,
    pub,
    expiresAt: 1795440000,
    allowPaths: ["vm/exec:gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate"],
    spendLimit: "1000ugnot",
    spendPeriod: "60",
  }));
  assert.deepEqual(msg, {
    type: "/auth.m_create_session",
    value: {
      creator: TEST1_ADDR,
      session_key: { type_url: "/tm.PubKeySecp256k1", value: Buffer.from("0a21" + PUB_A_HEX, "hex").toString("base64") },
      expires_at: "1795440000",
      allow_paths: ["vm/exec:gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate"],
      spend_limit: "1000ugnot",
      spend_period: "60",
    },
  });
  assert.ok(adenaValidateCreate(msg));
  assert.deepEqual(JSON.parse(JSON.stringify(msg)), msg);
  const n = adenaNormalise(msg.value);
  assert.equal(Buffer.from(n.keyBytes).toString("hex"), "0a21" + PUB_A_HEX);
  assert.equal(n.expiresAt, 1795440000n);
  assert.equal(n.spendPeriod, 60n);
  // The Any's bytes are exactly the inner part of the chain's gpub encoding.
  const gpubBytes = M.bech32Decode(GPUB_A).bytes;
  assert.ok(Buffer.from(gpubBytes).toString("hex").endsWith("1223" + "0a21" + PUB_A_HEX));
  // DoContract params: messages + memo, no gas fields (Adena estimates gas).
  assert.deepEqual(plain(M.doContractParams([msg], "m")), { messages: [msg], memo: "m" });
});

test("MsgCreateSession refuses bad input", () => {
  const pub = M.parsePubKey(GPUB_A);
  const base = { creator: TEST1_ADDR, pub, expiresAt: 1795440000, allowPaths: ["vm/exec:gno.land/r/x/y"], spendLimit: "1000ugnot", spendPeriod: "60" };
  assert.throws(() => M.buildCreateSession({ ...base, creator: "g1short" }), /address/);
  assert.throws(() => M.buildCreateSession({ ...base, allowPaths: [] }), /allow path/);
  assert.throws(() => M.buildCreateSession({ ...base, allowPaths: ["vm/exec:gno.land/r/x y"] }), /allow path/);
  assert.throws(() => M.buildCreateSession({ ...base, spendLimit: "1000" }), /spend limit/);
  assert.throws(() => M.buildCreateSession({ ...base, spendLimit: "0ugnot" }), /spend limit/);
  assert.throws(() => M.buildCreateSession({ ...base, spendPeriod: "-1" }), /spend period/);
  assert.throws(() => M.buildCreateSession({ ...base, expiresAt: "soon" }), /expiry/);
  assert.throws(() => M.buildCreateSession({ ...base, pub: new Uint8Array(32) }), /compressed/);
  for (const p of ["*", "bank/send", "vm/exec", "vm/exec:gno.land/r/demo/boards"]) {
    assert.ok(adenaValidateCreate(plain(M.buildCreateSession({ ...base, allowPaths: [p] }))));
  }
});

test("MsgRevokeSession: exact shape, accepted by Adena's validator", () => {
  const msg = plain(M.buildRevokeSession({ creator: TEST1_ADDR, pub: M.parsePubKey(GPUB_A) }));
  assert.deepEqual(msg, {
    type: "/auth.m_revoke_session",
    value: { creator: TEST1_ADDR, session_key: { type_url: "/tm.PubKeySecp256k1", value: Buffer.from("0a21" + PUB_A_HEX, "hex").toString("base64") } },
  });
  assert.ok(adenaValidateRevoke(msg));
});

test("sessions query URL and response decoding", () => {
  assert.equal(
    M.sessionsQueryURL("https://rpc.onyx.testnets.gno.land:443", TEST1_ADDR),
    "https://rpc.onyx.testnets.gno.land:443/abci_query?path=%22auth%2Faccounts%2F" + TEST1_ADDR + "%2Fsessions%22",
  );
  assert.throws(() => M.sessionsQueryURL("https://x", "nope"), /address/);
  // Shape of a real Onyx answer for an account without sessions (read-only query, Nov 2026).
  const real = { jsonrpc: "2.0", id: "", result: { response: { ResponseBase: { Error: null, Data: "bnVsbA==", Events: null, Log: "", Info: "" }, Key: null, Value: null, Proof: null, Height: "0" } } };
  assert.deepEqual(plain(M.decodeAbciQuery(real)), { error: null, log: "", text: "null" });
  assert.throws(() => M.decodeAbciQuery({}), /no abci response/);
});

test("the page loads nothing from outside and pins Onyx", () => {
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+href=/i);
  assert.doesNotMatch(html, /127\.0\.0\.1|localhost|26657/);
  const urls = html.match(/https?:\/\/[^\s"'<)]+/g) || [];
  for (const u of urls) assert.ok(u.startsWith("https://rpc.onyx.testnets.gno.land:443"), "unexpected URL " + u);
  assert.deepEqual(plain(M.ONYX), { chainId: "onyx-1", chainName: "Gno.land Onyx testnet", rpcUrl: "https://rpc.onyx.testnets.gno.land:443" });
});

console.log(`\n${passed} tests passed`);
