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
                                      spend limit amount+0.1 GNOT,        per period, expiry
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
| Fee allowance (pages) | 0.1 GNOT | Added to the session's spend limit; it pays the Pull's fee and storage deposit. The chain accepts a fee when fee ÷ gas wanted ≥ the current gas price (`EnsureSufficientMempoolFees`, `tm2/pkg/sdk/auth/ante.go:548`); Onyx answers `auth/gasprice` with 1 ugnot per 1,000 gas, and raises it when blocks are full. At 20M gas wanted the minimum fee is 20,000 ugnot. A mandate's first pull also adds it to the plan's paid-once list: up to 446 bytes (44,600 ugnot) when that starts a new array, measured. So the allowance covers a gas price up to 2.7x today's on such a pull, and about 5x otherwise. It was 0.05 GNOT until M1.3; the first pull no longer fitted (64,600 ugnot, refused by the chain). |
| Pull fee (pages, collector) | 20,000 ugnot for 20M gas wanted | Exactly today's Onyx price. Measured use on a local chain is 7.6–8.2M gas; reads on Onyx cost more per object, because the chain prices a read by the depth of its store (`expectedDepth100`, `tm2/pkg/store/iavl/store.go:45`) and Onyx's store is far larger. 20M keeps about 2x headroom; the first Pull on Onyx will tell. |
| Title | 1–80 characters, one line | Same rules as QuestMaster: UTF-8, no control characters, no U+2028/U+2029. |
| Page size | 20 rows | Every list read and every page is paged. |
| Mandates per wallet | 16 active at a time | The chain's limit on sessions per account (`tm2/pkg/std/account.go:303`). Since M1.3 the realm refuses a 17th active mandate too, which bounds each payer's own record. Cancelled and expired ones free their slot. |

## Threat model

"Realm" is Mandate's own checks; "chain" is the session machinery of Gno v1.8.0. Test references: unit tests are in `r/mandate/*_test.gno`, steps are in `scripts/local-flow.sh`.

| # | Threat | Who is hurt | What stops it | How it is tested |
|---|---|---|---|---|
| 1 | The payee pulls more than the price | payer | Realm: exactly one coin, `ugnot`, equal to the price. Chain: spend limit per period. | `TestPullRules` (wrong coins, extra coins, other denoms); flow 3 (3 GNOT and 1 GNOT and no coins refused); flow 2 (chain limit). |
| 2 | The payee pulls more often than once a period | payer | Realm: `now >= next`. Chain: spend period. | `TestPullRules` (at next−1 refused, at next allowed, no catch-up); flow 2 (both the chain and, with a generous session, the realm refuse). |
| 3 | The payee uses the session to send coins or call another realm | payer | Chain: the session's allow list (`vm/exec:<realm>` only). | Flow 4: bank send and `other.Tip` refused, payer balance unchanged (gas used 0). |
| 4 | The payee uses the session to rewrite terms: Offer, Subscribe, Cancel, SetCollectorKey | payer | Realm: every crossing function except Pull refuses session callers (`directCaller`). Chain: sessions can never sign `auth/*` (create or revoke sessions) or `vm/add_package`. | Flow 4: all four refused with "cannot be called with a session key"; a session creating a session refused. Flow mutation: with the guard removed, the flow fails. |
| 5 | The payee burns the payer's allowance as gas fees | payer (bounded) | Chain: fees count against the spend limit; a fee above what is left is refused before any charge. The worst loss per period is the spend limit (price + 0.1 GNOT). Fees go to the network, not to the payee (except if the payee is a validator; not tested). | Flow 8: a doomed Pull with a fee of exactly the limit costs the payer exactly 1,100,000 ugnot and gives the payee nothing; a further fee is refused at no cost; the honest pull for that period is then also refused. |
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
| 17 | Spam: many plans | readers | The home page lists only plans with at least one paying supporter. It walks at most 200 plans per page and links onwards, so spam can delay but never hide a paid plan. All plans are on `:plans`, paged. Each plan costs its creator about 0.38–0.58 GNOT of deposit (Offer, measured in the flow). | `TestOfferSpam` (205 spam plans: none on the home page, the paid plan reached through "more"); `TestPaging`, `TestRenderPaging`. |
| 17a | Fake supporters: mandates recorded on a victim's plan without ever paying (anyone can Subscribe without creating a session) | readers of the supporter page | Supporters are listed and counted only while active and from their first payment on: the plan's `PaidOnce` list, counted when read. Never-paid active mandates are a number ("N active mandates have not paid yet"), never names. Expired mandates count as neither. | `TestPayingSupporters` (400 junk after a real supporter: not listed or counted; the real one is on the first page). `TestExpirySequences` (expiry, cancel, coming back in every order: GetPlan, the headline, the list, `SupportersOf`, the home page and the payee table agree). `measure-shared.sh junk 10000`: the plan page renders in 207 ms with "1 paying supporter" and "625 mandates have not paid yet". |
| 17b | Junk mandates for a victim payee's collector key, recorded without a session, to waste the collector's work | payee | The collector reads only its payee's own plans (`CollectorPlans`, then `CollectorScan` per plan, 200 entries per call). Before signing a Pull for a mandate that never paid, it asks the chain for the session (free query) and skips it when there is none. At most `-max-checks` (default 100) checks per run: never-checked first, newest first, then the oldest-checked, kept in a state file. A real new supporter is never starved; mandates that paid before are pulled without a check. A Pull without a session cannot even be built by gnokey, so nobody pays a fee for junk. | `measure-shared.sh junk 10000` (10,000 addresses, one mandate each; the realm allows one active mandate per payer and session key): the attacker paid **5,350 GNOT** in deposits. The collector listed 10,001 mandates in 67 realm queries and took **17 s** per run with the default 100 checks; checking all 10,000 took 257 s. Flow step 6: a junk mandate is checked and skipped, the state file written. |
| 17c | Growing what other payers' calls read: shared buckets (M1.1) or anything else | every other payer | **Per-payer layout (M1.3).** Each payer's lookups live in that payer's own record, at most 16 active entries. Cancel removes the entry, and an expired one goes at the next Subscribe. Plan lists hold strings, not pointers, and an append touches only the plan and its newest chunk. What remains shared is tree depth (payers, plans, payees), which grows with log2 of the number of entries. | `measure-shared.sh` with the M1.2 attacker budget: see "Shared structures" below. Loop: one address subscribing and cancelling 2,000 or 4,000 times leaves the victim's Pull at 8.46M and 8.45M (baseline 8.29M). Depth: 2,300 new payer addresses (1,230 GNOT) raise Pull to 10.24M. `TestPayerIsolation`, `TestActiveCap`, `TestInactiveReads`. |
| 18 | The collector script run against the wrong network | payee | `scripts/collect.sh` has no defaults, accepts only `dev` with a local remote or `onyx-1` with the Onyx RPC. | Flow 6: refused without `-remote`, with onyx-1 and a local remote, and with another chain id. |
| 19 | The payee publishes a collector key whose address does not match | payer | The realm derives the address from the key itself (`chain.PubKeyAddress`). | `TestSetCollectorKey` (bad checksum, empty payload, wrong prefix refused; derived address checked). |

## Shared structures (measured, M1.3)

`scripts/measure-shared.sh` runs each scenario on a fresh local chain, then measures the victim's own real, signed transactions:
- the victim's Pull, signed with a real session;
- a Subscribe and a Cancel on an untouched plan;
- a Subscribe to the plan the attacker used (plan 17).

The many attacker addresses of "depth" and "junk" are loaded as genesis transactions, so gas there is the victim's, measured live. The budget of the depth scenario matches the M1.2 bucket flood (about 1,240 GNOT).

| Scenario | Attacker deposits (never returned) | Victim Pull (later) | Victim Subscribe | Victim Subscribe to the attacker's plan | Victim Cancel |
|---|---|---|---|---|---|
| baseline | 0 | 8.29M | 9.32M | 9.54M | 7.70M |
| loop: one address, 2,000 subscribe+cancel on plan 17 | 343 GNOT | 8.46M | 9.86M | 10.15M | 8.23M |
| loop: 4,000 | 687 GNOT | 8.45M | 9.86M | 10.08M | 8.23M |
| depth: 2,300 new payer addresses | 1,230 GNOT | 10.24M | 15.95M | 16.17M | 14.40M |
| junk: 10,000 addresses with a never-paid mandate for the victim's collector key | 5,350 GNOT | 10.70M | 17.67M | 17.72M | 15.99M |

For comparison, the same 1,240 GNOT put into one M1.1 bucket pushed the victim's Pull to 22.8M, Subscribe to 41.0M and Cancel to 20.6M.

What is left is the depth of the payer tree:
- Pull grows by about 0.2M gas per doubling of the number of payers.
- Subscribe and Cancel grow by about 0.65M per doubling, because they write the payer's record back into the tree.
- At 100,000 payers that projects to about 11M for Pull and about 18M for Cancel, well inside the pages' 20M and 30M gas wanted.
- Each doubling costs the attacker as many new payers as already exist, at about 0.53 GNOT each.

**Storing payer records by value** (decided in M1.3) saves about 400 B per new payer, but every Subscribe and Cancel writes the record back and so rewrites the tree path. Measured cost of that depth:
- **At baseline (a handful of payers):** Subscribe and Cancel cost 9.3M and 7.7M gas.
- **At 2,300 payers:** 15.9M and 14.4M.
- **At 10,000 payers:** 17.5M and 16.0M.
- **Pull only reads the record:** +0.2M gas per doubling, against +0.65M per doubling for Subscribe and Cancel.
- **Projection:** at 100,000 payers, about 18M for Cancel, inside the pages' 30M gas wanted.

A Subscribe to a plan whose newest chunk is partly full costs a little more: up to about 0.3M gas here, bounded by the 32-entry chunk. It does not grow with the plan's history: 4,000 entries cost the same as 2,000.

## Stored values that depend on time (checked in M1.3)

Expiry needs no transaction, so nothing stored may count on it. This was checked:
- **Removed:** the `Plan.Paying` counter.
- **Time-independent (they count transactions that happened):**
  - the plan's, payee's and package totals (pulls, paid, last pull, plans);
  - `Plan.Cancelled` (cancels ever);
  - the supporter and paid-once lists (append-only history).
- **Payer.Active may hold an expired entry until the payer's next Subscribe.** Every use checks or prunes:
  - Subscribe prunes before checking duplicates and the cap;
  - Pull refuses with "expired";
  - Cancel may cancel an expired mandate, which is harmless;
  - `IsActive`, `NextPullAt`, `CollectorScan`, `SupportersOf` and the counts check `isActive`.
- **Computed when read:** the mandate status, `Due`, `LastPullAt` and the payer page.
- **Renamed:** the home page's "Mandates" total is now "Mandates ever recorded", which is what it is.

## What `gno test` cannot reach

`gno test` cannot sign with a session key, so `runtime.GetSessionInfo()` always says "not a session" there. Pull's rules are therefore split into `checkPull` (all the checks, taking the session info as arguments) and `recordPull` (the state update and event), which the unit tests call directly. The rest (signing, the chain's spend limit, revoke, expiry, the transfer and the session guard on the other functions) is proven by `scripts/local-flow.sh` on a real local chain.

## Measured costs (local gnodev, gno v1.8.0 fc79041f4, the same commit Onyx runs)

From `scripts/local-flow.sh` (real signed transactions). M1.1 is commit e37e544 (shared hash buckets); M1.3 is the current per-payer layout.

| Call | Gas M1.1 | Gas M1.3 | Storage M1.1 | Storage M1.3 |
|---|---|---|---|---|
| Offer (first plan of a payee) | 7.5M | 7.7M | 5,781 B | 6,307 B |
| SetCollectorKey | 4.8M | 4.9M | 195 B | 193 B |
| session create (chain) | 1.36M | 1.36M | 0 (auth store) | 0 |
| Subscribe: new payer, new key | 9.9M | 7.9M | 6,185 B | 4,560 B |
| Subscribe: returning payer, new key | 10.7M | 8.9M | 6,694 B | 2,701 B |
| **Subscribe: new payer, known key** | 11.0M | 8.2M | 3,145 B (0.31 GNOT) | **5,229 B (0.52 GNOT)** |
| Subscribe: returning payer, known key | 11.9M | 9.4M | 2,274 B | 1,796 B |
| Pull, first of a mandate | 8.2M | 9.3M | 18 B | 440 B (starts the plan's paid-once list; later first pulls on the same plan add one string) |
| Pull, later | 7.6M | 8.6M | **0 B** | **0 B** |
| Cancel | 5.3M | 7.6–9.3M | 64–76 B | −122 to −132 B |

- **"New key" no longer costs anything extra**: M1.3 has no per-key index.
- **A new payer costs about 2.1 KB more than in M1.1**: an avl insert into the payer tree (two nodes, about 2.2 KB), and the payer's own record stored by value (no heap item). In exchange, nothing another address does can grow what this payer's calls read.
- **Pull and Cancel cost about 1M and 2–4M more gas than in M1.1**: they look the payer up in the tree, and Cancel writes the record back.
- **Cancel's storage delta is negative.** It removes the mandate's entry from the payer's record. The chain refunds the freed bytes to the signer of the Cancel, the payer or the payee, at the realm's average deposit per byte (`gno.land/pkg/sdk/vm/keeper.go:2561-2598`). That is about 13,000 ugnot for 130 bytes, not necessarily to the address that paid for those bytes.

### The layout (M1.3)

- **Payers:** an avl tree `payer -> Payer`, by value. Each record holds only that payer's own lookups:
  - `Active`: at most 16 entries (session address, plan id, mandate id, pointer), so Pull, Subscribe and Cancel find a mandate by scanning one small array;
  - `Head`: the newest mandate, with older ones linked through `prevOfPayer` (history, walked only by free reads).

  Cancel removes the entry. An expired entry is removed at the payer's next Subscribe. A 17th active mandate is refused.
- **Plans' supporter lists (`supporterList`)** store one short string per mandate (the payer's 40-character address followed by the mandate id), never pointers:
  - Rewriting an array costs about 0.37M gas for every pointer it holds to a shared ("escaped") object, measured with a probe realm (docs/notes.md). With pointers, an append cost up to 13M gas, and the list of chunks became dearer every 32 entries: 9.6M gas at 2,016 entries, about +0.11M per chunk.
  - The newest entries live in the plan itself (`tail`); a full tail becomes a chunk. So an append rewrites the plan and its tail, and touches the list of chunks only once every 32.
  - Strings also measured about 400 bytes less per mandate than a two-field struct, and about 80 less than a pointer.
- **Reads resolve list entries through the payer's record**, so they cost one tree lookup per entry. Only free reads do this; they walk at most 200 entries per call and return a cursor:
  - the supporter page;
  - `SupportersOf`, which now returns active mandates only;
  - `CollectorScan`.
- **Supporters are counted and listed from their first payment on, while they are active, computed when read.** No stored counter can follow expiry, which happens without a transaction. In M1.3's first cut, a stored `Paying` counter kept counting expired mandates, and counted a payer twice after they came back.
  - Each plan keeps a second list, `PaidOnce`, of mandates that have paid. A mandate's first pull adds it.
  - Reads count and list the entries whose mandate is still active right now: `countPaying`, `payingFrom`, `hasPaying`.
  - A payer has at most one active mandate per plan, so nobody counts twice. An expired or cancelled mandate is neither a supporter nor "not yet paid".
  - "Not yet paid" is counted the same way over the plan's main list (`countUnpaid`): active mandates with no pull.
  - Counts look at the latest 200 entries; beyond that the pages say "at least" or add "+". Only real payments grow `PaidOnce`, so junk cannot crowd it.
  - The home page lists a plan when `hasPaying` finds one active paying mandate, walking at most 50 plans per page with a cursor.
  - Cost: a mandate's first pull adds one string to `PaidOnce`, paid by the payer within the fee allowance; later pulls still add nothing.
- **The home page lists only plans with at least one paying supporter**, walking at most 200 plans per page with a "more" link. All plans are on `:plans`.
- **The collector reads by payee**: `CollectorPlans(payee)`, then `CollectorScan(plan, key, from)` for each plan. There is no per-key list, so mandates recorded for a payee's key on someone else's plan never reach its collector.
- **Mandate records are slim:**
  - Paid = pulls × price;
  - LastPullAt = next pull − period;
  - PlanID comes through the plan pointer;
  - the session's public key is the payee's current collector key when the address matches.

### What reads return for a cancelled or expired mandate

- `MandateOf(payer, session)` returns the newest mandate for that pair, with Status "cancelled" or "expired". When it is no longer in the active list, the read walks the payer's history.
- `IsActive` is false, and `NextPullAt` is 0.
- `SupportersOf` and the supporter page leave it out.
- Pull and Cancel look only at the active list:
  - after a cancel they fail with "no active mandate for this session (never recorded, cancelled or replaced)";
  - an expired mandate still says "mandate: expired" until its payer subscribes again.

Every Pull after a mandate's first updates only fields that already exist (mandate, plan, payee totals and two package counters), so it adds no storage. The first pull adds the mandate to the plan's paid-once list and sets fields that were zero (amino omits zero values): up to 446 bytes measured, paid from the fee allowance.
