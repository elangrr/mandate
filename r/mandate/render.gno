package mandate

import (
	"strconv"
	"strings"
	"time"
)

// SourceRepo is where the source code is published, shown in the footer of
// every page. Empty until the repository is public.
const SourceRepo = ""

// Network the copy-ready commands are pinned to.
const (
	ChainID = "onyx-1"
	Remote  = "https://rpc.onyx.testnets.gno.land:443"
)

// Gas settings used in the commands (measured on a local chain: Offer and
// Subscribe use 7M to 12M gas, growing slowly with the number of plans and
// payers; Pull about 8.5M). Onyx's minimum gas price is 1 ugnot per 1,000
// gas. The Pull fee counts against the session's spend limit, so it stays
// well inside FeeAllowance.
const (
	callGas    = "-gas-fee 100000ugnot -gas-wanted 30000000"
	PullGasFee = 20_000
	pullGas    = "-gas-fee 20000ugnot -gas-wanted 20000000"
)

// Render returns the gnoweb page for path, with the footer.
func Render(path string) string {
	return renderPage(path) + footer()
}

func footer() string {
	src := "source: not published yet"
	if strings.HasPrefix(SourceRepo, "https://") {
		src = "[source](" + SourceRepo + ")"
	}
	return "\n---\n\nBuilt on [gno.land](https://gno.land) · " + src + "\n"
}

func renderPage(raw string) string {
	path, query := raw, ""
	if i := strings.Index(raw, "?"); i >= 0 {
		path, query = raw[:i], raw[i+1:]
	}
	page := pageParam(query)
	parts := strings.Split(path, "/")
	switch {
	case path == "":
		return renderHome(page)
	case path == "help":
		return renderHelp()
	case len(parts) == 2 && parts[0] == "plan":
		id, err := strconv.ParseUint(parts[1], 10, 64)
		if err != nil {
			return renderNotFound()
		}
		return renderPlan(id, page)
	case len(parts) == 2 && parts[0] == "payer":
		a := address(parts[1])
		if !a.IsValid() {
			return renderNotFound()
		}
		return renderPayer(a, page)
	case len(parts) == 2 && parts[0] == "payee":
		a := address(parts[1])
		if !a.IsValid() {
			return renderNotFound()
		}
		return renderPayee(a, page)
	}
	return renderNotFound()
}

func renderHome(page int) string {
	nPlans, nMandates, pulls, paid := Totals()
	var b strings.Builder
	b.WriteString("# Mandate\n\n")
	b.WriteString("**Subscriptions and direct debit on native GNOT.** A creator publishes a plan, such as 1 GNOT every week. ")
	b.WriteString("A supporter signs one permission from their own wallet: *at most this much, every period, through this realm only, until I cancel or it expires*. ")
	b.WriteString("The creator's collector then pulls each payment at the start of the period, and this realm checks who, how much and when before it forwards the coins.\n\n")
	b.WriteString("## The honest limits\n\n")
	b.WriteString("- **It is direct debit, not escrow.** Nothing is locked up front. A supporter can stop at any time, and a creator is only paid when a pull succeeds.\n")
	b.WriteString("- **A hard cap the supporter sets.** The chain never lets a pull take more than the session's spend limit per period: the plan's amount plus a fee allowance of " + formatUgnot(FeeAllowance) + ". ")
	b.WriteString("A dishonest creator could at worst burn that allowance as network fees; they can never take more, or pull more often.\n")
	b.WriteString("- **At most " + strconv.Itoa(MaxSessionsPerWallet) + " mandates per wallet**, because the chain allows " + strconv.Itoa(MaxSessionsPerWallet) + " session keys per account.\n")
	b.WriteString("- **Revoke any time.** Revoking the session on chain stops every pull at once. The realm cannot see a revoke, so a mandate still shows here as active until it is cancelled or expires: [how to stop a mandate](" + link("help") + ").\n")
	b.WriteString("- **One realm, nothing under it.** A session for this realm also covers any realm deployed under its path, so nothing will ever be deployed there.\n")
	b.WriteString("- No admin, no pause, no upgrade. The realm never holds funds: each payment goes straight to the creator in the same transaction.\n\n")
	b.WriteString("[How to use it, with every command](" + link("help") + ")\n\n")
	b.WriteString("## Numbers\n\n")
	b.WriteString("| Plans | Mandates | Payments | Paid out |\n|---|---|---|---|\n")
	b.WriteString("| " + strconv.Itoa(nPlans) + " | " + strconv.Itoa(nMandates) + " | " + itoa(pulls) + " | " + formatUgnot(paid) + " |\n\n")
	b.WriteString("## Supporter pages\n\n")
	list := Plans(page)
	if len(list) == 0 {
		if page > 1 {
			b.WriteString("No more plans. [First page](" + link("") + ")\n")
		} else {
			b.WriteString("No plans yet. [Publish one](" + link("help") + ").\n")
		}
		return b.String()
	}
	b.WriteString("| Plan | Price | Creator | Supporters | Payments |\n|---|---|---|---|---|\n")
	for _, p := range list {
		b.WriteString("| [" + escCell(p.Title) + "](" + link("plan/"+utoa(p.ID)) + ") | " + price(p.Amount, p.Period) +
			" | [" + short(p.Payee) + "](" + link("payee/"+p.Payee.String()) + ") | " + strconv.Itoa(activeCount(p.ID)) +
			" | " + itoa(p.Pulls) + " |\n")
	}
	b.WriteString(pager("", page, len(list) == PageSize))
	return b.String()
}

func renderPlan(id uint64, page int) string {
	p := planOf(id)
	if p == nil {
		return renderNotFound()
	}
	now := time.Now().Unix()
	pe := payeeOf(p.Payee)
	var b strings.Builder
	b.WriteString("# " + esc(p.Title) + "\n\n")
	b.WriteString("**" + price(p.Amount, p.Period) + "** to [" + p.Payee.String() + "](" + link("payee/"+p.Payee.String()) + ")")
	if p.Period < 86400 {
		b.WriteString(" (a test plan: the period is under a day)")
	}
	b.WriteString("\n\n")
	b.WriteString("Plan " + utoa(p.ID) + " · published " + formatTime(p.CreatedAt) + " · " + plural(activeCount(p.ID), "active supporter", "active supporters") + " · " +
		plural(int(p.Pulls), "payment", "payments") + ", " + formatUgnot(p.Paid) + " in total · last payment: " + formatTimeOrNever(p.LastPullAt) + "\n\n")
	b.WriteString("Plans never change. New terms are published as a new plan.\n\n")

	b.WriteString("## Supporters\n\n")
	rows := 0
	var t strings.Builder
	lo, hi, more := pageBounds(len(p.Supporters), page)
	for _, m := range p.Supporters[lo:hi] {
		if !m.isActive(now) {
			continue
		}
		t.WriteString("| [" + short(m.Payer) + "](" + link("payer/"+m.Payer.String()) + ") | " + formatTime(m.CreatedAt) + " | " + itoa(m.Pulls) +
			" | " + formatTimeOrNever(m.LastPullAt) + " |\n")
		rows++
	}
	if rows == 0 {
		b.WriteString("No active supporters on this page.\n\n")
	} else {
		b.WriteString("| Supporter | Since | Payments | Last payment |\n|---|---|---|---|\n")
		b.WriteString(t.String())
		b.WriteString("\n")
	}
	b.WriteString("Cancelled and expired mandates are not listed. A supporter who revoked the session on chain stays listed until the mandate is cancelled or expires.\n\n")
	b.WriteString(pager("plan/"+utoa(id), page, more))

	b.WriteString("## Support this plan\n\n")
	spend := p.Amount + FeeAllowance
	expires := now + 365*86400
	if pe == nil || pe.CollectorKey == "" {
		b.WriteString("The creator has not published a collector key yet, so there is nothing to subscribe to. Ask them to run `SetCollectorKey`.\n\n")
		return b.String()
	}
	b.WriteString("You need [gnokey](https://docs.gno.land) and a key with some GNOT on " + ChainID + ". Replace `YOUR_KEY` with your key's name. ")
	b.WriteString("These two commands give the creator's collector key (`" + pe.CollectorAddr.String() + "`) the right to take **at most " +
		formatUgnot(spend) + " every " + formatPeriod(p.Period) + "** (the price plus a fee allowance), through this realm only, for one year.\n\n")
	b.WriteString("1. Create the session (your own key; it cannot be done with a session):\n\n")
	b.WriteString("```\ngnokey maketx session create -pubkey " + pe.CollectorKey + " -allow-paths vm/exec:" + realmPath +
		" -spend-limit " + itoa(spend) + "ugnot -spend-period " + itoa(p.Period) + " -expires-at " + itoa(expires) + " " + callGas + " " + netFlags() + " YOUR_KEY\n```\n\n")
	b.WriteString("2. Record the terms here:\n\n")
	b.WriteString("```\ngnokey maketx call -pkgpath " + realmPath + " -func Subscribe -args " + utoa(p.ID) + " -args " + pe.CollectorAddr.String() +
		" -args " + itoa(expires) + " " + callGas + " " + netFlags() + " YOUR_KEY\n```\n\n")
	b.WriteString("The first payment is collected right after, then one every " + formatPeriod(p.Period) + ". Your page at `" + link("payer/<your address>") +
		"` shows how to stop.\n")
	return b.String()
}

func renderPayer(payer address, page int) string {
	var b strings.Builder
	b.WriteString("# Mandates of " + payer.String() + "\n\n")
	b.WriteString("Each mandate lets one creator's collector key pull a fixed amount once per period. To stop one completely, run both commands shown under it: ")
	b.WriteString("**revoke** removes the session on chain (no pull can be signed any more) and **cancel** ends the mandate here. Revoke alone already stops every payment.\n\n")
	list := MandatesOf(payer, page)
	if len(list) == 0 {
		b.WriteString("No mandates on this page.\n")
		return b.String()
	}
	for _, m := range list {
		p := planOf(m.PlanID)
		b.WriteString("## Mandate " + utoa(m.ID) + ": [" + esc(p.Title) + "](" + link("plan/"+utoa(p.ID)) + ")\n\n")
		b.WriteString("- Status here: **" + m.Status + "**")
		if m.Status == "active" {
			b.WriteString(" (if you revoked the session on chain, no payment can be taken)")
		}
		b.WriteString("\n- Price: " + price(m.Amount, m.Period) + " to [" + short(m.Payee) + "](" + link("payee/"+m.Payee.String()) + ")\n")
		b.WriteString("- Session key: `" + m.Session.String() + "`\n")
		b.WriteString("- Payments: " + itoa(m.Pulls) + ", " + formatUgnot(m.Paid) + " in total, last: " + formatTimeOrNever(m.LastPullAt) + "\n")
		if m.Status == "active" {
			b.WriteString("- Next payment allowed from: " + formatTime(m.NextPullAt) + " · ends: " + formatTime(m.ExpiresAt) + "\n")
		}
		b.WriteString("\n")
		if m.Status != "cancelled" {
			b.WriteString("Revoke the session (your own key):\n\n")
			if m.SessionPubKey != "" {
				b.WriteString("```\ngnokey maketx session revoke -pubkey " + m.SessionPubKey + " " + callGas + " " + netFlags() + " YOUR_KEY\n```\n\n")
			} else {
				b.WriteString("This session's public key is not recorded here. List your sessions to find it, then run `gnokey maketx session revoke -pubkey <its gpub1 key> ... YOUR_KEY`:\n\n")
				b.WriteString("```\ngnokey query auth/accounts/" + payer.String() + "/sessions -remote " + Remote + "\n```\n\n")
			}
			b.WriteString("Cancel the mandate (your own key):\n\n")
			b.WriteString("```\ngnokey maketx call -pkgpath " + realmPath + " -func Cancel -args " + payer.String() + " -args " + m.Session.String() + " " + callGas + " " + netFlags() + " YOUR_KEY\n```\n\n")
		}
	}
	b.WriteString(pager("payer/"+payer.String(), page, len(list) == PageSize))
	return b.String()
}

func renderPayee(payee address, page int) string {
	var b strings.Builder
	b.WriteString("# Creator " + payee.String() + "\n\n")
	pe := payeeOf(payee)
	if pe == nil {
		b.WriteString("No plans from this address.\n")
		return b.String()
	}
	b.WriteString("| Plans | Payments | Received | Last payment |\n|---|---|---|---|\n")
	b.WriteString("| " + strconv.Itoa(pe.Plans) + " | " + itoa(pe.Pulls) + " | " + formatUgnot(pe.Paid) + " | " + formatTimeOrNever(pe.LastPullAt) + " |\n\n")
	if pe.CollectorKey == "" {
		b.WriteString("Collector key: **not published**. Supporters cannot subscribe until it is (see [help](" + link("help") + ")).\n\n")
	} else {
		b.WriteString("Collector key: `" + pe.CollectorAddr.String() + "` (`" + pe.CollectorKey + "`)\n\n")
	}
	b.WriteString("## Plans\n\n")
	list := PlansOf(payee, page)
	if len(list) == 0 {
		b.WriteString("No plans on this page.\n")
		return b.String()
	}
	b.WriteString("| Plan | Price | Supporters | Payments | Last payment |\n|---|---|---|---|---|\n")
	for _, p := range list {
		b.WriteString("| [" + escCell(p.Title) + "](" + link("plan/"+utoa(p.ID)) + ") | " + price(p.Amount, p.Period) + " | " +
			strconv.Itoa(activeCount(p.ID)) + " | " + itoa(p.Pulls) + " | " + formatTimeOrNever(p.LastPullAt) + " |\n")
	}
	b.WriteString(pager("payee/"+payee.String(), page, len(list) == PageSize))
	return b.String()
}

func renderHelp() string {
	var b strings.Builder
	b.WriteString("# How to use Mandate\n\n")
	b.WriteString("Every command is for the **" + ChainID + "** test network and uses test GNOT. Replace the words in capitals. ")
	b.WriteString("Amounts are in ugnot (1 GNOT = 1,000,000 ugnot); periods and times are in seconds and unix seconds.\n\n")

	b.WriteString("## For creators\n\n")
	b.WriteString("1. Publish a plan with your own key: a title (one line, at most " + strconv.Itoa(MaxTitleLen) + " characters), the amount (at least " +
		formatUgnot(MinAmount) + ") and the period (" + itoa(MinPeriod) + " seconds to " + itoa(MaxPeriod/86400) + " days). Plans cannot be changed.\n\n")
	b.WriteString("```\ngnokey maketx call -pkgpath " + realmPath + " -func Offer -args \"TITLE\" -args 1000000 -args 604800 " + callGas + " " + netFlags() + " YOUR_KEY\n```\n\n")
	b.WriteString("2. Make a separate key for collecting (`gnokey add COLLECTOR_KEY`) and publish its public key (the `gpub1...` value `gnokey list` shows), signed with your own key:\n\n")
	b.WriteString("```\ngnokey maketx call -pkgpath " + realmPath + " -func SetCollectorKey -args GPUB_OF_COLLECTOR_KEY " + callGas + " " + netFlags() + " YOUR_KEY\n```\n\n")
	b.WriteString("3. Collect each payment when it is due, signed with the collector key on behalf of the supporter. Only the exact price is accepted, at most once per period. The fee counts against the supporter's fee allowance, so keep it small:\n\n")
	b.WriteString("```\ngnokey maketx call -pkgpath " + realmPath + " -func Pull -send AMOUNTugnot -master SUPPORTER_ADDRESS " + pullGas + " " + netFlags() + " COLLECTOR_KEY\n```\n\n")
	b.WriteString("The repository has a collector script that finds what is due through free queries and pulls it.\n\n")

	b.WriteString("## For supporters\n\n")
	b.WriteString("Open a plan's page: it shows the two exact commands, with the creator's collector key, the spend limit (price plus " + formatUgnot(FeeAllowance) +
		" for fees) and the period filled in. The general form:\n\n")
	b.WriteString("```\ngnokey maketx session create -pubkey COLLECTOR_GPUB -allow-paths vm/exec:" + realmPath + " -spend-limit PRICE_PLUS_" + itoa(FeeAllowance) +
		"ugnot -spend-period PERIOD_SECONDS -expires-at UNIX_TIME " + callGas + " " + netFlags() + " YOUR_KEY\n")
	b.WriteString("gnokey maketx call -pkgpath " + realmPath + " -func Subscribe -args PLAN_ID -args COLLECTOR_ADDRESS -args UNIX_TIME " + callGas + " " + netFlags() + " YOUR_KEY\n```\n\n")
	b.WriteString("Use the same UNIX_TIME for both, at most " + itoa(MaxTerm/86400) + " days ahead. The session must allow exactly `vm/exec:" + realmPath +
		"` and nothing else, or Pull refuses it.\n\n")
	b.WriteString("### Stop a mandate\n\n")
	b.WriteString("Do both, with your own key. Your page (`" + link("payer/YOUR_ADDRESS") + "`) shows them filled in.\n\n")
	b.WriteString("```\ngnokey maketx session revoke -pubkey COLLECTOR_GPUB " + callGas + " " + netFlags() + " YOUR_KEY\n")
	b.WriteString("gnokey maketx call -pkgpath " + realmPath + " -func Cancel -args YOUR_ADDRESS -args COLLECTOR_ADDRESS " + callGas + " " + netFlags() + " YOUR_KEY\n```\n\n")

	b.WriteString("## Checking a mandate (free)\n\n")
	b.WriteString("The realm's view, then the chain's view of the session. A mandate is only really active if both answer: the realm cannot see a revoke.\n\n")
	b.WriteString("```\ngnokey query vm/qeval -data '" + realmPath + ".IsActive(address(\"PAYER\"), PLAN_ID)' -remote " + Remote + "\n")
	b.WriteString("gnokey query auth/accounts/PAYER/session/COLLECTOR_ADDRESS -remote " + Remote + "\n```\n\n")

	b.WriteString("## Rules the realm enforces\n\n")
	b.WriteString("- Pull: signed with a session key as a direct call; the session allows exactly this realm; a recorded, active mandate for that payer and key; exactly the price in ugnot; at most once per period (the next one is due one period after the last); not after the expiry.\n")
	b.WriteString("- Every other function refuses session keys and coins.\n")
	b.WriteString("- The first payment can be pulled as soon as the mandate is recorded (billing in advance). A missed period is never collected later.\n")
	b.WriteString("- A wallet can have at most " + strconv.Itoa(MaxSessionsPerWallet) + " sessions, so at most " + strconv.Itoa(MaxSessionsPerWallet) + " mandates at a time.\n")
	return b.String()
}

func renderNotFound() string {
	return "# Not found\n\nThere is no such page. [Back to Mandate](" + link("") + ")\n"
}

// activeCount counts a plan's active mandates among its latest 1000.
func activeCount(planID uint64) int {
	p := planOf(planID)
	if p == nil {
		return 0
	}
	now := time.Now().Unix()
	n := 0
	lo := len(p.Supporters) - 1000
	if lo < 0 {
		lo = 0
	}
	for _, m := range p.Supporters[lo:] {
		if m.isActive(now) {
			n++
		}
	}
	return n
}

// link returns the gnoweb link to a page of this realm.
func link(page string) string {
	p := strings.TrimPrefix(realmPath, "gno.land")
	if page == "" {
		return p
	}
	return p + ":" + page
}

func pager(page string, n int, more bool) string {
	s := ""
	if n > 1 {
		s += "[Previous page](" + link(page) + "?page=" + strconv.Itoa(n-1) + ") "
	}
	if more {
		s += "[Next page](" + link(page) + "?page=" + strconv.Itoa(n+1) + ")"
	}
	if s == "" {
		return ""
	}
	return s + "\n\n"
}

func pageParam(query string) int {
	for _, kv := range strings.Split(query, "&") {
		if strings.HasPrefix(kv, "page=") {
			n, err := strconv.Atoi(kv[5:])
			if err == nil && n >= 1 && n <= 1_000_000 {
				return n
			}
		}
	}
	return 1
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}

func netFlags() string {
	return "-broadcast -chainid " + ChainID + " -remote " + Remote
}

func price(amount, period int64) string {
	return formatUgnot(amount) + " every " + formatPeriod(period)
}

// formatUgnot shows an amount in GNOT with up to six decimals.
func formatUgnot(n int64) string {
	whole := n / 1_000_000
	frac := n % 1_000_000
	s := itoa(whole)
	if frac != 0 {
		f := strconv.FormatInt(frac+1_000_000, 10)[1:]
		s += "." + strings.TrimRight(f, "0")
	}
	return s + " GNOT"
}

// formatPeriod shows a number of seconds in the largest exact unit.
func formatPeriod(sec int64) string {
	unit := func(n int64, one, many string) string {
		if n == 1 {
			return one
		}
		return itoa(n) + " " + many
	}
	switch {
	case sec%604800 == 0:
		return unit(sec/604800, "week", "weeks")
	case sec%86400 == 0:
		return unit(sec/86400, "day", "days")
	case sec%3600 == 0:
		return unit(sec/3600, "hour", "hours")
	case sec%60 == 0:
		return unit(sec/60, "minute", "minutes")
	}
	return unit(sec, "second", "seconds")
}

func formatTime(unix int64) string {
	return time.Unix(unix, 0).UTC().Format("2006-01-02 15:04 UTC")
}

func formatTimeOrNever(unix int64) string {
	if unix == 0 {
		return "never"
	}
	return formatTime(unix)
}

func short(a address) string {
	s := a.String()
	if len(s) < 14 {
		return s
	}
	return s[:8] + "…" + s[len(s)-4:]
}
