# Mandate web app

A static site (Vite, TypeScript, React) for Mandate on the Onyx test network. It reads the realm through the network's public RPC; nothing runs on a server of ours, and it loads nothing from third parties except the optional dollar hint (CoinGecko).

Slice M2a, the site that only reads: home with the how-it-works picture, all plans, a plan page, "my mandates" (by address or connected Adena wallet), a creator page, how it works, and a calm "waiting for the network's approval" state while the realm is parked.

## Build

```sh
npm ci
npm run build        # dist/, ready for any sub-path (asset URLs are relative): GitHub Pages at /mandate/ needs no option
```

Defaults: chain `onyx-1`, RPC `https://rpc.onyx.testnets.gno.land:443`, realm `gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate`. Override with `VITE_CHAIN_ID`, `VITE_RPC_URL`, `VITE_REALM_PATH`, `VITE_GNOWEB_URL`; `VITE_GNOT_USD_SOURCE=off` turns the dollar hint off, `VITE_GNOT_USD=<price>` fixes it. The built page carries a strict Content-Security-Policy (its own scripts and styles only; network access to the RPC and CoinGecko only).

## Tests

```sh
npm test             # unit tests: the decoders against real chain responses (src/__fixtures__/chain.json)
npm run typecheck
npm run e2e          # a LOCAL gnodev chain (chain id dev) with throwaway keys, the app built for it and served under /mandate/,
                     # Playwright in headless Chromium; screenshots in e2e/out/shots/
npm run fixtures     # re-capture src/__fixtures__/chain.json from a local chain
```

The end-to-end run needs gno v1.8.0's `gnodev` and `gnokey` on PATH and Playwright's Chromium. It never touches a public network: chain id `dev`, 127.0.0.1 only, keys made and deleted by the run.

Design direction: `DESIGN.md`. Words: `../../GLOSSARY.md`.
