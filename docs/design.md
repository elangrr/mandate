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
| Minimum amount | 0.1 GNOT (100,000 ugnot) | A Pull uses about 8–9M gas, about 9,000 ugnot at Onyx's minimum gas price; below 0.1 GNOT the fee would be a large share of each payment. |
| Maximum amount | 1,000,000 GNOT per period | Far above any real plan; keeps all totals far from int64 overflow. |
| Minimum period | 60 seconds | Block times are seconds; the chain's spend period is in seconds. Short periods exist for demos and tests; plan pages flag anything under a day as a test plan. |
| Maximum period | 366 days | A yearly plan plus slack. |
| Maximum term | 366 days from Subscribe | A payer renews at most once a year. The chain's own cap on a session is about 4 years. |
| Fee allowance (pages) | 0.05 GNOT | Added to the session's spend limit. Covers a Pull's fee at up to about 2.5x the measured gas at the minimum price, plus the first Pull's storage deposit (22 bytes, 2,200 ugnot). |
| Pull fee (pages, collector) | 20,000 ugnot for 20M gas wanted | 1 ugnot per 1,000 gas, Onyx's minimum price; measured use is 7.9–9.0M gas. |
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
| 17 | Spam: many plans or fake supporters | readers, later subscribers | Every list is paged (20 rows). Each record costs its creator a storage deposit (about 0.35 GNOT per plan, 0.55 GNOT per mandate). A plan's supporter list is one slice, so a plan with very many supporters makes each new Subscribe to it somewhat more expensive in gas. | `TestPaging`, `TestRenderPaging`. |
| 18 | The collector script run against the wrong network | payee | `scripts/collect.sh` has no defaults, accepts only `dev` with a local remote or `onyx-1` with the Onyx RPC. | Flow 6: refused without `-remote`, with onyx-1 and a local remote, and with another chain id. |
| 19 | The payee publishes a collector key whose address does not match | payer | The realm derives the address from the key itself (`chain.PubKeyAddress`). | `TestSetCollectorKey` (bad checksum, empty payload, wrong prefix refused; derived address checked). |

## What `gno test` cannot reach

`gno test` cannot sign with a session key, so `runtime.GetSessionInfo()` always says "not a session" there. Pull's rules are therefore split into `checkPull` (all the checks, taking the session info as arguments) and `recordPull` (the state update and event), which the unit tests call directly. The rest (signing, the chain's spend limit, revoke, expiry, the transfer and the session guard on the other functions) is proven by `scripts/local-flow.sh` on a real local chain.

## Measured costs (local gnodev, gno v1.8.0 fc79041f4, the same commit Onyx runs)

| Call | Gas used | Storage delta |
|---|---|---|
| Offer (first plan of a payee) | 7.2M | 5,306 bytes (0.53 GNOT) |
| Offer (later plans) | 8.0–9.8M, growing slowly with the number of plans | about 3,750 bytes (0.38 GNOT) |
| SetCollectorKey | 4.6M | 193 bytes |
| session create (chain) | 1.36M | none (auth store) |
| Subscribe (new payer, new collector key) | 8.6M | 6,943 bytes (0.69 GNOT) |
| Subscribe (new payer, known key) | not measured on chain | 5,439 bytes (0.54 GNOT), measured in a filetest |
| Pull, first of a mandate | 8.5–9.0M | 22 bytes (2,200 ugnot, counted against the spend limit) |
| Pull, later | 7.9–8.2M | **0 bytes** |
| Refused Pull (realm rule) | 4.9–5.4M | none (reverted) |
| Cancel | 5.3–5.8M | 64 bytes |

Where Subscribe's bytes go (from a filetest's realm ops): each avl insert writes two nodes of about 1 KB each (with their heap items), the Mandate record is about 1.5 KB, the Payer record about 1.2 KB, and the per-plan and per-key slices grow by a few hundred bytes when they reallocate. That is why the realm keeps only four trees (plans, payees, payers, collector keys) and stores per-payer, per-plan and per-key lists as slices inside their owner records: a returning payer with a known key adds no tree node at all.

Every Pull updates only fields that already exist after the first pull (mandate, plan, payee totals and two package counters), so later pulls add no storage. The first pull adds 22 bytes because amino omits zero values.
