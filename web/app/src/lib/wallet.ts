// Adena browser wallet. API from the Adena extension source
// (packages/adena-extension/src/inject.ts and inject/types/*.ts):
//   AddEstablish(name), GetAccount(), SwitchNetwork(chainId),
//   AddNetwork({chainId, chainName, rpcUrl}), DoContract({messages, memo, gasWanted, gasFee, commit}),
//   On("changedAccount" | "changedNetwork", cb).
// Responses: { code, status: "success" | "failure", type, message, data }.
// Requests are built in tx.ts; send() below is the only place one leaves for Adena.

import { config } from "../config";

export interface AdenaResponse<T = any> {
  code: number;
  status: "success" | "failure";
  type: string;
  message: string;
  data: T;
}

export interface Adena {
  AddEstablish(name: string): Promise<AdenaResponse>;
  GetAccount(): Promise<AdenaResponse<{ address: string; chainId: string; coins?: string; status?: string }>>;
  SwitchNetwork(chainId: string): Promise<AdenaResponse>;
  AddNetwork(n: { chainId: string; chainName: string; rpcUrl: string }): Promise<AdenaResponse>;
  DoContract(p: { messages: unknown[]; memo?: string; gasFee?: number; gasWanted?: number; commit?: boolean }): Promise<AdenaResponse<any>>;
  On?(event: string, cb: (v: string) => void): unknown;
}

export class WalletError extends Error {
  /** rejected, locked, wrong-network, failed: nothing was sent. refused: the chain refused it. */
  kind: "not-installed" | "rejected" | "locked" | "wrong-network" | "failed" | "refused";
  constructor(kind: WalletError["kind"], message: string) {
    super(message);
    this.name = "WalletError";
    this.kind = kind;
  }
}

export function getAdena(): Adena | null {
  const a = (globalThis as any).adena;
  return a && typeof a.DoContract === "function" ? (a as Adena) : null;
}

function need(): Adena {
  const a = getAdena();
  if (!a) throw new WalletError("not-installed", "The Adena wallet is not installed in this browser.");
  return a;
}

/** Chain text shown to a person is plain text (React escapes it) and never longer than this. */
function clip(t: string, max = 200): string {
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** The realm's own error text from a failed transaction, if present. */
export function chainErrorText(...sources: unknown[]): string | null {
  for (const s of sources) {
    const text = typeof s === "string" ? s : s ? JSON.stringify(s) : "";
    const m = /(mandate: [^"\\\n]+)/.exec(text);
    if (m) return clip(m[1].trim());
  }
  return null;
}

/** Turns an Adena failure response into a plain-language WalletError. */
export function failure(r: AdenaResponse): WalletError {
  switch (r.type) {
    case "TRANSACTION_REJECTED":
    case "SIGN_REJECTED":
    case "CONNECTION_REJECTED":
    case "SWITCH_NETWORK_REJECTED":
    case "ADD_NETWORK_REJECTED":
      return new WalletError("rejected", "You cancelled this in Adena. Nothing was sent.");
    case "WALLET_LOCKED":
      return new WalletError("locked", "Adena is locked. Unlock it and try again.");
    case "NOT_CONNECTED":
      return new WalletError("failed", "Adena is not connected to this site. Connect again.");
    case "NO_ACCOUNT":
      return new WalletError("failed", "Adena has no account yet. Create one in Adena first.");
    case "ACCOUNT_MISMATCH":
      return new WalletError("failed", "The account in Adena changed. Reconnect and try again.");
    case "UNRESOLVED_TRANSACTION_EXISTS":
      return new WalletError("failed", "Adena already has a request waiting. Finish or close it first.");
    case "UNADDED_NETWORK":
    case "NOT_INITIALIZED_NETWORK":
      return new WalletError("wrong-network", `Adena does not have the ${config.networkName} (${config.chainId}) yet.`);
    default: {
      const chain = chainErrorText(r.message, r.data);
      if (chain) return new WalletError("failed", `The chain refused it: ${chain}`);
      return new WalletError("failed", r.message || "Adena could not complete this.");
    }
  }
}

export interface Account {
  address: string;
  chainId: string;
}

/** Ask Adena to connect this site and return the current account. */
export async function connect(appName = "Mandate"): Promise<Account> {
  const a = need();
  const r = await a.AddEstablish(appName);
  if (r.status !== "success" && r.type !== "ALREADY_CONNECTED") throw failure(r);
  return account();
}

export async function account(): Promise<Account> {
  const r = await need().GetAccount();
  if (r.status !== "success") throw failure(r);
  const d = r.data ?? ({} as any);
  if (typeof d.address !== "string" || !/^g1[02-9ac-hj-np-z]{38}$/.test(d.address)) throw new WalletError("failed", "Adena returned no address.");
  return { address: d.address, chainId: String(d.chainId ?? "") };
}

/** Switch Adena to the app's network, adding it first if Adena does not know it. */
export async function switchNetwork(): Promise<void> {
  const a = need();
  let r = await a.SwitchNetwork(config.chainId);
  if (r.status === "success" || r.type === "REDUNDANT_CHANGE_REQUEST") return;
  if (r.type === "UNADDED_NETWORK" || r.type === "NOT_INITIALIZED_NETWORK") {
    const add = await a.AddNetwork({ chainId: config.chainId, chainName: config.networkName, rpcUrl: config.rpcUrl });
    if (add.status !== "success" && add.type !== "NETWORK_ALREADY_EXISTS") throw failure(add);
    r = await a.SwitchNetwork(config.chainId);
    if (r.status === "success" || r.type === "REDUNDANT_CHANGE_REQUEST") return;
  }
  throw failure(r);
}

/**
 * What happened to one request, as far as the wallet can tell.
 *
 * Adena v1.22.5 (pages/popup/wallet/approve-transaction-main/index.tsx) waits
 * for the block only when the request says `commit: true`, which every request
 * here does (tx.ts). Then a success carries the block's height and its
 * deliver_tx result, and a refusal (by the mempool or inside the block) comes
 * back as TRANSACTION_FAILED with the chain's `error` and `log`. Anything else
 * (no block result, a time-out, a reply of an unexpected shape) means the
 * transaction may or may not be on its way: the page then reads the chain.
 */
export type Outcome =
  | { kind: "in-block"; hash: string; height: bigint }
  | { kind: "unconfirmed"; hash: string | null };

const HASH = /^[A-Za-z0-9+/=_-]{1,128}$/;

function hashOf(d: any): string | null {
  return d && typeof d.hash === "string" && HASH.test(d.hash) ? d.hash : null;
}

function heightOf(v: unknown): bigint | null {
  if (typeof v === "string" && /^[1-9]\d{0,18}$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return BigInt(v);
  return null;
}

/** A refusal by the chain, in plain words. It cost the network fee at most; nothing else changed. */
export function refusal(...sources: unknown[]): WalletError {
  const words = chainErrorText(...sources) ?? sessionErrorText(...sources);
  return new WalletError(
    "refused",
    `${words ? `The chain refused it: ${words}.` : "The chain refused it."} Nothing changed, apart from the network fee at most. Check the page and try again.`,
  );
}

const REFUSED_BEFORE_SIGNING = new Set([
  "TRANSACTION_REJECTED",
  "SIGN_REJECTED",
  "CONNECTION_REJECTED",
  "SWITCH_NETWORK_REJECTED",
  "ADD_NETWORK_REJECTED",
  "WALLET_LOCKED",
  "NOT_CONNECTED",
  "NO_ACCOUNT",
  "ACCOUNT_MISMATCH",
  "UNRESOLVED_TRANSACTION_EXISTS",
  "UNADDED_NETWORK",
  "NOT_INITIALIZED_NETWORK",
  "INVALID_FORMAT",
  "UNSUPPORTED_TYPE",
]);

/**
 * Asks Adena to sign and send one request (one approval popup) and waits for
 * the block. Checks first that Adena is on the app's network and on the
 * account that signs, so a request never goes out from the wrong wallet.
 * Throws a WalletError when nothing was sent (kind rejected, locked,
 * wrong-network or failed) or the chain refused it (kind refused).
 */
export async function send(signer: string, params: { messages: unknown[]; memo: string; gasWanted: number; gasFee: number; commit: true }): Promise<Outcome> {
  const a = need();
  const acc = await account();
  if (acc.chainId !== config.chainId)
    throw new WalletError("wrong-network", `Adena is on ${acc.chainId || "another network"}; switch it to the ${config.networkName} (${config.chainId}).`);
  if (acc.address !== signer) throw new WalletError("failed", "The account in Adena changed. Reconnect and try again.");
  let r: any;
  try {
    r = await a.DoContract(params);
  } catch {
    return { kind: "unconfirmed", hash: null }; // the wallet threw: it may have sent it
  }
  if (!r || typeof r !== "object") return { kind: "unconfirmed", hash: null };
  const d = r.data && typeof r.data === "object" ? r.data : {};
  if (r.status === "failure") {
    if (typeof r.type === "string" && REFUSED_BEFORE_SIGNING.has(r.type)) throw failure(r);
    if (r.type === "TRANSACTION_FAILED") {
      const log = typeof d.log === "string" ? d.log : "";
      const error = typeof d.error === "string" ? d.error : "";
      // with a log, the chain answered: refused by the mempool or inside the block
      if (log !== "" || /^unknown error: \//.test(error)) throw refusal(log, error);
    }
    // a time-out (the network did not answer in time) or a reply without the chain's answer
    return { kind: "unconfirmed", hash: hashOf(d) };
  }
  if (r.status !== "success") return { kind: "unconfirmed", hash: hashOf(d) };
  const base = d.deliver_tx?.ResponseBase ?? d.deliverTx?.ResponseBase;
  const check = d.check_tx?.ResponseBase ?? d.checkTx?.ResponseBase;
  if (check?.Error || base?.Error) throw refusal(base?.Log, base?.Error, check?.Log, check?.Error);
  const hash = hashOf(d);
  const height = heightOf(d.height);
  if (hash && height && base) return { kind: "in-block", hash, height };
  return { kind: "unconfirmed", hash }; // queued only (no block result), or an unexpected shape
}

/** The chain's own words for the session refusals a supporter can meet. */
export function sessionErrorText(...sources: unknown[]): string | null {
  const text = sources.map((s) => (typeof s === "string" ? s : s ? JSON.stringify(s) : "")).join(" ");
  if (/session key address collides with existing account/.test(text)) return "the creator's collector key can no longer be used for new permissions (its address is an account); the creator must publish a new one";
  if (/session key already exists/.test(text)) return "you already gave this collector key a permission";
  if (/session not found/.test(text)) return "that permission is not on chain any more";
  if (/too many sessions/.test(text)) return "your wallet already holds the 16 permissions the chain allows, counting ones for other apps and expired ones";
  if (/out of gas/i.test(text)) return "the network needed more gas than estimated";
  if (/insufficient (funds|coins)/i.test(text)) return "not enough GNOT in your wallet for the deposit and fees";
  return null;
}
