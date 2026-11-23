# Mandate: design and threat model

Mandate is one realm, `gno.land/r/<namespace>/mandate` (the placeholder in this repository is `mandate_dev`). It has no `p/` package of its own and imports only packages already live on Onyx (`p/nt/avl/v0`, `p/nt/markdown/sanitize/v0`; `p/nt/uassert/v0` and `p/nt/testutils/v0` in tests).

## How it works

```
 payee (creator)                    payer (supporter)                     chain
 ───────────────                    ─────────────────                     ─────
 Offer(title, amount, period) ───────────────────────────────────────▶ plan N (immutable)
 SetCollectorKey(gpub)        ───────────────────────────────────────▶ collector key K published

                                    MsgCreateSession(key K,               session account
                                      allow vm/exec:<realm> only,  ─────▶ (payer, K): spend limit
                                      spend limit amount+0.05 GNOT,       per period, expiry
                                      spend period, expiry)
                                    Subscribe(N, addr(K), expiry) ──────▶ mandate (payer, K, N)

 collector signs with K, -master payer:
 Pull() -send amount ─────────────▶ chain: is K a live session of payer? allowed path? within limit?
                                    realm: exact scope, mandate active, due, exact amount
                                    realm ──amount──▶ payee (same transaction; realm keeps nothing)
```

- **Plans** are immutable. New terms mean a new plan.
- **Billing in advance.** The first payment is due as soon as the mandate is recorded and is collected by the first Pull, not by Subscribe (Subscribe refuses coins: the realm takes money only in Pull). Each later Pull is allowed from one period after the previous one: `next = time of last pull + period`. This is the same rule the chain uses for the session's spend period (`tm2/pkg/sdk/auth/spend.go`: the window resets at the first spend after `reset + period`), so a pull the realm allows is never refused by the chain for budget unless fees were burned in the same window. A missed period is never collected later (no arrears).
- **Expiry.** Required, in unix seconds, at most 366 days ahead. Pulls are refused from that second on. The plan page suggests one year and the same expiry for the chain session.
- **Mandate key.** A mandate is found by (payer, session address). Pull takes the payer from `OriginCaller` (the session's master account) and the session address from `GetSessionInfo`, so it needs no arguments. A payer can have at most one active mandate per plan and per session key; after a cancel or expiry the same key can be used again (a new mandate is recorded and the old one stays in the history).
- **Collector key.** The payee publishes the bech32 public key once; the realm derives its address with `chain.PubKeyAddress`, so the address on the plan page always matches the key. Payers may also give a session to another key the payee hands them (the realm then does not know its public key and the payer page shows how to look it up).

### Limits and why

| Limit | Value | Why |
|---|---|---|
| Minimum amount | 0.1 GNOT (100,000 ugnot) | The chain charges the whole fee the signer sets, not the gas used. The pages' Pull fee is 20,000 ugnot (see below), already a fifth of a 0.1 GNOT payment; below that, fees would dominate. |
| Maximum amount | 1,000,000 GNOT per period | Far above any real plan; keeps all totals far from int64 overflow. |
| Minimum period | 60 seconds | Block times are seconds; the chain's spend period is in seconds. Short periods exist for demos and tests; plan pages flag anything under a day as a test plan. |
| Maximum period | 366 days | A yearly plan plus slack. |
| Maximum term | 366 days from Subscribe | A payer renews at most once a year. The chain's own cap on a session is about 4 years. |
| Fee allowance (pages) | 0.05 GNOT | Added to the session's spend limit. The chain accepts a fee when fee ÷ gas wanted ≥ the current gas price (`EnsureSufficientMempoolFees`, `tm2/pkg/sdk/auth/ante.go:548`; Onyx answers `auth/gasprice` with 1 ugnot per 1,000 gas, and raises it when blocks are full). At 20M gas wanted the minimum fee is 20,000 ugnot, so the allowance covers a gas price up to 2.5x today's (2.4x on a first pull, which also pays about 2,000 ugnot of storage). |
| Pull fee (pages, collector) | 20,000 ugnot for 20M gas wanted | Exactly today's Onyx price. Measured use on a local chain is 7.6–8.2M gas; reads on Onyx cost more per object, because the chain prices a read by the depth of its store (`expectedDepth100`, `tm2/pkg/store/iavl/store.go:45`) and Onyx's store is far larger. 20M keeps about 2x headroom; the first Pull on Onyx will tell. |
| Title | 1–80 characters, one line | Same rules as QuestMaster: UTF-8, no control characters, no U+2028/U+2029. |
| Page size | 20 rows | Every list read and every page is paged. |
| Mandates per wallet | 16 at a time | The chain's limit on sessions per account (`tm2/pkg/std/account.go:303`). The realm does not count them; the chain refuses the 17th session. |

## Threat model

"Realm" is Mandate's own checks; "chain" is the session machinery of Gno v1.8.0. Test references: unit tests are in `r/mandate/*_test.gno`, steps are in `scripts/local-flow.sh`.

| # | Threat | Who is hurt | What stops it | How it is tested |
|---|---|---|---|---|
| 1 | The payee pulls more than the price | payer | Realm: exactly one coin, `ugnot`, equal to the price. Chain: spend limit per period. | `TestPullRules` (wrong coins, extra coins, other denoms); flow 3 (3 GNOT and 1 GNOT and no coins refused); flow 2 (chain limit). |
| 2 | The payee pulls more often than once a period | payer | Realm: `now >= next`. Chain: spend period. | `TestPullRules` (at next−1 refused, at next allowed, no catch-up); flow 2 (both the chain and, with a generous session, the realm refuse). |
| 3 | The payee uses the session to send coins or call another realm | payer | Chain: the session's allow list (`vm/exec:<realm>` only). | Flow 4: bank send and `other.Tip` refused, payer balance unchanged (gas used 0). |
| 4 | The payee uses the session to rewrite terms: Offer, Subscribe, Cancel, SetCollectorKey | payer | Realm: every crossing function except Pull refuses session callers (`directCaller`). Chain: sessions can never sign `auth/*` (create or revoke sessions) or `vm/add_package`. | Flow 4: all four refused with "cannot be called with a session key"; a session creating a session refused. Flow mutation: with the guard removed, the flow fails. |
| 5 | The payee burns the payer's allowance as gas fees | payer (bounded) | Chain: fees count against the spend limit; a fee above what is left is refused before any charge. The worst loss per period is the spend limit (price + 0.05 GNOT). Fees go to the network, not to the payee (except if the payee is a validator; not tested). | Flow 8: a doomed Pull with a fee of exactly the limit costs the payer exactly 1,050,000 ugnot and gives the payee nothing; a further fee is refused at no cost; the honest pull for that period is then also refused. |
| 6 | A session scoped wider than this realm (for example the whole namespace) | payer | Realm: Pull requires the allow list to be exactly `["vm/exec:<realm>"]`. Pages: every command scopes the session exactly. This cannot stop the wide session from being used elsewhere. | `TestPullRules` (ten wrong allow lists); flow 5 (Pull refused; the same session can tip another realm in the namespace). |
| 7 | **A realm deployed under the realm's path** (`<realm>/sub`) | payer | The chain's scope match is prefix-based (`gno.land/pkg/gnoland/app.go:1755`), so a session for the realm also allows every realm under it, and Pull is never called. Only the namespace owner can deploy there, and sessions cannot deploy. **Rule: nothing is ever deployed under the realm's path.** Stated in the realm doc, the home page, the README and here. | Flow 10: a session for the realm sends 1 GNOT of the payer's money to a test sub-realm. This shows the hole; the defence is the deployment rule. |
| 8 | The payer revokes, cancels, or empties the account before a pull | payee | Nothing can, by design: it is direct debit, not escrow. Billing in advance limits the payee's exposure to one period. | Flow 9 (revoke: no pull can be signed, payer unchanged), flow 12 (cancel). |
| 9 | The realm still says "active" after an on-chain revoke | payee, services that deliver on `IsActive` | A realm cannot see a revoke. `MandateInfo.SessionQuery` gives the free query `auth/accounts/<payer>/session/<session>` a checker must also run; the pages say so. A successful Pull is the only proof of payment. | Flow 9: `IsActive` true after the revoke, the session query says `SessionNotFound`. |
| 10 | A third party pulls | payer | Chain: needs the session key's signature. Realm: the mandate is keyed by (payer, session address) and pays only the plan's payee. | `TestPullRules` (other payer, other session refused). |
| 11 | Replay of an old signed Pull | payer | Chain: each session account has its own sequence (`auth/accounts/<payer>/session/<key>` shows it). | Not run (source only; the spike's offline-signed pull after revoke was refused as "unknown session"). |
| 12 | The collector key leaks | payer (bounded) | The thief can only pull to the payee, on schedule, or burn fees up to the spend limit per period. The payer revokes; the payee publishes a new key. | Covered by 1–5. |
| 13 | The realm keeps or sweeps funds | payer, payee | Pull forwards exactly the coins it receives in the same transaction; every other function refuses coins; there is no admin, owner, pause, upgrade or sweep. Coins sent to the realm with a plain bank send are stuck forever (nobody can move them). | Unit tests: coins refused on Offer, Subscribe, Cancel, SetCollectorKey. Flow: realm balance asserted zero after every transaction; flow mutation (forward amount−1) fails with "the realm holds 1ugnot". |
| 14 | Pull called by another realm (a proxy that adds its own logic) | payer | Realm: Pull and every other crossing function require a direct call from a user (`IsUserCall`). | `TestPullEntryPoint`, `TestOfferRefusals`, `TestSubscribeRefusals`. |
| 15 | Injection through plan titles (Markdown, HTML, links, mentions, math) | page readers | Titles are validated (one line, no control characters) and escaped with `p/nt/markdown/sanitize/v0` plus gnoweb-specific steps (`$`, `@`, leading and spaced `g1` addresses). | `TestRenderInjection` (14 hostile titles on every page that shows them); `z_pages_filetest` golden; mutations removing `$` or address escaping are caught. |
| 16 | Expired terms | payer | Realm: `now >= ExpiresAt` refused. Chain: session expiry. | `TestPullRules` (one second before allowed, at expiry refused); flow 7 (chain expiry and realm expiry each refuse). |
| 17 | Spam: many plans or fake supporters | readers, later subscribers | Every list is paged (20 rows). Each record costs its creator a storage deposit (about 0.4–0.6 GNOT per plan, about 0.3 GNOT per mandate). Lists are chunked, so a plan with thousands of supporters costs a new subscriber the same as an empty one. | `TestPaging`, `TestRenderPaging`. |
| 17b | **Filling one payer bucket on purpose** | every payer whose address falls in the same bucket (1 in 256) | **Not stopped yet; see below.** Bucket = sha256(payer)[0], so an attacker grinds an address into a victim's bucket (it took 146–638 throwaway keys locally). Each Subscribe adds a lookup entry for (attacker, session); a Cancel lets the attacker subscribe again with a fresh session address (any address, no key). Deposits are never returned. Each entry also creates an index for the fresh session address, so it costs the attacker about 0.62 GNOT of deposit plus about 9.6M gas. | `scripts/measure-bucket-flood.sh` (real signed transactions, local chain): victim's Pull goes from 8.2M gas to 11.4M / 15.5M / 19.0M / 22.8M at 500 / 1,000 / 1,500 / 2,000 entries (+7,300 gas per entry). Subscribe goes from 11.9M to 41.0M, Cancel from 5.3M to 20.6M at 2,000. The attacker had paid 1,240 GNOT of deposits and 19.2B gas (19 GNOT of fees at today's price) by then. See "Bucket flooding" below. |
| 18 | The collector script run against the wrong network | payee | `scripts/collect.sh` has no defaults, accepts only `dev` with a local remote or `onyx-1` with the Onyx RPC. | Flow 6: refused without `-remote`, with onyx-1 and a local remote, and with another chain id. |
| 19 | The payee publishes a collector key whose address does not match | payer | The realm derives the address from the key itself (`chain.PubKeyAddress`). | `TestSetCollectorKey` (bad checksum, empty payload, wrong prefix refused; derived address checked). |

## Bucket flooding (measured, M1.2)

The per-payer lookup buckets (M1.1) are shared by all payers whose address hashes to the same first byte, and one address can add any number of entries to its bucket. Reads are priced per byte (17 gas, times the store's depth for the flat part), so every entry makes each later lookup in that bucket dearer.

| Entries put in the victim's bucket | Attacker deposits (never returned) | Attacker gas | Victim Pull | Victim Subscribe | Victim Cancel |
|---|---|---|---|---|---|
| 0 | 0 | 0 | 8.22M | 11.86M | 5.33M |
| 500 | 309 GNOT | 2.8B | 11.39M | 19.61M | 9.16M |
| 1,000 | 620 GNOT | 7.1B | 15.52M | 26.74M | 12.96M |
| 1,500 | 930 GNOT | 12.6B | 18.99M | 33.86M | 16.76M |
| 2,000 | 1,240 GNOT | 19.2B | 22.79M | 40.99M | 20.56M |

(`scripts/measure-bucket-flood.sh 10 4`, local gnodev, gno v1.8.0 fc79041f4.)

Filetests cannot measure the read side: a filetest runs as one transaction and keeps the objects it created in memory, so a lookup costs the same 67,573 gas whatever the bucket holds. They do show the write side: a new payer's Subscribe in the bucket costs 0.76M, then 1.39M at 500 entries, then 3.09M at 2,000.

Thresholds, from the linear fit (+7,300 gas per entry for Pull):

- **The pages' Pull gas (20M wanted)** is exceeded at about 1,600 entries: about 1,000 GNOT of deposits.
- **The fee allowance** (0.05 GNOT covers at most about 48M gas at today's 1 ugnot per 1,000 gas) is exceeded at about 5,500 entries: about 3,400 GNOT. Past that point no Pull for that bucket's payers can be paid within their spend limit, until they re-subscribe with a larger allowance.
- **Subscribe** at the pages' 30M wanted is exceeded at about 1,250 entries.

What the collector can do: raise `-gas-wanted`, and the fee with it, up to the allowance; nothing beyond. A payer can move to a fresh address (a different bucket).

Not fixed in M1.2; the layout change is waiting for a decision (see the M1.2 report).

## What `gno test` cannot reach

`gno test` cannot sign with a session key, so `runtime.GetSessionInfo()` always says "not a session" there. Pull's rules are therefore split into `checkPull` (all the checks, taking the session info as arguments) and `recordPull` (the state update and event), which the unit tests call directly. The rest (signing, the chain's spend limit, revoke, expiry, the transfer and the session guard on the other functions) is proven by `scripts/local-flow.sh` on a real local chain.

## Measured costs (local gnodev, gno v1.8.0 fc79041f4, the same commit Onyx runs)

From `scripts/local-flow.sh` (real signed transactions). M1 is the layout of commit b1fcb06; M1.1 is the current one.

| Call | Gas M1 | Gas M1.1 | Storage M1 | Storage M1.1 |
|---|---|---|---|---|
| Offer (first plan of a payee) | 7.2M | 7.5M | 5,306 B | 5,781 B |
| SetCollectorKey | 4.6M | 4.8M | 193 B | 195 B |
| session create (chain) | 1.36M | 1.36M | 0 (auth store) | 0 |
| Subscribe: new payer, new key | 8.6M | 9.9M | 6,943 B | 6,185 B |
| Subscribe: returning payer, new key | 9.7M | 10.7M | 5,644 B | 6,694 B |
| **Subscribe: new payer, known key** | 10.0M | 11.0M | **5,429 B (0.54 GNOT)** | **3,145 B (0.31 GNOT)** |
| Subscribe: returning payer, known key | 11.0M | 11.9M | 2,256 B | 2,274 B |
| Pull, first of a mandate | 9.1M | 8.2M | 20 B | 18 B |
| Pull, later | 8.3M | 7.6M | **0 B** | **0 B** |
| Cancel | 5.3–5.9M | 5.3M | 64–76 B | 64–76 B |

"New key" means the first mandate ever given to that collector key, which creates its index (an avl insert plus the index record, about 3.5 KB): once per payee key, not once per payer. Gas grows a little through the run as the trees deepen.

### Growth with plan size and payer history

Marginal cost of one call on top of a setup, from pairs of filetests (filetest gas is lower than chain gas; the trend is what matters):

| Case | Gas M1 | Gas M1.1 | Storage M1 | Storage M1.1 |
|---|---|---|---|---|
| Subscribe, new payer, plan with 200 supporters | 3.47M | 2.61M | 5,443 B | 2,856 B |
| Subscribe, new payer, plan with 1,000 supporters | **5.59M** | **2.70M** | 5,467 B | 2,850 B |
| Cancel, plan with 200 / 1,000 supporters | 3.72M / 3.74M | 3.67M / 3.67M | 70 B | 70 B |
| Subscribe, returning payer with 0 / 50 past mandates, known key | 2.37M / 2.58M | 2.50M / 2.54M | 2,582 / 2,544 B | 2,626 / 2,599 B |

In M1 every Subscribe rewrote the plan's whole supporter array (and the payer's), so its gas grew by about 3,000 per existing supporter. In M1.1:

- **Per-plan and per-key lists are chunked** (`mandateList`, `r/mandate/store.gno`): the first 32 entries live inline, later ones in chunks of 32. Adding an entry rewrites at most one chunk. The list of chunks is rewritten once every 32 entries (at 10,000 supporters, about 313 references). Slices are never preallocated: with `make(.., 0, 32)` the first subscriber of a plan paid about 4 KB for 31 empty slots.
- **Per-payer lookups** (by session key, by plan, and the head of the payer's history) are entries in one of 256 hash buckets (`map[string]*Mandate`, chosen by the first byte of sha256(payer)). An entry is about 200 bytes, against about 2.2 KB for an avl insert. A lookup reads one bucket object instead of one object per tree level, which is what reads are priced by (59,000 gas × depth per object, 17 gas per byte). A bucket holds about three entries per payer, so at 10,000 payers a bucket is about 120 entries (about 25 KB, roughly 1M gas to read and rewrite); at 100,000 payers it would be about ten times that. If Mandate ever gets that big, the bucket count can grow in a new version.
- **A payer's history** is a linked list through the mandates (`prevOfPayer`). It is walked only by free reads (the payer page, `MandatesOf`, now newest first).
- **Mandate records were slimmed.** Paid (= pulls × price), LastPullAt (= next pull − period), PlanID and the session's public key are derived. The public key is the payee's current collector key when the address matches; otherwise the payer page shows how to look it up.
- **Pages read at most 200 mandates to count the active supporters of a plan.** Beyond that, they say "at least N (counted among the latest 200)". The home and payee tables show the number of mandates rather than an active count, so a page never reads thousands of records.

Every Pull updates only fields that already exist after the first pull (mandate, plan, payee totals and two package counters), so later pulls add no storage. The first pull adds about 20 bytes because amino omits zero values.
