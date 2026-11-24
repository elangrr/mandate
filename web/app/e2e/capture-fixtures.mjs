// Captures real vm/qeval_json and auth responses from a LOCAL gnodev chain
// seeded by e2e/seed.mjs, after one collector run, into
// src/__fixtures__/chain.json. The decoders' tests run against these.
//
//   node e2e/capture-fixtures.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { startChain, realm, app } from "./chain.mjs";

const chain = await startChain();
try {
  chain.collect(); // first payments of every seeded supporter
  const { fluxen, collector, stranger } = chain.keys;
  const paid = chain.supporters[0].addr;
  async function abci(path, data) {
    const res = await fetch(chain.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "abci_query", params: { path, data: Buffer.from(data).toString("base64") } }),
    });
    const j = await res.json();
    const base = j.result.response.ResponseBase;
    return { data: base.Data ? Buffer.from(base.Data, "base64").toString() : "", error: base.Error ? String(base.Error.value ?? base.Error["@type"]) : null, log: base.Log ?? "" };
  }
  const exprs = [
    "Totals()",
    "GetPlan(1)",
    "GetPlan(99)",
    "Plans(1)",
    `PlansOf(address("${fluxen.addr}"), 1)`,
    `GetPayee(address("${fluxen.addr}"))`,
    `GetPayee(address("${stranger.addr}"))`,
    `MandateOf(address("${paid}"), address("${collector.addr}"))`,
    `MandatesOf(address("${paid}"), 1)`,
    "SupportersOf(1, 1)",
    "PayingSupporters(1, -1)",
    "PlanCounts(1)",
    `PaidThrough(address("${paid}"), 1)`,
    `HasMandate(address("${paid}"), 1)`,
    "FeeAllowance",
    "MaxPeriod",
  ];
  const out = { note: "Real responses from a local gnodev (gno v1.8.0) seeded by web/app/e2e/seed.mjs after one collector run. 'data' is the decoded body; 'error' is ResponseBase.Error.", realm, keys: { fluxen: fluxen.addr, collector: collector.addr, stranger: stranger.addr, paid }, qeval_json: {}, abci: {} };
  for (const e of exprs) out.qeval_json[e] = await abci("vm/qeval_json", `${realm}.${e}`);
  out.qeval_json["missing realm"] = await abci("vm/qeval_json", `gno.land/r/nobody/here.Totals()`);
  out.abci[`auth/accounts/${paid}/session/${collector.addr}`] = await abci(`auth/accounts/${paid}/session/${collector.addr}`, "");
  out.abci[`auth/accounts/${stranger.addr}/session/${collector.addr}`] = await abci(`auth/accounts/${stranger.addr}/session/${collector.addr}`, "");
  out.abci[`auth/accounts/${collector.addr}`] = await abci(`auth/accounts/${collector.addr}`, "");
  out.abci[`auth/accounts/${stranger.addr}`] = await abci(`auth/accounts/${stranger.addr}`, "");
  out.abci["auth/gasprice"] = await abci("auth/gasprice", "");
  mkdirSync(join(app, "src/__fixtures__"), { recursive: true });
  writeFileSync(join(app, "src/__fixtures__/chain.json"), JSON.stringify(out, null, 1) + "\n");
  console.log("wrote", Object.keys(out.qeval_json).length + Object.keys(out.abci).length, "responses");
} finally {
  chain.stop();
}
