// PKGPATH: gno.land/r/mandate_dev/mandate/filetests/z_pages_filetest

// Golden copies of every page, built through the exported API only.
package z_pages_filetest

import (
	"testing"
	"time"

	"gno.land/r/mandate_dev/mandate"
)

const (
	payee  = address("g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5") // test1
	payer  = address("g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj") // test2
	payer2 = address("g1rzuwh5frve732k4futyw45y78rzuty4626zy6h") // test3
	gpub   = "gpub1pgfj7ard9eg82cjtv4u4xetrwqer2dntxyfzxz3pqfp0696ldln2nm7kd33zfpgypg6u0e7upl03hyeexa6mccn4ce8mkswg65c"
	sess   = address("g1psdsf789f4xw3qrpjue54g2h28syd09yfkrxdh")
	sess2  = address("g1valkxsym77y3qlj5fq9h4p64y73l3masvuxav0")
)

func main(cur realm) {
	testing.SetRealm(testing.NewUserRealm(payee))
	id := mandate.Offer(cross(cur), "Weekly *coffee* for g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5 $5", 1_000_000, 604800)
	testing.SetRealm(testing.NewUserRealm(payee))
	mandate.Offer(cross(cur), "Demo | one minute", 250_000, 60)
	testing.SetRealm(testing.NewUserRealm(payee))
	mandate.SetCollectorKey(cross(cur), gpub)
	testing.SetRealm(testing.NewUserRealm(payer))
	mandate.Subscribe(cross(cur), id, sess, time.Now().Unix()+30*86400)
	testing.SetRealm(testing.NewUserRealm(payer2))
	mandate.Subscribe(cross(cur), id, sess2, time.Now().Unix()+30*86400)
	testing.SetRealm(testing.NewUserRealm(payer2))
	mandate.Cancel(cross(cur), payer2, sess2)

	for _, p := range []string{"", "plan/1", "plan/2", "payer/" + payer.String(), "payer/" + payer2.String(), "payee/" + payee.String(), "help", "nope"} {
		println("==== Render(\"" + p + "\")")
		println(mandate.Render(p))
	}
}

// Output:
// ==== Render("")
// # Mandate
//
// **Subscriptions and direct debit on native GNOT.** A creator publishes a plan, such as 1 GNOT every week. A supporter signs one permission from their own wallet: *at most this much, every period, through this realm only, until I cancel or it expires*. The creator's collector then pulls each payment at the start of the period, and this realm checks who, how much and when before it forwards the coins.
//
// ## The honest limits
//
// - **It is direct debit, not escrow.** Nothing is locked up front. A supporter can stop at any time, and a creator is only paid when a pull succeeds.
// - **A hard cap the supporter sets.** The chain never lets a pull take more than the session's spend limit per period: the plan's amount plus a fee allowance of 0.05 GNOT. A dishonest creator could at worst burn that allowance as network fees; they can never take more, or pull more often.
// - **At most 16 mandates per wallet**, because the chain allows 16 session keys per account.
// - **Revoke any time.** Revoking the session on chain stops every pull at once. The realm cannot see a revoke, so a mandate still shows here as active until it is cancelled or expires: [how to stop a mandate](/r/mandate_dev/mandate:help).
// - **One realm, nothing under it.** A session for this realm also covers any realm deployed under its path, so nothing will ever be deployed there.
// - No admin, no pause, no upgrade. The realm never holds funds: each payment goes straight to the creator in the same transaction.
//
// [How to use it, with every command](/r/mandate_dev/mandate:help)
//
// ## Numbers
//
// | Plans | Mandates | Payments | Paid out |
// |---|---|---|---|
// | 2 | 2 | 0 | 0 GNOT |
//
// ## Supporter pages
//
// No plan has a paying supporter yet.
//
// Only plans that someone has paid for are listed here. [All plans, newest first](/r/mandate_dev/mandate:plans)
//
// ---
//
// Built on [gno.land](https://gno.land) · source: not published yet
//
// ==== Render("plan/1")
// # Weekly \*coffee\* for&#32;g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5 \$5
//
// **1 GNOT every week** to [g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5](/r/mandate_dev/mandate:payee/g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5)
//
// Plan 1 · published 2009-02-13 23:31 UTC · 0 paying supporters · 0 payments, 0 GNOT in total · last payment: never
//
// Plans never change. New terms are published as a new plan.
//
// ## Supporters
//
// No paying supporters.
//
// Supporters are listed and counted from their first payment on, newest first. Cancelled and expired mandates are not listed; a supporter who revoked the session on chain stays listed until the mandate is cancelled or expires. 1 mandate has not paid yet (not listed).
//
// ## Support this plan
//
// You need [gnokey](https://docs.gno.land) and a key with some GNOT on onyx-1. Replace `YOUR_KEY` with your key's name. These two commands give the creator's collector key (`g1psdsf789f4xw3qrpjue54g2h28syd09yfkrxdh`) the right to take **at most 1.05 GNOT every week** (the price plus a fee allowance), through this realm only, for one year.
//
// 1. Create the session (your own key; it cannot be done with a session):
//
// ```
// gnokey maketx session create -pubkey gpub1pgfj7ard9eg82cjtv4u4xetrwqer2dntxyfzxz3pqfp0696ldln2nm7kd33zfpgypg6u0e7upl03hyeexa6mccn4ce8mkswg65c -allow-paths vm/exec:gno.land/r/mandate_dev/mandate -spend-limit 1050000ugnot -spend-period 604800 -expires-at 1266103890 -gas-fee 100000ugnot -gas-wanted 30000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY
// ```
//
// 2. Record the terms here:
//
// ```
// gnokey maketx call -pkgpath gno.land/r/mandate_dev/mandate -func Subscribe -args 1 -args g1psdsf789f4xw3qrpjue54g2h28syd09yfkrxdh -args 1266103890 -gas-fee 100000ugnot -gas-wanted 30000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY
// ```
//
// The first payment is collected right after, then one every week. Your page at `/r/mandate_dev/mandate:payer/<your address>` shows how to stop.
//
// ---
//
// Built on [gno.land](https://gno.land) · source: not published yet
//
// ==== Render("plan/2")
// # Demo | one minute
//
// **0.25 GNOT every minute** to [g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5](/r/mandate_dev/mandate:payee/g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5) (a test plan: the period is under a day)
//
// Plan 2 · published 2009-02-13 23:31 UTC · 0 paying supporters · 0 payments, 0 GNOT in total · last payment: never
//
// Plans never change. New terms are published as a new plan.
//
// ## Supporters
//
// No paying supporters.
//
// Supporters are listed and counted from their first payment on, newest first. Cancelled and expired mandates are not listed; a supporter who revoked the session on chain stays listed until the mandate is cancelled or expires. 0 mandates have not paid yet (not listed).
//
// ## Support this plan
//
// You need [gnokey](https://docs.gno.land) and a key with some GNOT on onyx-1. Replace `YOUR_KEY` with your key's name. These two commands give the creator's collector key (`g1psdsf789f4xw3qrpjue54g2h28syd09yfkrxdh`) the right to take **at most 0.3 GNOT every minute** (the price plus a fee allowance), through this realm only, for one year.
//
// 1. Create the session (your own key; it cannot be done with a session):
//
// ```
// gnokey maketx session create -pubkey gpub1pgfj7ard9eg82cjtv4u4xetrwqer2dntxyfzxz3pqfp0696ldln2nm7kd33zfpgypg6u0e7upl03hyeexa6mccn4ce8mkswg65c -allow-paths vm/exec:gno.land/r/mandate_dev/mandate -spend-limit 300000ugnot -spend-period 60 -expires-at 1266103890 -gas-fee 100000ugnot -gas-wanted 30000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY
// ```
//
// 2. Record the terms here:
//
// ```
// gnokey maketx call -pkgpath gno.land/r/mandate_dev/mandate -func Subscribe -args 2 -args g1psdsf789f4xw3qrpjue54g2h28syd09yfkrxdh -args 1266103890 -gas-fee 100000ugnot -gas-wanted 30000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY
// ```
//
// The first payment is collected right after, then one every minute. Your page at `/r/mandate_dev/mandate:payer/<your address>` shows how to stop.
//
// ---
//
// Built on [gno.land](https://gno.land) · source: not published yet
//
// ==== Render("payer/g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj")
// # Mandates of g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj
//
// Each mandate lets one creator's collector key pull a fixed amount once per period. To stop one completely, run both commands shown under it: **revoke** removes the session on chain (no pull can be signed any more) and **cancel** ends the mandate here. Revoke alone already stops every payment.
//
// ## Mandate 1: [Weekly \*coffee\* for&#32;g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5 \$5](/r/mandate_dev/mandate:plan/1)
//
// - Status here: **active** (if you revoked the session on chain, no payment can be taken)
// - Price: 1 GNOT every week to [g1jg8mtu…sqf5](/r/mandate_dev/mandate:payee/g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5)
// - Session key: `g1psdsf789f4xw3qrpjue54g2h28syd09yfkrxdh`
// - Payments: 0, 0 GNOT in total, last: never
// - Next payment allowed from: 2009-02-13 23:31 UTC · ends: 2009-03-15 23:31 UTC
//
// Revoke the session (your own key):
//
// ```
// gnokey maketx session revoke -pubkey gpub1pgfj7ard9eg82cjtv4u4xetrwqer2dntxyfzxz3pqfp0696ldln2nm7kd33zfpgypg6u0e7upl03hyeexa6mccn4ce8mkswg65c -gas-fee 100000ugnot -gas-wanted 30000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY
// ```
//
// Cancel the mandate (your own key):
//
// ```
// gnokey maketx call -pkgpath gno.land/r/mandate_dev/mandate -func Cancel -args g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj -args g1psdsf789f4xw3qrpjue54g2h28syd09yfkrxdh -gas-fee 100000ugnot -gas-wanted 30000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY
// ```
//
//
// ---
//
// Built on [gno.land](https://gno.land) · source: not published yet
//
// ==== Render("payer/g1rzuwh5frve732k4futyw45y78rzuty4626zy6h")
// # Mandates of g1rzuwh5frve732k4futyw45y78rzuty4626zy6h
//
// Each mandate lets one creator's collector key pull a fixed amount once per period. To stop one completely, run both commands shown under it: **revoke** removes the session on chain (no pull can be signed any more) and **cancel** ends the mandate here. Revoke alone already stops every payment.
//
// ## Mandate 2: [Weekly \*coffee\* for&#32;g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5 \$5](/r/mandate_dev/mandate:plan/1)
//
// - Status here: **cancelled**
// - Price: 1 GNOT every week to [g1jg8mtu…sqf5](/r/mandate_dev/mandate:payee/g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5)
// - Session key: `g1valkxsym77y3qlj5fq9h4p64y73l3masvuxav0`
// - Payments: 0, 0 GNOT in total, last: never
//
//
// ---
//
// Built on [gno.land](https://gno.land) · source: not published yet
//
// ==== Render("payee/g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5")
// # Creator g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5
//
// | Plans | Payments | Received | Last payment |
// |---|---|---|---|
// | 2 | 0 | 0 GNOT | never |
//
// Collector key: `g1psdsf789f4xw3qrpjue54g2h28syd09yfkrxdh` (`gpub1pgfj7ard9eg82cjtv4u4xetrwqer2dntxyfzxz3pqfp0696ldln2nm7kd33zfpgypg6u0e7upl03hyeexa6mccn4ce8mkswg65c`)
//
// ## Plans
//
// | Plan | Price | Supporters | Payments | Last payment |
// |---|---|---|---|---|
// | [Weekly \*coffee\* for&#32;g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5 \$5](/r/mandate_dev/mandate:plan/1) | 1 GNOT every week | 0 | 0 | never |
// | [Demo \| one minute](/r/mandate_dev/mandate:plan/2) | 0.25 GNOT every minute | 0 | 0 | never |
//
// ---
//
// Built on [gno.land](https://gno.land) · source: not published yet
//
// ==== Render("help")
// # How to use Mandate
//
// Every command is for the **onyx-1** test network and uses test GNOT. Replace the words in capitals. Amounts are in ugnot (1 GNOT = 1,000,000 ugnot); periods and times are in seconds and unix seconds.
//
// ## For creators
//
// 1. Publish a plan with your own key: a title (one line, at most 80 characters), the amount (at least 0.1 GNOT) and the period (60 seconds to 366 days). Plans cannot be changed.
//
// ```
// gnokey maketx call -pkgpath gno.land/r/mandate_dev/mandate -func Offer -args "TITLE" -args 1000000 -args 604800 -gas-fee 100000ugnot -gas-wanted 30000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY
// ```
//
// 2. Make a separate key for collecting (`gnokey add COLLECTOR_KEY`) and publish its public key (the `gpub1...` value `gnokey list` shows), signed with your own key:
//
// ```
// gnokey maketx call -pkgpath gno.land/r/mandate_dev/mandate -func SetCollectorKey -args GPUB_OF_COLLECTOR_KEY -gas-fee 100000ugnot -gas-wanted 30000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY
// ```
//
// 3. Collect each payment when it is due, signed with the collector key on behalf of the supporter. Only the exact price is accepted, at most once per period. The fee counts against the supporter's fee allowance, so keep it small:
//
// ```
// gnokey maketx call -pkgpath gno.land/r/mandate_dev/mandate -func Pull -send AMOUNTugnot -master SUPPORTER_ADDRESS -gas-fee 20000ugnot -gas-wanted 20000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 COLLECTOR_KEY
// ```
//
// The repository has a collector script that finds what is due through free queries and pulls it.
//
// ## For supporters
//
// Open a plan's page: it shows the two exact commands, with the creator's collector key, the spend limit (price plus 0.05 GNOT for fees) and the period filled in. The general form:
//
// ```
// gnokey maketx session create -pubkey COLLECTOR_GPUB -allow-paths vm/exec:gno.land/r/mandate_dev/mandate -spend-limit PRICE_PLUS_50000ugnot -spend-period PERIOD_SECONDS -expires-at UNIX_TIME -gas-fee 100000ugnot -gas-wanted 30000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY
// gnokey maketx call -pkgpath gno.land/r/mandate_dev/mandate -func Subscribe -args PLAN_ID -args COLLECTOR_ADDRESS -args UNIX_TIME -gas-fee 100000ugnot -gas-wanted 30000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY
// ```
//
// Use the same UNIX_TIME for both, at most 366 days ahead. The session must allow exactly `vm/exec:gno.land/r/mandate_dev/mandate` and nothing else, or Pull refuses it.
//
// ### Stop a mandate
//
// Do both, with your own key. Your page (`/r/mandate_dev/mandate:payer/YOUR_ADDRESS`) shows them filled in.
//
// ```
// gnokey maketx session revoke -pubkey COLLECTOR_GPUB -gas-fee 100000ugnot -gas-wanted 30000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY
// gnokey maketx call -pkgpath gno.land/r/mandate_dev/mandate -func Cancel -args YOUR_ADDRESS -args COLLECTOR_ADDRESS -gas-fee 100000ugnot -gas-wanted 30000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY
// ```
//
// ## Checking a mandate (free)
//
// The realm's view, then the chain's view of the session. A mandate is only really active if both answer: the realm cannot see a revoke.
//
// ```
// gnokey query vm/qeval -data 'gno.land/r/mandate_dev/mandate.IsActive(address("PAYER"), PLAN_ID)' -remote https://rpc.onyx.testnets.gno.land:443
// gnokey query auth/accounts/PAYER/session/COLLECTOR_ADDRESS -remote https://rpc.onyx.testnets.gno.land:443
// ```
//
// ## Rules the realm enforces
//
// - Pull: signed with a session key as a direct call; the session allows exactly this realm; a recorded, active mandate for that payer and key; exactly the price in ugnot; at most once per period (the next one is due one period after the last); not after the expiry.
// - Every other function refuses session keys and coins.
// - The first payment can be pulled as soon as the mandate is recorded (billing in advance). A missed period is never collected later.
// - A wallet can have at most 16 sessions, so at most 16 mandates at a time.
//
// ---
//
// Built on [gno.land](https://gno.land) · source: not published yet
//
// ==== Render("nope")
// # Not found
//
// There is no such page. [Back to Mandate](/r/mandate_dev/mandate)
//
// ---
//
// Built on [gno.land](https://gno.land) · source: not published yet
