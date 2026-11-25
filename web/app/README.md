# Mandate web app

Live at **[elangrr.github.io/mandate](https://elangrr.github.io/mandate/)**, built from `master` and served from the `gh-pages` branch.

A static site (Vite, TypeScript, React) for Mandate on the Onyx test network. It reads the realm through the network's public RPC; nothing runs on a server of ours, and it loads nothing from third parties except the optional dollar hint (CoinGecko).

## Browsing (no wallet needed)

Home with the how-it-works picture (`#/`), all plans (`#/plans`), a plan page (`#/plan/<id>`), "My mandates" by address or connected Adena wallet (`#/mine`), a creator page (`#/creator/<address>`), how it works (`#/how`), and a calm "waiting for the network's approval" state while the realm is parked.

## Subscribing and stopping, with the Adena wallet

- Every request asks Adena to wait for the block (`commit: true`) and to close its popup itself with the real reply (`isVisibleResult: false`). When Adena reports "cancelled" (also what it says when its window is closed after the transaction went out), the page reads the chain for 10 seconds before saying anything. A step counts as done only when the page reads its result back from the chain (the permission, or the mandate); the second approval opens only after the first is on chain. If the chain does not show a sent step within a minute, the page says "sent, but not on chain yet" and asks you not to repeat it; that warning stays at the top of every page (through a reload, a network switch or leaving the page) until the chain shows the step or another account is connected. Before each later step the page checks the chain again (before recording the terms: that the permission just given is still there with the end date signed, and that no mandate for the key or the plan appeared). A popup opens only while its page is open: once you leave it, no further approval opens, and a step already sent is still watched and, if needed, shown in that warning. Permissions for Mandate that no mandate uses are listed on My mandates with a Remove button (an expired one is said to be unusable, but it still takes one of the wallet's 16 places until removed). A creator's own plan offers nothing to sign: the realm refuses it.
- Right before any popup the page reads the chain again (plan, collector key, permissions, MandateOf for the key) and sends nothing if what it showed has changed.
- `#/plan/<id>?approval=one` puts the permission and the terms (or the removal and the cancel) in one approval. **Experimental**: it passes Adena v1.22.5's own code (`../adena-check`) but has not been tried with the real wallet yet. Without it, two approvals.

## Creator actions: publishing and the collector guide

- `#/publish` (behind the wallet): publish or replace the collector key, after the page checks it is a secp256k1 public key, shows its address, and refuses the creator's own key or a key whose address is already an account; and publish a plan, with the realm's limits checked on the page (title one line of 1 to 80 characters without control or invisible formatting characters, price 0.1 to 1,000,000 GNOT, period 1 minute to 30 days), a preview with the cap, the storage deposit and the fee. Plans never change once published. The page never asks for, makes or handles a private key, password or seed phrase.
- `#/collector?a=<address>`: the collector guide, with the exact `scripts/collect.sh` command for that creator and realm, a sample cron line, what the script's messages mean and what to do when the key is blocked.
- Both requests use the same steps as subscribing: explicit gas, wait for the block, a fresh read before the popup, each step confirmed on chain, the pending step kept across a reload. A plan is not refused when repeated (each one is a new plan with its own deposit), so for a plan that may still arrive the page says to look at the creator page before publishing again. While the realm is parked, `#/publish` shows the waiting-for-approval state.

## Build

```sh
npm ci
npm run build        # dist/, ready for any sub-path (asset URLs are relative): GitHub Pages at /mandate/ needs no option
```

Defaults: chain `onyx-1`, RPC `https://rpc.onyx.testnets.gno.land:443`, realm `gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate`. Override with `VITE_CHAIN_ID`, `VITE_RPC_URL`, `VITE_REALM_PATH`, `VITE_GNOWEB_URL`; `VITE_GNOT_USD_SOURCE=off` turns the dollar hint off, `VITE_GNOT_USD=<price>` fixes it; `VITE_CONFIRM_WAIT_MS` is how long the page reads the chain for a sent step before it says "not on chain yet" (default 60000). The built page carries a strict Content-Security-Policy (its own scripts and styles only; network access to the RPC and CoinGecko only).

## Tests

```sh
npm test             # unit tests: the decoders against real chain responses (src/__fixtures__/chain.json), the transaction
                     # builders, the subscribe and stop decisions, and what each kind of wallet reply means
npm run typecheck
npm run e2e          # a LOCAL gnodev chain (chain id dev) with throwaway keys, the app built for it and served under /mandate/,
                     # Playwright in headless Chromium; screenshots in e2e/out/shots/
npm run fixtures     # re-capture src/__fixtures__/chain.json from a local chain
```

The wallet tests use a stand-in for Adena (`e2e/standin.ts`) with Adena's reply shapes, both waiting for the block and answering as soon as the transaction is queued, and include refusals inside the block, a slow block and replies of unexpected shapes.

The end-to-end run needs gno v1.8.0's `gnodev` and `gnokey` on PATH and Playwright's Chromium. It never touches a public network: chain id `dev`, 127.0.0.1 only, keys made and deleted by the run.

Design direction: `DESIGN.md`. Words: `../../GLOSSARY.md`.
