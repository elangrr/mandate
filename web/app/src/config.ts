// The one place that says which network and realm the app talks to.
// Values come from VITE_* variables (see README); the defaults are Onyx and
// the deployed realm. The end-to-end tests build with a local chain instead.

import { defaults } from "./defaults";

function env(name: string, fallback: string): string {
  const v = (import.meta.env as Record<string, string | undefined>)[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

export const config = {
  chainId: env("VITE_CHAIN_ID", defaults.VITE_CHAIN_ID),
  networkName: env("VITE_NETWORK_NAME", defaults.VITE_NETWORK_NAME),
  rpcUrl: env("VITE_RPC_URL", defaults.VITE_RPC_URL),
  realmPath: env("VITE_REALM_PATH", "gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate"),
  gnowebUrl: env("VITE_GNOWEB_URL", "https://onyx.testnets.gno.land"),
  explorerTxUrl: env("VITE_EXPLORER_TX_URL", "https://gnoscan.io/transactions/details?txhash={hash}&chainId=onyx-1"),
  explorerAccountUrl: env("VITE_EXPLORER_ACCOUNT_URL", "https://gnoscan.io/account/{address}?chainId=onyx-1"),
  sourceUrl: env("VITE_SOURCE_URL", "https://github.com/elangrr/mandate"),
  /** The network's package-approval status page ({path} = package path); "" if none. */
  pkgStatusUrl: env("VITE_PKG_STATUS_URL", "https://gpas.onyx.testnets.gno.land/?path={path}"),
  /** "coingecko" (default) or "off"; VITE_GNOT_USD fixes the price instead. */
  gnotUsdSource: env("VITE_GNOT_USD_SOURCE", "coingecko").toLowerCase(),
  gnotUsdManual: env("VITE_GNOT_USD", ""),
  /** How long the page reads the chain for a sent transaction's result before it says "not on chain yet" (ms). */
  confirmWaitMs: Math.max(1000, Number(env("VITE_CONFIRM_WAIT_MS", "60000")) || 60000),
};

export function pkgStatusPage(): string | null {
  return config.pkgStatusUrl ? config.pkgStatusUrl.replace("{path}", encodeURIComponent(config.realmPath)) : null;
}

/** The realm on gnoweb, e.g. https://onyx.testnets.gno.land/r/g1…/mandate:plan/1 */
export function gnowebPage(page = ""): string {
  return config.gnowebUrl + config.realmPath.replace(/^gno\.land/, "") + (page ? ":" + page : "");
}

export function explorerTx(hash: string): string {
  return config.explorerTxUrl.replace("{hash}", encodeURIComponent(hash));
}

export function explorerAccount(address: string): string {
  return config.explorerAccountUrl.replace("{address}", encodeURIComponent(address));
}

/**
 * The realm's rules as deployed (r/mandate constants). They never change: the
 * realm is immutable. Reads confirm FeeAllowance and MaxPeriod in the tests.
 */
export const rules = {
  feeAllowanceUgnot: 100_000n,
  minAmountUgnot: 100_000n,
  minPeriod: 60,
  maxPeriod: 30 * 86400,
  maxTermDays: 366,
  maxTitleLen: 80,
  pageSize: 20,
  maxActive: 16,
  maxCredits: 16,
  /** How many pages of a wallet's history (20 mandates a page) the app reads, everywhere: 1,000 mandates. */
  historyPages: 50,
};
