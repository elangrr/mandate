# Mandate

**The first way to pull a recurring payment from an ordinary GNOT wallet, with a hard cap the payer sets.**

Mandate is subscriptions and direct debit on native GNOT, built on Gno.land session keys. A supporter signs one permission from their own wallet: *at most X GNOT every period, through this realm only, until I cancel or it expires*. The creator's collector pulls each payment when it is due; the realm checks who, how much and when, and forwards the coins to the creator in the same transaction.

It ships with one thing to subscribe to: **supporter pages**. A creator publishes a plan such as "1 GNOT every week"; the plan's page lists its active supporters.

Status: milestone 1, tested on a local chain. Not deployed yet. The realm will live at `gno.land/r/<namespace>/mandate` on the Onyx test network; in this repository the namespace is the placeholder `mandate_dev`.

## How it works

```
 creator                         supporter                         chain + realm
 ───────                         ─────────                         ─────────────
 Offer("Weekly coffee",
       1 GNOT, 7 days)  ─────────────────────────────────────────▶ plan 1 (never changes)
 SetCollectorKey(gpub K) ────────────────────────────────────────▶ key K published

                                 create a session for key K:
                                   only vm/exec:<this realm>,
                                   at most 1.05 GNOT per 7 days,  ─▶ session (supporter, K)
                                   expires in a year
                                 Subscribe(plan 1, addr(K), expiry) ▶ mandate recorded

 every 7 days, the collector signs with K on the supporter's behalf:
 Pull() sending 1 GNOT ──────────────────────────────────────────▶ chain: live session? allowed? within the cap?
                                                                   realm: right scope, active, due, exact amount
                                                   creator ◀─ 1 GNOT ─ realm (keeps nothing)
```

Three parts:

- **The realm** (`r/mandate`): plans, mandates, the Pull rules, the pages, free reads. No admin, no pause, no upgrade, no sweep. It never holds funds between transactions.
- **The chain's sessions** (Gno v1.8.0): the supporter's wallet creates a session for the creator's collector key, limited to this realm, with a spend limit per period and an expiry. The chain enforces the cap; the realm enforces the terms.
- **The collector** (`scripts/collect.sh`): run by the creator, holds the collector key, finds what is due through free queries and pulls it.

## The honest limits

- **It is direct debit, not escrow.** Nothing is locked up front. A supporter can revoke, cancel or empty their account at any time; a creator is only paid when a pull succeeds. Payments are taken at the start of each period, so a creator is exposed for one period at most.
- **The cap includes fees.** The session's spend limit is the price plus a fee allowance of 0.05 GNOT per period. A dishonest creator could burn that allowance as network fees (which go to the network, not to them). They can never take more than the limit, or pull more often.
- **At most 16 mandates per wallet**, because the chain allows 16 sessions per account.
- **Revoke any time.** Revoking the session on chain stops every payment at once. The realm cannot see a revoke, so it still shows the mandate as active until it is cancelled or expires; services must also check the session on chain (`auth/accounts/<payer>/session/<key>`, a free query).
- **Nothing is ever deployed under the realm's path.** A session for `vm/exec:<realm>` also allows every realm under that path (the chain matches by prefix). The realm's deployer must never deploy anything at `gno.land/r/<namespace>/mandate/...`; this repository never will.
- **The creator needs an always-on collector** holding the collector key.
- **Subscribing costs a storage deposit** of about 0.3 GNOT (the realm's records for the mandate), paid once by the supporter, plus normal fees. The first supporter who uses a new collector key pays about 0.3 GNOT more for that key's index.

## Using it

The realm's help page (`:help`) has every command, pinned to `onyx-1`. In short:

```
# creator, own key
gnokey maketx call -pkgpath gno.land/r/<ns>/mandate -func Offer -args "Weekly coffee" -args 1000000 -args 604800 ...
gnokey maketx call -pkgpath gno.land/r/<ns>/mandate -func SetCollectorKey -args gpub1... ...

# supporter, own key: the plan page shows these two filled in
gnokey maketx session create -pubkey <collector gpub> -allow-paths vm/exec:gno.land/r/<ns>/mandate \
    -spend-limit 1050000ugnot -spend-period 604800 -expires-at <unix> ...
gnokey maketx call -pkgpath gno.land/r/<ns>/mandate -func Subscribe -args 1 -args <collector address> -args <unix> ...

# creator's collector
scripts/collect.sh -home <keybase> -key <collector key> -remote https://rpc.onyx.testnets.gno.land:443 \
    -chainid onyx-1 -realm gno.land/r/<ns>/mandate [-dry-run]
```

### Realm API

| Function | Who | What |
|---|---|---|
| `Offer(cur, title, amountUgnot, periodSeconds) uint64` | creator, own key | Publishes a plan. |
| `SetCollectorKey(cur, gpub)` | creator, own key | Publishes the collector's public key; the realm derives its address. |
| `Subscribe(cur, planID, sessionAddr, expiresAtUnix) uint64` | supporter, own key | Records the terms for one session. The first payment is due at once. |
| `Pull(cur)` | collector, signed with the session key (`-master <supporter>`) | Exactly the price, once per period, forwarded to the creator. |
| `Cancel(cur, payer, sessionAddr)` | supporter or creator, own key | Ends a mandate in the realm. |
| `GetPlan`, `MandateOf`, `IsActive`, `NextPullAt`, `GetPayee`, `Totals` | anyone, free | Plain values (copies). |
| `Plans`, `PlansOf`, `MandatesOf`, `SupportersOf`, `MandatesForSession`, `CollectorList` | anyone, free | Paged lists, 20 rows per page. `CollectorList` is plain text for scripts. |
| `Render` | gnoweb | Home, `plan/<id>` (supporter page), `payer/<addr>`, `payee/<addr>`, `help`. |

Every crossing function except Pull refuses session keys and coins and must be called directly by a user.

## Tests

Everything runs on this machine. Nothing here talks to a public network except the read-only checks noted in `docs/notes.md`.

```
export GNOHOME=<a folder for gno's caches>   # not your key folder
gno test -v ./...        # unit tests and filetests (pages, events)
gno lint ./...
gno fmt -diff ./...
scripts/local-flow.sh    # real signed transactions on a local gnodev chain (about 5 minutes)
node web/adena-test.test.mjs
```

- **Unit tests** (`r/mandate/*_test.gno`): terms and their limits, time and period maths at the exact boundaries, every refusal (each checked to change nothing), paging, page content, title injection, and Pull's rules through `checkPull` (the session itself cannot be signed under `gno test`). Filetests hold golden copies of every page and the events.
- **The local flow** (`scripts/local-flow.sh`): starts gnodev with chain id `dev`, creates throwaway keys in a temporary keybase (no mnemonic is printed or kept), and proves with assertions: subscribe and pull (exact balances, realm balance zero, the event); a second pull in the same period refused; wrong amounts refused; the session refused for a bank send, another realm, and for Offer/Subscribe/Cancel/SetCollectorKey; a too-wide session refused by Pull; the collector script; chain-side and realm-side expiry; a hostile creator's fee burn capped at the spend limit; revoke; the sub-path case; the creator-pays-fees two-signer variant; cancel. It refuses any chain id but `dev`, passes `-remote` and `-home` to every gnokey call, and deletes the keys and stops the node on exit.
- **The Adena test page** (`web/adena-test.html`): a single static file to check, in a real browser with the Adena extension on Onyx, that a page can ask Adena to create and revoke a session for someone else's key. Its request builders are unit-tested against Adena's source.

`docs/design.md` has the threat model (threat, who is hurt, what stops it, how it is tested), the limits and why, and measured gas and storage. `docs/notes.md` lists the Gno facts this relies on, with sources.

## Deploying

`scripts/set-namespace.sh <g1 address or registered name>` replaces the placeholder in `r/` and runs the tests. Deployment to Onyx is a separate, manual step by the owner of the namespace. Never deploy anything under the realm's path.

## Licence

Apache License 2.0; see `LICENSE` and `NOTICE`. The copy published on the Gno.land network is also available under the GNO Network General Public License, version 6, as the network's terms provide. Imported Gno packages keep their own licence.

Built on [gno.land](https://gno.land).
