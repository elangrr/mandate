/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { defaults } from "./src/defaults.ts";

// Fills %VITE_*% placeholders in index.html (the GnoConnect tags) from the
// environment, falling back to the Onyx defaults, so they are never left empty.
function htmlDefaults(mode: string): Plugin {
  const env = { ...defaults, ...Object.fromEntries(Object.entries(loadEnv(mode, ".", "VITE_")).filter(([, v]) => v.trim() !== "")) };
  return {
    name: "html-defaults",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replace(/%(VITE_[A-Z_]+)%/g, (m, k: string) => (k in env ? escapeAttr(String(env[k as keyof typeof env])) : m)),
    },
  };
}
const escapeAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// A strict Content-Security-Policy for the built page (the dev server needs
// inline scripts, so it is added at build time only). The page talks only to
// the configured RPC node and, for the dollar hint, CoinGecko; it runs only
// its own script and style files. Plan titles are strangers' text: React
// renders them as text, and this policy blocks anything that would run.
function csp(mode: string): Plugin {
  const env = { ...defaults, ...Object.fromEntries(Object.entries(loadEnv(mode, ".", "VITE_")).filter(([, v]) => v.trim() !== "")) } as Record<string, string>;
  const rpc = new URL(env.VITE_RPC_URL).origin;
  const coingecko = (env.VITE_GNOT_USD_SOURCE ?? "coingecko").toLowerCase() === "off" ? "" : " https://api.coingecko.com";
  const policy = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    `connect-src ${rpc}${coingecko}`,
    "base-uri 'none'",
    "form-action 'none'",
    "manifest-src 'self'",
  ].join("; ");
  return {
    name: "csp",
    apply: "build",
    transformIndexHtml: (html) => html.replace("<!--CSP-->", `<meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

// base "./" makes every asset URL relative, so the built app works from any
// sub-path (for example https://<user>.github.io/mandate/) without a rebuild.
export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [htmlDefaults(mode), csp(mode), react()],
  build: { outDir: "dist", sourcemap: false },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Let src/styles.test.ts read styles.css as text (?raw) for the sizing lint.
    css: true,
  },
}));
