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
- **Billing in advance.** The first payment is due as soon as the mandate is recorded and is collected by the first Pull, not by Subscribe (Subscribe refuses coins: the realm takes money only in Pull). Each later Pull is allowed from one period after the previous one: `next = time of last pull + period`. This is the same rule the chain uses for the session's spend period (`tm2/pkg/sdk/auth/spend.go`: the window resets at the first spend after `reset + period`), so a pull the realm allows is never refused by the chain for budget as long as the session's limit covers the price plus the pull's fee and storage deposit and no fees were burned in the same window. The chain counts the storage deposit against the spend limit after the call, so Pull is built never to create an object: its deposit is at most a few dozen bytes at every position in every list (see "Pull's budget" below). Until M1.4, the first payment of a plan's 32nd and later supporters created an object and was refused by the chain with the pages' sessions (audit HIGH-1, reproduced on a local chain). A missed period is never collected later (no arrears).
- **Paid time is not lost or charged twice (M1.5), with one exception (below).** When a mandate ends while its last payment still covers the payer (cancelled by either side, or expired and pruned at the payer's next Subscribe), the payer's record keeps a credit for that plan: until when it is paid. A new mandate of the same payer for the same plan starts with its first pull at that time instead of at once, and its list entry starts as paid (covered). `PaidThrough` reads the credit too. Until M1.5, re-subscribing after a collector key rotation, a cancel by either side or a yearly renewal charged a second time for a period already paid (second audit, MEDIUM-A).
- **Expiry.** Required, in unix seconds, at most 366 days ahead. Pulls are refused from that second on. The plan page suggests one year and the same expiry for the chain session.
- **Mandate key.** A mandate is found by (payer, session address). Pull takes the payer from `OriginCaller` (the session's master account) and the session address from `GetSessionInfo`, so it needs no arguments. A payer can have at most one active mandate per plan and per session key; after a cancel or expiry the same key can be used again (a new mandate is recorded and the old one stays in the history), and the time already paid for carries over to it.
- **Collector key.** The payee publishes the bech32 public key once; the realm derives its address with `chain.PubKeyAddress`, so the address on the plan page always matches the key. Payers may also give a session to another key the payee hands them (the realm then does not know its public key and the payer page shows how to look it up).

### Limits and why

| Limit | Value | Why |
|---|---|---|
| Minimum amount | 0.1 GNOT (100,000 ugnot) | The chain charges the whole fee the signer sets, not the gas used. The pages' Pull fee is 20,000 ugnot (see below), already a fifth of a 0.1 GNOT payment; below that, fees would dominate. |
| Maximum amount | 1,000,000 GNOT per period | Far above any real plan; keeps all totals far from int64 overflow. |
| Minimum period | 60 seconds | Block times are seconds; the chain's spend period is in seconds. Short periods exist for demos and tests; plan pages flag anything under a day as a test plan. |
| Maximum period | 30 days | Exactly the chain's limit on a session's spend period (`std.MaxSpendPeriod` = 2,592,000 s, `tm2/pkg/std/account.go:314`; a longer one is refused in `tm2/pkg/sdk/auth/handler.go:82`). The session's spend period is always the plan's period, so the cap the pages promise (at most price + allowance per period) is exactly what the chain enforces. No yearly plans. Until M1.6 the realm accepted 366 days and printed a session command the chain refuses (third audit, HIGH-1). |
| Maximum term | 366 days from Subscribe | A payer renews at most once a year. The chain caps a session's expiry at 4 × 365 days (`std.MaxSessionDuration`, `tm2/pkg/std/account.go:310`), so the pages' one-year session is always accepted. |
| Fee allowance (pages) | 0.1 GNOT | Added to the session's spend limit; it pays the Pull's fee and storage deposit. A Pull costs the payer at most the fee (20,000 ugnot at today's Onyx gas price for the collector's 20M gas wanted) plus at most 100 bytes of storage (10,000 ugnot at Onyx's 100 ugnot per byte): 30,000 ugnot. 0.1 GNOT leaves a margin of 70,000 ugnot; why it was kept rather than lowered is in "Pull's budget". |
| Own-key calls (pages) | 100,000 ugnot for 60M gas wanted | Offer, SetCollectorKey, session create and revoke, Subscribe, Cancel. The heaviest measured is a Subscribe by a payer who already holds 15 active mandates (the 16th, the most a record holds) that lands on a chunk boundary of a 32,767-entry plan: 31.5M gas on a local chain (30.2M on the super-chunk boundary; "Lists at their boundaries"). Onyx charges more per object (deeper store). 60M leaves 1.9 times that; 40M (M1.4) would have left 1.27 times, so M1.5 raised it (second audit, LOW-D). The fee stays 100,000 ugnot: that is 1.67 ugnot per 1,000 gas, above Onyx's 1 today; if the chain's price rose above it the node would refuse the transaction before charging anything. |
| Pull fee (pages, collector) | Help page: 20,000 ugnot for 20M gas wanted. Collector: from the chain's gas price | The help page's command uses exactly today's Onyx minimum and says to raise `-gas-fee` with `auth/gasprice`. Since M1.6 the collector reads `auth/gasprice` each run and pays the minimum for its 20M gas wanted plus a quarter (25,000 ugnot today), lowered for each mandate to what its session can still pay this period after the price and the storage bound, and never below the minimum (then the mandate is skipped with the reason). Measured use on a local chain: 8.5–9.5M gas in the flow, 11.6M at the oldest entry of a 1,058-entry plan, 12.3M at 10,274 entries (it grows with the log of the store's size). Reads on Onyx cost more per object, because the chain prices a read by the depth of its store (`expectedDepth100`, `tm2/pkg/store/iavl/store.go:45`) and Onyx's store is far larger. |
| Title | 1–80 characters, one line | UTF-8, no control characters, no U+2028/U+2029, and since M1.4 no format characters (Unicode category Cf: direction controls, zero-width characters, the joiner included), which can make a title display differently from what it says. So emoji joined with the zero-width joiner (families, some flags) are refused; the creator help says so. |
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
| 9 | The realm still says "active" after an on-chain revoke, or a service grants access to a mandate that never paid | payee, services that deliver on a mandate | A realm cannot see a revoke. Since M1.4 the read for services is `PaidThrough(payer, plan)`: the time until which the supporter's latest successful payment covers them (0 if they never paid; kept after a cancel or an expiry, see 9b). It moves only when a Pull succeeds, so a revoked supporter runs out within one period with no extra check. `IsActive` is gone; `HasMandate` keeps its old meaning with a warning, and the help page tells services to use `PaidThrough`. `MandateInfo.SessionQuery` still gives the free session query for anyone who wants to know sooner. | Flow 9: `HasMandate` true after the revoke, the session query says `SessionNotFound`. Flow 13: `PaidThrough` > now for each of 32 paid supporters. `TestPaidThrough` (0 before paying, payment + period after, 0 after a cancel); mutations (inclusive `IsPaidUp`, PaidThrough before payment) caught. |
| 9b | Charged twice for one period: a new mandate for the same plan after a cancel (by either side), a collector key rotation, an expiry or the yearly renewal of a mandate | payer | Paid time carries over (M1.5): the payer's record keeps a credit per plan until when it is paid, and the next mandate for that plan first pulls when it ends. Bounded: at most 16 credits per payer, only the payer's own record is read or written. **The exception:** a payer who already holds 16 kept periods. Then the payer's own Cancel or expiry lets the period that ends soonest go, and a payee's Cancel keeps nothing for that payee's plan (it never evicts another creator's credit). The only party who can cause a loss on purpose is that payee, on its own plan, and only for a payer at the bound; the payer page then says the time could not be kept. | `TestNoDoubleCharge` (payer cancels and returns, payee cancels, key rotation, renewal on day 364 and day 366 of 13 monthly payments, another session key, two plans, a credit that ran out, entry status and payment counts); `TestCreditBound` (17 plans left: 16 kept, the soonest gives way); `TestPaidThrough`. Flow 14: cancel and re-subscribe on chain within a paid minute: an immediate pull refused ("too early", nothing charged), the collector waits, then takes exactly one price and one fee. |
| 10 | A third party pulls | payer | Chain: needs the session key's signature. Realm: the mandate is keyed by (payer, session address) and pays only the plan's payee. | `TestPullRules` (other payer, other session refused). |
| 11 | Replay of an old signed Pull | payer | Chain: each session account has its own sequence (`auth/accounts/<payer>/session/<key>` shows it). | Not run (source only; the spike's offline-signed pull after revoke was refused as "unknown session"). |
| 12 | The collector key leaks | payer (bounded) | The thief can only pull to the payee, on schedule, or burn fees up to the spend limit per period. The payer revokes; the payee publishes a new key. | Covered by 1–5. |
| 13 | The realm keeps or sweeps funds | payer, payee | Pull forwards exactly the coins it receives in the same transaction; every other function refuses coins; there is no admin, owner, pause, upgrade or sweep. Coins sent to the realm with a plain bank send are stuck forever (nobody can move them). | Unit tests: coins refused on Offer, Subscribe, Cancel, SetCollectorKey. Flow: realm balance asserted zero after every transaction; flow mutation (forward amount−1) fails with "the realm holds 1ugnot". |
| 14 | Pull called by another realm (a proxy that adds its own logic) | payer | Realm: Pull and every other crossing function require a direct call from a user (`IsUserCall`). | `TestPullEntryPoint`, `TestOfferRefusals`, `TestSubscribeRefusals`. |
| 15 | Injection through plan titles (Markdown, HTML, links, mentions, math) | page readers | Titles are validated (one line, no control characters) and escaped with `p/nt/markdown/sanitize/v0` plus gnoweb-specific steps (`$`, `@`, leading and spaced `g1` addresses). | `TestRenderInjection` (14 hostile titles on every page that shows them); `z_pages_filetest` golden; mutations removing `$` or address escaping are caught. |
| 16 | Expired terms | payer | Realm: `now >= ExpiresAt` refused. Chain: session expiry. | `TestPullRules` (one second before allowed, at expiry refused); flow 7 (chain expiry and realm expiry each refuse). |
| 17 | Spam: many plans | readers | The home page lists only plans with a payment in the plan's current or previous period (two counters per plan, updated by Pull; nothing to walk). It walks at most 200 plans per page and links onwards, so spam can delay but never hide a paid plan, and churn (supporters leaving, junk mandates) cannot hide a plan someone pays for. All plans are on `:plans`, paged. Each plan costs its creator about 0.38–0.58 GNOT of deposit (Offer, measured in the flow). **Self-paid spam is not stopped:** a creator can pay its own plan from a second wallet and so put it on the home page, for about 1.2 GNOT per plan (the plan's and the mandate's deposits and the fees; the payment itself comes back to the creator). With a 30-day period (the longest) one payment keeps a plan listed for up to about two months. It cannot hide anyone else's paid plan (all are reachable through "more"), and the counts say "payments", not "supporters" (second audit, LOW-C). Every link to a plan shows its number with its title, so a title that looks blank or copies another's cannot pass for another plan. | `TestOfferSpam` (205 spam plans: none on the home page, the paid plan reached through "more"); `TestHomeSurvivesChurn` (a paid plan stays on the home page while others subscribe, cancel and expire around it); `TestPaging`, `TestRenderPaging`. |
| 17a | Fake supporters: mandates recorded on a victim's plan without ever paying (anyone can Subscribe without creating a session) | readers of the supporter page | Supporters are listed only while active and from their first payment on: each entry of the plan's list carries a status (unpaid, paid, cancelled) that Pull and Cancel flip in place. Counts are payments per period ("N payments in the current period, M in the one before"), which only real payments move. Never-paid active mandates are a number ("N active mandates have not paid yet"), never names. Expired mandates count as neither. | `TestPayingSupporters` (400 junk after a real supporter: not listed or counted; the real one is on the first page). `TestPayingWalkBounded` (1,010 junk: the walk stops at 1,000 and the next page finds the real one). `TestPaymentWindows` (a payment counts in its window, then as "the one before", then not at all). `TestFixedList` (positions 0, 31, 32, 33, 1,023, 1,024 and the last, past one super-chunk). `TestExpirySequences` (expiry, cancel, coming back in every order: GetPlan, the headline, the list, `SupportersOf`, the home page and the payee table agree). `measure-shared.sh junk 10000`: the plan page renders in 207 ms with "1 paying supporter" and "625 mandates have not paid yet". |
| 17b | Junk mandates for a victim payee's collector key, recorded without a session, to waste the collector's work; or sessions that cannot pay | payee, payer | The collector reads only its payee's own plans (`CollectorPlans`, then `CollectorScan` per plan, 200 entries per call). It reads each due mandate's session on chain (free) before pulling, and skips with the reason a session that is missing or revoked, not scoped to exactly the realm, below price + fee + storage bound, already spent for this spend period, or about to expire. At most `-max-checks` (default 500 since M1.5, about a minute and a half per run) never-paid mandates are read per run, never-read first, then oldest-read, kept in a state file that holds only mandates still listed and is replaced atomically through a private temporary file. To keep a real first payment waiting, an attacker must record more than 500 new never-paid mandates (about 265 GNOT) before every run; running the collector every 10 minutes makes that about 1,600 GNOT an hour. Only a pull that was included in a block and failed (the payer paid the fee) is put off to the plan's next period; one refused in simulation or by the mempool, or lost to a network error, cost nothing and is tried again on the next run (M1.5, second audit LOW-B). A revoked session is not an error (exit 0). Since M1.6: a mandate whose payer already paid for the plan (pulled, or carried paid time into it; CollectorScan's last column) is never queued behind junk; runs never overlap (a lock next to the state file, `flock`); the Pull fee follows the chain's gas price (see "Pull fee" above). Since M1.7: one lock per collector key and realm in the user's own state folder, a run that cannot get it within 60 s exits 3; every gnokey call has a time limit and does not inherit the lock; after an unclear result (timeout, lost connection) the realm is asked whether the pull went through; each run warns if the collector key's address has become an account (threat 20). | `measure-shared.sh junk 10000` (M1.3): the attacker paid **5,350 GNOT** in deposits; the collector listed 10,001 mandates in 67 realm queries and took 17 s per run with 100 checks. Flow step 6 (junk skipped); step 13 (32 real first payments; low limit, wide scope and revoked sessions skipped with their reason; a pull refused in simulation is tried again on the next run at no cost; the same pull sent without simulation is included, fails, costs one fee and is not tried again in that period; a stale state line pruned; no temporary file left; exit 0 on every run). |
| 17c | Growing what other payers' calls read: shared buckets (M1.1) or anything else | every other payer | **Per-payer layout (M1.3).** Each payer's lookups live in that payer's own record, at most 16 active entries. Cancel removes the entry, and an expired one goes at the next Subscribe. Plan lists hold strings, not pointers, and an append touches only the plan and its newest chunk. What remains shared is tree depth (payers, plans, payees), which grows with log2 of the number of entries. | `measure-shared.sh` with the M1.2 attacker budget: see "Shared structures" below. Loop: one address subscribing and cancelling 2,000 or 4,000 times leaves the victim's Pull at 8.46M and 8.45M (baseline 8.29M). Depth: 2,300 new payer addresses (1,230 GNOT) raise Pull to 10.24M. `TestPayerIsolation`, `TestActiveCap`, `TestInactiveReads`. |
| 18 | The collector script run against the wrong network | payee | `scripts/collect.sh` has no defaults, accepts only `dev` with a local remote or `onyx-1` with the Onyx RPC. | Flow 6: refused without `-remote`, with onyx-1 and a local remote, and with another chain id. |
| 19 | The payee publishes a collector key whose address does not match | payer | The realm derives the address from the key itself (`chain.PubKeyAddress`). | `TestSetCollectorKey` (bad checksum, empty payload, wrong prefix refused; derived address checked). |
| 20 | **A collector key that receives coins blocks new supporters** (fourth audit, MEDIUM-1). The chain refuses to create a session for a key whose address is already an account (`tm2/pkg/sdk/auth/handler.go:63-65`, "session key address collides with existing account"), and receiving any coin makes the address an account for good (`ensureAccount`, `tm2/pkg/sdk/bank/keeper.go:238-244`, called at :437). | creator, would-be supporters | Cost to an attacker: one 1 ugnot send and its fee, repeatable after every key rotation. Blocks only new sessions for that key (new supporters, renewals that need a new session). Does not touch existing mandates or funds: the ante looks sessions up by payer and key (`tm2/pkg/sdk/auth/ante.go:168-178`), so existing sessions keep pulling. Defences (M1.7): `SetCollectorKey` refuses a key whose address holds coins (catches the honest mistake of funding it "for fees"); the plan page shows "New supporters cannot join right now" instead of commands the chain would refuse, the payee page warns, `GetPayee` has `CollectorFunded`; the creator help says never to send coins to the collector key and how to rotate; the collector checks its own key with the free query `auth/accounts/<address>` at every run and warns; `Subscribe` accepts any session key, so a creator can also hand supporters a fresh key privately. A balance check cannot see an address that is an account without holding coins: one that received coins and sent them on, or, cheaper for a griefer, one to which a realm minted its own coin and burned it again (`SDKBanker.IssueCoin` → `MintCoins` → `AddCoins` → `ensureAccount`, `tm2/pkg/sdk/bank/keeper.go:437`, `tm2/pkg/sdk/bank/supply.go:168`; the burn deletes a zero balance, `tm2/pkg/sdk/bank/balance.go:168`). Then the plan page still shows the commands, and every `session create` for the key fails with `session key address collides with existing account` (`tm2/pkg/sdk/auth/handler.go:63`). So the pages say the notice appears "in most cases", print that exact error string next to the session command with what it means (ask the creator for a new key), and the collector and the web app ask the chain itself (`auth/accounts/<address>`), which sees every case (fifth audit, LOW-1). The banner says existing mandates keep working until they expire, and renewing needs the new key. | `TestFundedCollectorKey` (refusal, pages, `GetPayee`, a fresh key restores the commands). Flow 16: 1 ugnot sent to the collector key's address; a new supporter's session create is refused by the chain; the plan page warns (Render reads balances); republishing the funded key is refused; existing sessions still pull and the collector warns; a fresh key is published, a new supporter joins with the page's commands and is collected by a second collector for the new key, while the old key's collector keeps its mandates. |

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
- At 100,000 payers that projects to about 11M for Pull and about 18M for Cancel, well inside the pages' 20M and 60M gas wanted.
- Each doubling costs the attacker as many new payers as already exist, at about 0.53 GNOT each.

**Storing payer records by value** (decided in M1.3) saves about 400 B per new payer, but every Subscribe and Cancel writes the record back and so rewrites the tree path. Measured cost of that depth:
- **At baseline (a handful of payers):** Subscribe and Cancel cost 9.3M and 7.7M gas.
- **At 2,300 payers:** 15.9M and 14.4M.
- **At 10,000 payers:** 17.5M and 16.0M.
- **Pull only reads the record:** +0.2M gas per doubling, against +0.65M per doubling for Subscribe and Cancel.
- **Projection:** at 100,000 payers, about 18M for Cancel, inside the pages' 60M gas wanted.

A Subscribe to a plan whose newest chunk is partly full costs a little more: up to about 0.3M gas here, bounded by the 32-entry chunk. Since M1.4 the lists have two levels (below), so no append grows with the plan's history; measured at 32,800 entries in "Lists at their boundaries".

## Stored values that depend on time (checked in M1.3 and M1.4)

Expiry needs no transaction, so nothing stored may count on it. This was checked:
- **Removed:** the `Plan.Paying` counter (M1.3), and the per-read "paying supporters" count over a list (M1.4: it walked a list whose entries could expire, so a plan could drop off the home page through churn, audit LOW-1).
- **Time-independent (they count transactions that happened):**
  - the plan's, payee's and package totals (pulls, paid, last pull, plans);
  - `Plan.Cancelled` (cancels ever);
  - the per-plan payment counters (M1.4): the period window of the latest payment and the payments in it and in the window before. Pull updates them; a read interprets them against the current time (`paidWindows`), so they need no transaction to stay true: a window that has passed simply reads as zero;
  - each list entry's status (unpaid, paid, cancelled), set by Subscribe, Pull and Cancel;
  - a payer's credits (M1.5): until when a plan is paid for. A read compares them with the current time, and Subscribe and Cancel drop the ones that have run out, so a credit in the past is never used.
- **Payer.Active may hold an expired entry until the payer's next Subscribe.** Every use checks or prunes:
  - Subscribe prunes before checking duplicates and the cap;
  - Pull refuses with "expired";
  - Cancel may cancel an expired mandate, which is harmless;
  - `HasMandate`, `NextPullAt`, `CollectorScan`, `SupportersOf` and the unpaid count check `isActive`.
- **Computed when read:** the mandate status, `Due`, `LastPullAt`, `PaidThrough` (the latest payment + period) and the payer page.
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

**M1.5** (same flow, with paid-time credits): Subscribe new payer, known key 8.9M / 5,367 B (0.54 GNOT, +89 B against M1.4); returning payer, known key 10.1M / 1,844 B; **returning payer whose paid time carries over 12.5M / 1,403 B**; Pull first 9.7M / 18 B, **first pull after carried-over time 10.0M / 18 B**; Pull later 8.9M / 0 B; Cancel 8.2–9.9M / −116 to −132 B.

**M1.4** (same flow, two-level lists with in-place status): Offer 8.1M / 6,167 B; SetCollectorKey 5.1M / 194 B; Subscribe new payer, new key 8.5M / 4,625 B; returning payer, new key 9.5M / 2,759 B; **new payer, known key 8.7M / 5,278 B (0.53 GNOT, +49 B against M1.3)**; returning payer, known key 9.9M / 1,844 B; Pull first 9.5M / 18 B; Pull later 8.8M / 0 B; Cancel 8.0–9.7M / −116 to −132 B.

- **"New key" no longer costs anything extra**: M1.3 has no per-key index.
- **A new payer costs about 2.1 KB more than in M1.1**: an avl insert into the payer tree (two nodes, about 2.2 KB), and the payer's own record stored by value (no heap item). In exchange, nothing another address does can grow what this payer's calls read.
- **Pull and Cancel cost about 1M and 2–4M more gas than in M1.1**: they look the payer up in the tree, and Cancel writes the record back.
- **Cancel's storage delta is negative.** It removes the mandate's entry from the payer's record. The chain refunds the freed bytes to the signer of the Cancel, the payer or the payee, at the realm's average deposit per byte (`gno.land/pkg/sdk/vm/keeper.go:2561-2598`). That is about 13,000 ugnot for 130 bytes, not necessarily to the address that paid for those bytes.

### The layout (M1.3)

- **Payers:** an avl tree `payer -> Payer`, by value. Each record holds only that payer's own lookups:
  - `Active`: at most 16 entries (session address, plan id, mandate id, pointer), so Pull, Subscribe and Cancel find a mandate by scanning one small array;
  - `Head`: the newest mandate, with older ones linked through `prevOfPayer` (history, walked only by free reads);
  - `Credits` (M1.5): at most 16 (plan id, paid until), each still in the future. Cancel and the expiry prune add one when the ending mandate is paid ahead; Subscribe uses up the plan's credit. Every operation on them reads at most 16 entries of the payer's own record. At the bound (16 plans left while each is paid ahead): the payer's own Cancel, or the expiry prune at the payer's own Subscribe, lets the credit that ends soonest give way to a later one (that plan's remaining time is lost); **a payee's Cancel never evicts a credit**: when the record is full, the credit that Cancel would make is the one not kept, and the payer page says the time could not be kept. So no third party can remove a credit the payer holds (third audit, LOW-3). Subscribe takes the plan's own credit before pruning, so a prune can never evict the credit it is about to use (LOW-2), and a new mandate must expire after the paid time it carries, or Subscribe refuses it, so one payment cannot mint a series of short mandates listed as paid (LOW-1).

  Cancel removes the entry. An expired entry is removed at the payer's next Subscribe. A 17th active mandate is refused.
- **Plans' supporter lists and payees' plan lists (`fixedList`, M1.4)** store fixed-width strings, never pointers to shared objects:
  - A supporter entry is the payer's 40-character address, the mandate id in 10 digits and one status character (`0` unpaid, `1` paid, `x` cancelled): 51 bytes. A mandate remembers its position (`Index`), so Pull and Cancel rewrite the status character in place, which never changes the storage size.
  - Two levels: the newest entries live in the owner itself (`tail`, fewer than 32); a full tail becomes a chunk of 32, appended to the last super-chunk (at most 32 chunks); the owner holds the list of super-chunks, which grows by one pointer per 1,024 entries. So no array an append rewrites grows with the list's length: an append rewrites the owner and its tail, every 32nd also creates a chunk and rewrites one super-chunk, every 1,024th also rewrites the super-chunk list.
  - Rewriting an array costs about 0.37M gas for every pointer it holds to a shared ("escaped") object, measured with a probe realm (docs/notes.md). In M1.3 the plan's list of chunks grew by one pointer every 32 entries (+0.11M gas per chunk, about +110M at 32,000 entries for the Subscribe that starts a chunk), and a payee's plan list was a slice of pointers to plans (`PlanList`), rewritten in full by each Offer (audit LOW-2, LOW-3).
- **Reads resolve list entries through the payer's record**, so they cost one tree lookup per entry they resolve, about 2.7M gas at 32,800 payers. Only free reads do this, and each is bounded per call (they return a cursor):
  - the supporter page: lists paid entries (status `1`), walking at most 1,000 entries and resolving at most 200, and counts never-paid active mandates among the latest 200 entries (status `0` only);
  - `SupportersOf`: active mandates, cancelled entries skipped without a lookup;
  - `CollectorScan`: 200 entries per call, cancelled ones skipped without a lookup.
- **Supporters are listed from their first payment on, while they are active; counts are payments per period.** No stored value can follow expiry, which happens without a transaction.
  - A mandate's first pull flips its entry from unpaid to paid; listing walks paid entries and keeps the active ones.
  - The headline and the home page count payments in the plan's current period window and in the one before (`PaidThisPeriod`, `PaidLastPeriod`, `PeriodStart` in `GetPlan`). Only a successful Pull moves them, so junk and expiry cannot inflate them, and a payer is counted once per payment (they count payments, not distinct people: a creator paying itself from a second wallet counts).
  - "Not yet paid" counts active mandates with no pull among the latest 200 entries; beyond that the page says "among the latest 200".
  - The home page lists a plan when someone paid for it in the current or the previous period. That reads two counters per plan, walking at most 200 plans per page with a cursor.
- **The home page lists only plans paid for in their current or previous period**, walking at most 200 plans per page with a "more" link. All plans are on `:plans`.
- **The collector reads by payee**: `CollectorPlans(payee)`, then `CollectorScan(plan, key, from)` for each plan. There is no per-key list, so mandates recorded for a payee's key on someone else's plan never reach its collector.
- **Mandate records are slim:**
  - Paid = pulls × price;
  - LastPullAt = next pull − period;
  - PlanID comes through the plan pointer;
  - the session's public key is the payee's current collector key when the address matches.

### What reads return for a cancelled or expired mandate

- `MandateOf(payer, session)` returns the newest mandate for that pair, with Status "cancelled" or "expired". When it is no longer in the active list, the read walks the payer's history.
- `HasMandate` is false and `NextPullAt` is 0. `PaidThrough` keeps the paid time through the payer's credit until it runs out (unless the credit could not be kept at the 16-credit bound; the payer page then says so).
- `SupportersOf` and the supporter page leave it out.
- Pull and Cancel look only at the active list:
  - after a cancel they fail with "no active mandate for this session (never recorded, cancelled or replaced)";
  - an expired mandate still says "mandate: expired" until its payer subscribes again.

Every Pull after a mandate's first updates only fields that already exist (mandate, plan, payee totals, the plan's payment counters and two package counters), so it adds no storage beyond a varint growing by a byte. The first pull flips its list entry in place and sets fields that were zero (amino omits zero values): at most 78 bytes measured (68 B on a local chain, 78 B in the second audit's filetests), paid from the fee allowance ("Pull's budget").

## Pull's budget (M1.4)

The chain counts a Pull's storage deposit against the session's spend limit after the call, but checks only fee + coins before it. So a Pull whose deposit does not fit is refused after the fee is charged (with `-simulate skip`), or refused in simulation (gnokey's default) and never sent.

**Before (abd2ecf, audit HIGH-1, reproduced):** 66 payers with the pages' sessions (spend limit price + 0.1 GNOT, period = the plan's, exact scope), first payments pulled in order by the collector key (`scripts/measure-first-payments.sh 66`). Positions 1–31 succeeded, each adding 115–116 B to the plan's paid-once list (450 B for the first); **every position from 32 on failed** with "storage deposit processing encountered one or more errors": the 32nd moved the full list into a new chunk object, whose deposit no longer fitted in what the allowance left after the fee. With gnokey's simulation nothing was charged and the supporter could never pay; with `-simulate skip` each try cost the payer the 20,000 ugnot fee.

**After (M1.4):** a Pull creates no object. It writes the mandate, the plan's counters, the payee's totals, two package counters and, on a first payment, one status character in place. Measured with real session-signed pulls:

| Case | Gas | Storage |
|---|---|---|
| First payments 1–100 of one plan, in order, pages' sessions | 10.3–11.0M | all succeeded; at most 38 B, usually 12 B |
| Flow: a mandate's first pull, a later pull | 9.5M, 8.8M | 18 B, 0 B |
| First pull of the oldest entry, list of 34 (the plan's first payment ever) | 10.8M | 68 B |
| … list of 1,058 | 11.6M | 46 B |
| … list of 10,274 | 12.3M | 42 B |
| … list of 32,802 | 12.7M | 46 B |
| Flow 13: 32 supporters, the 32nd included, through the collector | | all succeeded |

The worst first payment is the plan's very first (its counters go from zero): 68 B on a local chain, whether it is the oldest of 33 entries or the 32nd entry pulled first (`measure-first-payments.sh 33`, `FIRST_POS=32 … 32`, M1.5), and 78 B in the second audit's filetests at the same positions. The first pull of a mandate that started with carried-over time (M1.5): see flow 14 below. The collector and the scripts use a bound of 100 B, asserted by `measure-first-payments.sh` and by flow 14; 78 B leaves 22 B of margin.

**Worst case per period:** fee 20,000 ugnot (the collector's 20M gas wanted at today's Onyx price of 1 ugnot per 1,000 gas) + the 100 B bound × 100 ugnot (Onyx's storage price, read-only query) = **30,000 ugnot**.

**Fee allowance: kept at 0.1 GNOT (decided in M1.4).** The worst pull measured locally costs 30,000 ugnot, so 0.05 GNOT would have fitted today with a margin for a gas price twice today's. It was kept at 0.1 because a pull that cannot be paid is the product failing, while the allowance only bounds a loss nobody profits from (fees go to the network, threat 5): Pull has not been measured on Onyx yet, whose deeper store charges more gas per object than the 10–13M measured here (if a Pull needs 30M gas wanted, the worst case is already 40,000 ugnot); the chain raises the gas price when blocks fill; and the constant cannot be changed after deployment. At 0.1 GNOT the margin is 70,000 ugnot: a gas price 4.5 times today's at 20M gas wanted, or about 3 times today's at 30M.

## Lists at their boundaries and at size (M1.4)

`scripts/measure-plan-sizes.sh SIZE` loads SIZE mandates (one payer each) as genesis transactions, then signs live: 36 Subscribes walking the list across a chunk boundary (every 32) and a super-chunk boundary (every 1,024), the first pull of the oldest entry, every free read inside a transaction of a probe realm (local only, not under the realm's path) with 3,000,000,000 gas wanted, the node's cap for a free query, and an Offer.

| | 1,022 → 1,058 | 10,238 → 10,274 (1,000 plans of one payee) | 32,766 → 32,802 |
|---|---|---|---|
| Subscribe, usual | 12.6–14.8M gas, 5,326–5,340 B | 16.0–18.3M, 5,346–5,367 B | 15.2–17.4M, 5,387–5,399 B |
| Subscribe that fills the tail (creates a chunk) | 19.7M, 6,178 B | 22.5M, 6,198 B | 22.4M, 6,265 B |
| Subscribe that also starts a super-chunk | 14.8M, 7,382 B | 18.6M, 7,435 B | 22.3M, 7,476 B |
| Subscribe after a new chunk (new tail) | 14.0M, 5,650 B | 16.4M, 5,679 B | 15.6M, 5,708 B |
| Pull, first payment of the oldest entry | 11.6M, 46 B | 12.3M, 42 B | 12.7M, 46 B |
| Offer | 8.6M | 13.9M (the payee's 1,001st plan) | 8.6M |
| Subscribe by a payer holding 15 active mandates, creating a chunk (M1.5) | | | **31.5M**, 3,583 B |
| … creating a chunk and a super-chunk (M1.5) | | | 30.2M, 4,795 B |

No step grows with the list's length; what grows is the stores' depth (more payers, more keys), with the log of their size. A payer's own record adds up to about 9M more for a payer at the 16-mandate cap (it is rewritten with up to 16 pointers to mandates, about 0.37M gas each, and its credits), measured in M1.5: that sets the pages' 60M.

Free reads, gas inside one transaction (the probe's own overhead, 1.7M, included):

| Read | 1,058 | 10,274 (1,000 plans) | 32,802 |
|---|---|---|---|
| Home | 9.0M | 112M (walks 200 plans) | 9.0M |
| `:plans` | 8.4M | 30.9M | 8.4M |
| Plan page | 404M | 504M | **557M** |
| Payee page | 11.2M | 38.5M | 11.2M |
| `Plans(1)` | 5.3M | 17.5M | 5.3M |
| `PlansOf(payee, 1)` | 6.9M | 26.0M | 6.9M |
| `SupportersOf(plan, 1)` | 39.9M | 51.6M | 54.3M |
| `CollectorScan(plan, key, 0)` | 269M | 370M | **411M** |

The node's cap for a free query is 3,000,000,000 gas. The heaviest read measured, the plan page at 32,802 supporters, uses 19% of it. Its worst case is a page where both bounded walks resolve their maximum, 200 lookups each (here only the unpaid count did): about 1.1B at 32,800 payers by the measured 2.7M per lookup, 37% of the cap. Each doubling of the number of payers adds one level to the payer tree, about 7% per lookup.

## Events (M1.7)

Every state change emits an event, with enough to rebuild the realm's state without copying its rules:

| Event | Attributes | When |
|---|---|---|
| `PlanOffered` | plan, payee, title, amount, period | Offer |
| `CollectorKeySet` | payee, pubkey (`gpub1…`), address (derived) | SetCollectorKey |
| `Subscribed` | mandate, plan, payer, payee, session, expires, first (first due time), carried (paid time carried over: until when, or 0) | Subscribe |
| `Pulled` | mandate, plan, payer, payee, amount, next | Pull |
| `Cancelled` | mandate, plan, payer, by, kept (paid time kept as a credit: until when, or 0 if none or not kept) | Cancel |
| `MandatePruned` | mandate, plan, payer, kept (until when its paid time was kept, or 0) | an expired mandate dropped at its payer's next Subscribe; for the plan being subscribed to, the kept time goes straight into the new mandate (its `Subscribed.carried`) |

**`MandatePruned.kept` has two meanings.** For a mandate on another plan it is a stored credit (until `CreditDropped` or its time passes). For the plan being subscribed to in that same transaction it is **not** stored: it is carried straight into the new mandate, and the `Subscribed` event that follows carries the same value as `carried`. An indexer should therefore treat `kept` of a `MandatePruned` whose plan equals the plan of the `Subscribed` event in the same transaction as consumed by that mandate, not as a credit.
| `CreditDropped` | payer, plan, until | a kept credit pushed out at the 16-credit bound |

A credit that simply runs out (its time passes) emits nothing: it is time-based, and `PaidThrough` is the read for it. `z_events_filetest` holds the events with no payment; flow 14 to 16 check `kept`, `carried`, `MandatePruned` and `CollectorKeySet` on a real chain.

