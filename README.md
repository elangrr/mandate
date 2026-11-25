# Mandate

Say you write a newsletter about Gno development and you want 1 GNOT a month from each reader who likes it. Your readers don't want to lock money up in advance. They also don't want to sign a transaction every month. Those two wishes usually work against each other: either the money sits in an escrow, or someone has to sign every time.

Mandate gives you subscriptions, as direct debit on native GNOT, for exactly that case. The reader (a *supporter*, in Mandate's words) signs one permission from their own wallet: *at most X GNOT every period, through this realm only, until I cancel or it expires*. You, the *creator*, run a small collector that takes each payment when it is due. The realm checks who, how much and when, and forwards the coins to you in the same transaction. It keeps nothing.

It is built on the session keys that came with Gno.land v1.8.0, and it is live on the Onyx test network. Everything here uses test GNOT only.

![Plan #1 on the live site: price, cap bar, payment counts and plan terms](docs/img/plan-1.png)

**One thing that surprises people: nothing takes a payment by itself.** Each payment is taken when the creator's collector runs. So a creator runs the collector on a schedule (cron), at least once per period of their shortest plan. The site's collector guide, [`#/collector`](https://elangrr.github.io/mandate/#/collector), shows the cron lines.

If you have two minutes: open [the site](https://elangrr.github.io/mandate/), read [the two real runs](#two-real-runs) and [why it needs Gno.land](#why-it-needs-gnoland), then [try it](#try-it). If you want the detail, it is further down: [how it works](#how-it-works), [the honest limits](#the-honest-limits), [what subscribing costs](#what-subscribing-costs), [the command line and the realm API](#using-it-from-the-command-line), and [the tests](#tests).

## Live on Onyx

- **The site:** [elangrr.github.io/mandate](https://elangrr.github.io/mandate/). Browse plans, subscribe and stop with the Adena wallet, publish as a creator.
- **Plan #1 on the site:** [elangrr.github.io/mandate/#/plan/1](https://elangrr.github.io/mandate/#/plan/1).
- **Plan #3 on the site:** [elangrr.github.io/mandate/#/plan/3](https://elangrr.github.io/mandate/#/plan/3), the demo plan with a repeat payment.
- **The realm on gnoweb:** [`gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate`](https://onyx.testnets.gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate)
- **Every command, on the realm's help page:** [`:help`](https://onyx.testnets.gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate:help)

The realm was deployed to the Onyx test network (`onyx-1`) on 2026-11-24, in block 1366932. The network's package approver then enabled it. Since 2026-11-24 it is live: anyone can read it and use it. Test GNOT only.

### Two real runs

**Plan #1, "Test Plan": the first payment.** 0.5 GNOT every 30 days. The collector took its first payment on 2026-11-24 at 21:03 UTC, in block 1385511. Its supporter has since stopped the mandate, so the plan page lists no supporter now.

**Plan #3, "Gno dev notes newsletter (demo: every 3 minutes)": a repeat payment.** 0.5 GNOT every 3 minutes, published on 2026-11-25 by `g1sfwa7vgdk4q6y6kr7yqzpx5dl59dw6z8py0g5v`. The 3-minute period is there only so that a repeat payment can be watched without waiting a month. Real plans go up to 30 days. See it [on the site](https://elangrr.github.io/mandate/#/plan/3) or [on gnoweb](https://onyx.testnets.gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate:plan/3).

This is what happened on plan #3:

1. A supporter, `g19vhs98w8alx760a7a7rpyul0zkjd5f4utg04pa`, subscribed on the site with two approvals in Adena (`Subscribe` in block 1395781).
2. The collector took a payment in block 1395805 and another in block 1395886. Both came from that one permission. The supporter approved nothing for the second one.
3. The supporter then stopped the mandate (`Cancel` in block 1395911), and the permission was removed from their wallet.

The supporter's page on gnoweb, [`…/mandate:payer/g19vhs98w8alx760a7a7rpyul0zkjd5f4utg04pa`](https://onyx.testnets.gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate:payer/g19vhs98w8alx760a7a7rpyul0zkjd5f4utg04pa), shows it as mandate 4: 2 payments, 1 GNOT in total, cancelled. Plan #3 itself has 3 payments, 1.5 GNOT in total. The third came from an earlier mandate of the same supporter.

Realm totals, read on 2026-11-25: 3 plans, 5 payments, 2.5 GNOT paid out. These change as people use it.

## Why it needs Gno.land

Gno v1.8.0 lets a wallet create a *session*. A session is a second key that the wallet authorises, with:

- an expiry;
- a list of the message paths it may sign for;
- a spend limit per period, which counts fees, coins sent and storage deposits.

The details, with sources, are in [`docs/notes.md`](docs/notes.md), "Sessions".

A Mandate permission is such a session. It is given to the creator's collector key, it allows only `vm/exec:<this realm>`, and its spend limit is the price plus a 0.1 GNOT fee allowance in each of the plan's periods. (The glossary calls this limit the *cap*.)

That is what makes direct debit possible. The collector can take each payment from an ordinary GNOT wallet. There is no escrow that locks funds, and the supporter does not sign each payment.

The work is split between the chain and the realm:

- **The chain enforces the cap and the scope.** The collector key can never spend more than the cap in a period, and can sign only calls to this realm (and to anything under its path, which is why nothing is ever deployed there).
- **The realm enforces who, how much and when.** `Pull` accepts only a session scoped to exactly this realm, for a recorded mandate that is active and due, and exactly the plan's price. It then forwards the coins to the creator in the same transaction.

And the supporter keeps the off switch. Revoking the session in the wallet stops every payment at once.

## Try it

First, an honest note about the demo plans. No mandate is active on them right now, and no collector is running on a schedule for them. If you subscribe to plan #1 or plan #3 today, your mandate is recorded, but no payment is taken until that plan's creator runs their collector.

So if you want to see a payment go through end to end, take the creator path below: publish your own plan, subscribe to it from a second wallet, and run the collector yourself.

### As a supporter

You need the [Adena](https://adena.app) browser wallet and test GNOT on `onyx-1`. Test GNOT comes from the Onyx faucet, listed as "Onyx Faucet" (chain `onyx-1`) on Gno.land's [Faucet Hub](https://faucet.gno.land). The networks are described in Gno.land's [network documentation](https://docs.gno.land/resources/gnoland-networks/).

1. Open [plan #1](https://elangrr.github.io/mandate/#/plan/1) and click **Connect wallet to subscribe**.
2. If Adena is on another network, click **Switch Adena to onyx-1**. The site asks Adena to switch, and adds the network first if Adena does not know it.
3. Click **Subscribe for 0.5 GNOT every 30 days**. Adena asks twice:
   - **Give the permission (approval 1 of 2).** This is a permission (the chain calls it a session) for the creator's collector key: at most 0.6 GNOT every 30 days, through Mandate only, for one year. No payment is taken in this step.
   - **Record the terms in Mandate (approval 2 of 2).** This is a call to `Subscribe`, which records the mandate and takes the storage deposit. It opens only once the permission is on chain.
4. The first payment, 0.5 GNOT, is due at once. The creator's collector takes it on its next run (for the demo plans, see the note above). Your mandates, and the button to stop one, are on **My mandates**.

For plan #1, a wallet that has never subscribed here needs about 1.2 GNOT of test GNOT. The breakdown is in [what subscribing costs](#what-subscribing-costs). Plan #3 has the same price, so the same amounts apply. Keep its period in mind, though: if its creator runs a collector on a schedule, it can take 0.5 GNOT every 3 minutes until you stop the mandate.

### As a creator

1. On the machine that will run the collector, make a separate, empty key with gnokey v1.8.0, and copy its public key (`gpub1…`) from the list:

   ```
   gnokey add -home ~/mandate-collector collector
   gnokey list -home ~/mandate-collector
   ```

   Never send coins to this key. An address that has received coins is an account, and the chain refuses to create a permission for it, so nobody new could subscribe.

2. Get test GNOT in your own wallet (from the same faucet). Open [`#/publish`](https://elangrr.github.io/mandate/#/publish) and click **Connect wallet to publish**.
   - Paste the key under **Collector public key**, click **Check this key**, then **Publish collector key**.
   - Under **Publish a plan**, fill in the title, the price per period in GNOT and the period, and click **Publish plan**.

   Each of these is one approval in Adena, and each takes a storage deposit. The page shows the deposit before you sign. The first time, both together come to about 0.9 GNOT, plus network fees.

3. Open [`#/collector`](https://elangrr.github.io/mandate/#/collector) with your wallet connected. It fills in the command, which you run from a clone of this repository:

   ```
   scripts/collect.sh -home ~/mandate-collector -key collector -payee YOUR_ADDRESS -remote https://rpc.onyx.testnets.gno.land:443 -chainid onyx-1 -realm gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate
   ```

   Each payment is taken only when this command runs, so run it at least once per period of your shortest plan. It asks for the key's password once per run. For unattended runs, the guide shows how to keep the password in a file only you can read, and gives the crontab lines for a run every 10 minutes with `-insecure-password-stdin`. If a plan of yours has a shorter period, change the schedule to match.

4. To watch a payment end to end, subscribe to your plan from a second wallet. (Your own plan offers you nothing to sign: the realm refuses it.) Then run the collector: it takes the first payment at once. To see a repeat payment, publish a plan with a short period (the shortest allowed is one minute) and run the collector again after a period has passed. Stop the mandate on **My mandates** when you have seen enough.

## How it works

```
 creator                         supporter                         chain + realm
 ───────                         ─────────                         ─────────────
 Offer("Weekly coffee",
       1 GNOT, 7 days)  ─────────────────────────────────────────▶ plan 1 (never changes)
 SetCollectorKey(gpub K) ────────────────────────────────────────▶ key K published

                                 create a session for key K:
                                   only vm/exec:<this realm>,
                                   at most 1.1 GNOT per 7 days,   ─▶ session (supporter, K)
                                   expires in a year
                                 Subscribe(plan 1, addr(K), expiry) ▶ mandate recorded

 every 7 days, the collector signs with K on the supporter's behalf:
 Pull() sending 1 GNOT ──────────────────────────────────────────▶ chain: live session? allowed? within the cap?
                                                                   realm: right scope, active, due, exact amount
                                                   creator ◀─ 1 GNOT ─ realm (keeps nothing)
```

What you subscribe to today is a **supporter page**. A creator publishes a plan such as "1 GNOT every week". The plan's page lists its supporters, counted from their first payment on.

### The four parts

**The realm** (`r/mandate`). It holds the plans and the mandates, applies the rules for `Pull`, renders the pages and answers free reads. There is no admin, no pause, no upgrade and no sweep. It never holds funds between transactions.

**The chain's sessions** (Gno v1.8.0). The supporter's wallet creates a session for the creator's collector key, limited to this realm, with a spend limit per period and an expiry. The chain enforces the cap; the realm enforces the terms.

**The collector** (`scripts/collect.sh`). The creator runs it, and it holds the collector key. Nothing takes a payment by itself: each payment is taken when the collector runs. So the creator runs it on a schedule (cron), at least once per period of their shortest plan, and [`#/collector`](https://elangrr.github.io/mandate/#/collector) shows the cron lines. On each run it:

- finds what is due through free queries, walking the creator's own plans;
- reads each due mandate's session on chain, and skips, with the reason, one that is missing, revoked, too wide, too small or used up for the period;
- takes the rest;
- does not try a payment again before the plan's next period if the chain refused it after it was sent (the supporter has then paid its fee). One refused before it reached a block cost nothing and is tried again on the next run.

Its work per run is bounded and resumable. A revoked session is not an error.

**The site** (`web/app`, live at [elangrr.github.io/mandate](https://elangrr.github.io/mandate/)). A static site that reads the realm through the network's public RPC and signs through the Adena wallet. You can browse plans, subscribe and stop, publish a collector key and plans, and follow the collector guide. It never asks for or handles a private key. See [`web/app/README.md`](web/app/README.md).

## The honest limits

These are the trade-offs I know about. Several come from the chain's rules for sessions. The reasoning and the measurements are in [`docs/design.md`](docs/design.md).

### For supporters

- **The cap includes fees.** The session's spend limit is the price plus a fee allowance of 0.1 GNOT per period, which pays the fees and the first payment's storage deposit. A dishonest creator could burn that allowance as network fees. Those fees go to the network, not to them. They can never take more than the limit, or take payments more often.
- **At most 16 active mandates per wallet.** The chain allows 16 sessions per account, and the realm enforces the same limit.
- **One plan of each creator at a time.** All of a creator's plans are collected by one key, and the chain allows one session per key per wallet.
- **You are not charged twice for a period.** Say you cancel (or the creator does), renew, or come back with another key while a period is still paid. The new mandate's first payment then waits until that period ends.
  - The exception: a wallet keeps paid time for at most 16 plans it has left. Beyond that, a creator's cancel keeps nothing for its own plan, and the supporter's own cancel lets the soonest-ending period go.
- **You can revoke at any time.** Removing the permission in your wallet (revoking the session on chain) stops every payment at once. The realm cannot see a revoke, though, so it still shows the mandate as active until it is cancelled or expires.
- **Subscribing costs a storage deposit**, paid by the supporter, plus normal fees. It is about 0.54 GNOT the first time a wallet subscribes (the wallet's own record in the realm plus the mandate), and about 0.18 GNOT for each later one.
  - Each wallet's records are its own. Nothing another wallet does can make your payments or cancels dearer, except a slightly deeper tree (measured in [`docs/design.md`](docs/design.md)).

### For creators

- **It is direct debit, not escrow.** Nothing is locked up front. A supporter can revoke, cancel or empty their account at any time, and a creator is only paid when a payment succeeds. Payments are taken at the start of each period, so a creator is exposed for one period at most.
- **You need a collector that is always on**, holding the collector key. It takes payments only when it runs, so it has to run on a schedule.
- **Periods go from one minute to 30 days.** The chain refuses a session whose spend period is longer than 30 days, so there are no yearly plans. A monthly plan with a one-year mandate is the longest commitment.
- **Never send coins to a collector key.** An address that has received coins is an account, and the chain refuses to create a session for it, so nobody new could subscribe.
  - Anyone can do this to a published key with a 1 ugnot send. The creator then publishes a new key (the plan page says so), and existing supporters are unaffected.
- **Anyone can record a mandate without paying.** That is why supporter pages list and count supporters only from their first payment on. Mandates that never paid are shown as a number, never as supporters.

### For anyone building on it

- **To check whether a supporter has paid, use `PaidThrough(payer, plan)`** (or `IsPaidUp`). It moves only when a payment succeeds, so after a revoke it simply runs out within one period.
  - `HasMandate` only says a mandate is recorded. Recording one costs nothing but a deposit and says nothing about payment.
- **Nothing is ever deployed under the realm's path.** A session for `vm/exec:<realm>` also allows every realm under that path, because the chain matches by prefix. The realm's deployer must never deploy anything at `gno.land/r/<namespace>/mandate/...`, and this repository never will.

## What subscribing costs

This is how much test GNOT plan #1 needs, for a wallet that has never subscribed here, at Onyx's gas price on 2026-11-25 (1 ugnot per 1,000 gas, `auth/gasprice`):

| | ugnot | From |
|---|---:|---|
| Storage deposit of a wallet's first mandate | 540,000 | `FIRST_DEPOSIT_UGNOT`, `web/app/src/lib/flows.ts` |
| Network fee, approval 1 (5,000,000 gas at the minimum price, plus half) | 7,500 | `GAS.session` and `gasFor`, `web/app/src/lib/tx.ts` |
| Network fee, approval 2 (the site's estimate for 25,000,000 gas; Adena shows the exact fee) | 25,000 | `flows.ts` |
| The first payment's cap: the price plus the fee allowance | 600,000 | plan #1's 500,000 + `feeAllowanceUgnot` 100,000, `web/app/src/config.ts` |
| **Total** | **1,172,500** | about 1.2 GNOT |

The site refuses to start below 572,500 ugnot (the deposit and the fees). Below 1,172,500 it warns that the first payment would fail. A wallet that has subscribed here before pays a deposit of about 0.18 GNOT instead.

## Using it from the command line

The realm's help page, [`:help`](https://onyx.testnets.gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate:help), has every command with the flags for `onyx-1`. The ones below are copied from it. Replace the words in capitals.

`gnokey`'s default remote is a node on your own machine (`127.0.0.1:26657`), so always give `-remote`.

```
# creator, own key: a plan (title, price in ugnot, period in seconds), then the collector key
gnokey maketx call -pkgpath gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate -func Offer -args "TITLE" -args 1000000 -args 604800 -gas-fee 100000ugnot -gas-wanted 60000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY
gnokey maketx call -pkgpath gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate -func SetCollectorKey -args GPUB_OF_COLLECTOR_KEY -gas-fee 100000ugnot -gas-wanted 60000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY

# supporter, own key: each plan's gnoweb page shows these two filled in
gnokey maketx session create -pubkey COLLECTOR_GPUB -allow-paths vm/exec:gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate -spend-limit PRICE_PLUS_100000ugnot -spend-period PERIOD_SECONDS -expires-at UNIX_TIME -gas-fee 100000ugnot -gas-wanted 60000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY
gnokey maketx call -pkgpath gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate -func Subscribe -args PLAN_ID -args COLLECTOR_ADDRESS -args UNIX_TIME -gas-fee 100000ugnot -gas-wanted 60000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY

# creator's collector, from a clone of this repository
scripts/collect.sh -home KEYBASE_DIR -key COLLECTOR_KEY -payee YOUR_ADDRESS -remote https://rpc.onyx.testnets.gno.land:443 -chainid onyx-1 -realm gno.land/r/g1llc3lq3zmjtjdk29dk52munrzxt5ne746cl7r8/mandate [-state collector.state] [-dry-run]
```

About the collector:

- It needs gnokey v1.8.0, python3 and flock (its header says so). Before it starts, it checks that `gnokey`, `flock` (util-linux) and `timeout` (coreutils) are on the PATH.
- Without `-state`, it keeps its state in `${XDG_STATE_HOME:-~/.local/state}/mandate-collector`.
- `scripts/collect.sh -help` prints its usage, and the comments at the top of the script explain every option.

Stopping a mandate, the `Pull` command itself and the free check for services are on `:help`.

### Realm API

| Function | Who | What |
|---|---|---|
| `Offer(cur, title, amountUgnot, periodSeconds) uint64` | creator, own key | Publishes a plan. |
| `SetCollectorKey(cur, gpub)` | creator, own key | Publishes the collector's public key; the realm derives its address. |
| `Subscribe(cur, planID, sessionAddr, expiresAtUnix) uint64` | supporter, own key | Records the terms for one session. The first payment is due at once. |
| `Pull(cur)` | collector, signed with the session key (`-master <supporter>`) | Exactly the price, once per period, forwarded to the creator. |
| `Cancel(cur, payer, sessionAddr)` | supporter or creator, own key | Ends a mandate in the realm. |
| `PaidThrough(payer, planID) int64`, `IsPaidUp(payer, planID) bool` | anyone, free | Until when the supporter's payments cover them (latest payment + period), kept after a cancel or an expiry; 0 if they never paid. Deliver while now < PaidThrough, with a grace equal to how often the creator's collector runs: it turns false at the due time until the next payment is taken. |
| `GetPlan` (with the number of payments in the current and the previous period), `MandateOf`, `HasMandate` (recorded and not expired: not proof of payment), `NextPullAt`, `GetPayee`, `Totals` | anyone, free | Plain values (copies). |
| `Plans` (newest first), `PlansOf` (oldest first), `MandatesOf` (newest first), `SupportersOf` (active mandates, oldest first) | anyone, free | Paged lists, at most 20 rows per page. Every read is bounded per call; the worst cases measured at 32,000 supporters are in [`docs/design.md`](docs/design.md), far below the node's query gas cap. |
| `CollectorPlans(payee, page)`, `CollectorScan(planID, sessionAddr, from)` | anyone, free | Plain text for the collector: a payee's plans, and a plan's active mandates for one key, 200 list entries per call with a cursor. |
| `PayingSupporters(planID, from) ([]MandateInfo, int)` | anyone, free | The plan's supporters as its page lists them: active mandates that have paid at least once, newest first, at most 20 per call, with the index to continue from. Pass -1 for the newest and stop when the cursor comes back as -1 (passing -1 again starts over). |
| `PlanCounts(planID) (paidThisPeriod, paidLastPeriod, unpaid int, unpaidExact bool)` | anyone, free | The numbers the plan page shows: payments in the plan's current counting window and in the one before (as in `GetPlan`), and active mandates that never paid among the latest 200 (`unpaidExact` is false when there were more). |
| `Render` | gnoweb | Home, `plans` (all plans), `plan/<id>` (supporter page), `payer/<addr>`, `payee/<addr>`, `help`. |

Every crossing function except Pull refuses session keys and coins, and must be called directly by a user.

## Tests

Everything runs on your own machine. No test talks to a public network, except the read-only checks noted in [`docs/notes.md`](docs/notes.md) (and `npm ci`, which downloads the site's packages).

```
export GNOHOME=<a folder for gno's caches>   # not your key folder
gno test -v ./...        # unit tests and filetests (pages, events)
gno lint ./...
gno fmt -diff ./...
scripts/local-flow.sh    # real signed transactions on a local gnodev chain (about 5 minutes)

cd web/app && npm ci     # the site
npm test                 # unit tests
npm run typecheck
npm run e2e              # end to end, on a local gnodev chain
```

**Unit tests** (`r/mandate/*_test.gno`). They cover:

- terms and their limits;
- time and period maths at the exact boundaries;
- every refusal, each checked to change nothing;
- paging, page content and title injection;
- Pull's rules, through `checkPull`. The session itself cannot be signed under `gno test`, so this is as far as unit tests can go; the local flow covers the rest.

Filetests hold golden copies of every page and of the events.

**The local flow** (`scripts/local-flow.sh`). It starts gnodev with chain id `dev` and creates throwaway keys in a temporary keybase (no mnemonic is printed or kept). Then it proves, with assertions:

- subscribe and pull: exact balances, a realm balance of zero, the event;
- a second pull in the same period refused, and wrong amounts refused;
- the session refused for a bank send, for another realm, and for Offer/Subscribe/Cancel/SetCollectorKey;
- a too-wide session refused by Pull;
- the collector script;
- chain-side and realm-side expiry;
- a hostile creator's fee burn capped at the spend limit;
- revoke, and the sub-path case;
- the creator-pays-fees two-signer variant, and cancel;
- 32 supporters with exactly the sessions the pages give (the 32nd first payment included), collected by the collector script. Next to them are sessions it must skip (too small a limit, too wide, revoked) and a pull the chain refuses (not retried in the same period, exit status 0).

It refuses any chain id but `dev`, passes `-remote` and `-home` to every gnokey call, and deletes the keys and stops the node on exit.

**The site** (`web/app`).

- `npm test` runs the unit tests: the decoders against recorded chain responses, the transaction builders, the subscribe and stop decisions, and what each kind of wallet reply means.
- `npm run e2e` starts a local gnodev chain (chain id `dev`, 127.0.0.1 only) with throwaway keys, builds the site for it and drives it in headless Chromium. A stand-in for Adena answers in Adena's reply shapes.
- It needs gno v1.8.0's `gnodev` and `gnokey` on the PATH and Playwright's Chromium. Details are in [`web/app/README.md`](web/app/README.md).

**An early spike**, from before the site: `web/adena-test.html` checked in a real browser that a page can ask Adena to create and revoke a session for someone else's key. `node web/adena-test.test.mjs` still tests its request builders against Adena's source.

For the reasoning behind all this, [`docs/design.md`](docs/design.md) has the threat model (threat, who is hurt, what stops it, how it is tested), the limits and why, and measured gas and storage. [`docs/notes.md`](docs/notes.md) lists the Gno facts this relies on, with sources.

## Deploying and branches

`scripts/set-namespace.sh <g1 address or registered name>` replaces the placeholder in `r/` and runs the tests. Deployment is a separate, manual step by the owner of the namespace. Never deploy anything under the realm's path.

The repository has three branches:

- `master`: development, with the site (`web/app`). Its realm keeps the placeholder namespace `mandate_dev`, which the tests and the local chain flow use.
- [`onyx`](https://github.com/elangrr/mandate/tree/onyx): the deployment snapshot, branched before `web/app/` existed. Its `r/mandate/` is the same realm code as `master`'s with the namespace set by `scripts/set-namespace.sh`, byte for byte what is on chain. It also has:
  - the deploy guide, [`docs/deploy.md`](https://github.com/elangrr/mandate/blob/onyx/docs/deploy.md);
  - the checksum of every uploaded file, [`docs/deploy-checksums.txt`](https://github.com/elangrr/mandate/blob/onyx/docs/deploy-checksums.txt);
  - [`scripts/verify-deploy.sh`](https://github.com/elangrr/mandate/blob/onyx/scripts/verify-deploy.sh), which compares the realm on chain with the branch's `r/mandate/`, file by file, using only free queries.
- `gh-pages`: the built site, served at [elangrr.github.io/mandate](https://elangrr.github.io/mandate/).

## Licence

MIT License; see `LICENSE` and `NOTICE`. The copy published on the Gno.land network is also available under the GNO Network General Public License, version 6, as the network's terms provide. Imported Gno packages keep their own licence.

Built on [gno.land](https://gno.land).
