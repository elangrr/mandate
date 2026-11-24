// Adena browser wallet. API from the Adena extension source
// (packages/adena-extension/src/inject.ts and inject/types/*.ts):
//   AddEstablish(name), GetAccount(), SwitchNetwork(chainId),
//   AddNetwork({chainId, chainName, rpcUrl}), DoContract({messages, memo}),
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
  DoContract(p: { messages: unknown[]; memo?: string; gasFee?: number; gasWanted?: number }): Promise<AdenaResponse<{ hash?: string; height?: string; deliverTx?: any; checkTx?: any }>>;
  On?(event: string, cb: (v: string) => void): unknown;
}

export class WalletError extends Error {
  kind: "not-installed" | "rejected" | "locked" | "wrong-network" | "failed";
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
    case "NETWORK_TIMEOUT":
      return new WalletError("failed", "The network did not answer in time. Check your mandates before trying again: it may have gone through.");
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

/** What a transaction did, as Adena reports it. */
export interface Sent {
  hash: string;
  height: bigint | null;
}

/**
 * Asks Adena to sign and send one request (one approval popup). Checks first
 * that Adena is on the app's network and on the account that signs, so a
 * request never goes out from the wrong wallet. A chain refusal comes back
 * as a WalletError with the realm's or the chain's own words.
 */
export async function send(signer: string, params: { messages: unknown[]; memo: string; gasWanted: number; gasFee: number }): Promise<Sent> {
  const a = need();
  const acc = await account();
  if (acc.chainId !== config.chainId)
    throw new WalletError("wrong-network", `Adena is on ${acc.chainId || "another network"}; switch it to the ${config.networkName} (${config.chainId}).`);
  if (acc.address !== signer) throw new WalletError("failed", "The account in Adena changed. Reconnect and try again.");
  const r = await a.DoContract(params);
  if (r.status !== "success") throw failure(r);
  const d = r.data ?? {};
  const base = d.deliverTx?.ResponseBase ?? d.checkTx?.ResponseBase;
  if (base?.Error) {
    const words = chainErrorText(base.Log, base.Error) ?? sessionErrorText(base.Log, base.Error);
    // A refusal costs only the network fee: nothing else changed. The usual cause is
    // that the chain changed between Adena's simulation and the block (for example
    // another approval landed first); the page reads the chain again after this.
    throw new WalletError("failed", `${words ? `The chain refused it: ${words}.` : "The transaction failed on chain."} Nothing changed apart from the network fee. Check the page and try again.`);
  }
  if (typeof d.hash !== "string" || !/^[A-Za-z0-9+/=_-]{1,128}$/.test(d.hash)) throw new WalletError("failed", "Adena did not return a transaction hash. Check your mandates: it may have gone through.");
  const height = typeof d.height === "string" && /^\d{1,19}$/.test(d.height) ? BigInt(d.height) : typeof d.height === "number" && Number.isSafeInteger(d.height) && d.height > 0 ? BigInt(d.height) : null;
  return { hash: d.hash, height };
}

/** The chain's own words for the session refusals a supporter can meet. */
export function sessionErrorText(...sources: unknown[]): string | null {
  const text = sources.map((s) => (typeof s === "string" ? s : s ? JSON.stringify(s) : "")).join(" ");
  if (/session key address collides with existing account/.test(text)) return "the creator's collector key can no longer be used for new permissions (its address is an account); the creator must publish a new one";
  if (/session key already exists/.test(text)) return "you already gave this collector key a permission";
  if (/too many sessions/.test(text)) return "your wallet already holds the 16 permissions the chain allows";
  if (/out of gas/i.test(text)) return "the network needed more gas than estimated";
  if (/insufficient (funds|coins)/i.test(text)) return "not enough GNOT in your wallet for the deposit and fees";
  return null;
}
