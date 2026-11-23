package mandate

import (
	"strings"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
)

const base = "/r/mandate_dev/mandate"

func has(t *testing.T, page, want, what string) {
	t.Helper()
	if !strings.Contains(page, want) {
		t.Fatalf("%s: page does not contain %q\n--- page ---\n%s", what, want, page)
	}
}

func hasNot(t *testing.T, page, bad, what string) {
	t.Helper()
	if strings.Contains(page, bad) {
		t.Fatalf("%s: page must not contain %q\n--- page ---\n%s", what, bad, page)
	}
}

// renders calls Render and fails the test (instead of crashing) on a panic.
func renders(t *testing.T, path string) string {
	t.Helper()
	var out string
	if r := revive(func() { out = Render(path) }); r != nil {
		t.Fatalf("Render(%q) panicked: %v", path, r)
	}
	return out
}

func TestRenderEmpty(cur realm, t *testing.T) {
	resetState()
	home := renders(t, "")
	has(t, home, "# Mandate", "title")
	has(t, home, "It is direct debit, not escrow.", "honest limit: not escrow")
	has(t, home, "0.05 GNOT", "fee allowance")
	has(t, home, "At most 16 mandates per wallet", "16 sessions")
	has(t, home, "Revoke any time.", "revoke")
	has(t, home, "nothing will ever be deployed there", "sub-path rule")
	has(t, home, "| 0 | 0 | 0 | 0 GNOT |", "empty totals")
	has(t, home, "No plans yet.", "empty list")
	has(t, home, "Built on [gno.land](https://gno.land)", "footer")
	has(t, renders(t, "?page=2"), "No more plans.", "empty page 2")
	for _, p := range []string{
		"x", "plan", "plan/", "plan/1", "plan/abc", "plan/-1", "plan/1/2", "payer/", "payer/g1bad", "payee/xyz",
		"help/x", "../help", "plan/18446744073709551616",
	} {
		has(t, renders(t, p), "# Not found", "not found: "+p)
	}
	has(t, renders(t, "payer/"+payer.String()), "No mandates on this page.", "empty payer")
	has(t, renders(t, "payee/"+payee.String()), "No plans from this address.", "empty payee")
}

func TestRenderHelp(cur realm, t *testing.T) {
	resetState()
	h := renders(t, "help")
	net := "-broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443"
	has(t, h, "gnokey maketx call -pkgpath gno.land/r/mandate_dev/mandate -func Offer -args \"TITLE\" -args 1000000 -args 604800 -gas-fee 100000ugnot -gas-wanted 30000000 "+net+" YOUR_KEY", "offer command")
	has(t, h, "-func SetCollectorKey -args GPUB_OF_COLLECTOR_KEY", "collector key command")
	has(t, h, "-func Pull -send AMOUNTugnot -master SUPPORTER_ADDRESS -gas-fee 20000ugnot -gas-wanted 20000000 "+net+" COLLECTOR_KEY", "pull command")
	has(t, h, "gnokey maketx session create -pubkey COLLECTOR_GPUB -allow-paths vm/exec:gno.land/r/mandate_dev/mandate -spend-limit PRICE_PLUS_50000ugnot -spend-period PERIOD_SECONDS -expires-at UNIX_TIME", "session command")
	has(t, h, "gnokey maketx session revoke -pubkey COLLECTOR_GPUB", "revoke")
	has(t, h, "-func Cancel -args YOUR_ADDRESS -args COLLECTOR_ADDRESS", "cancel")
	has(t, h, "gnokey query auth/accounts/PAYER/session/COLLECTOR_ADDRESS -remote https://rpc.onyx.testnets.gno.land:443", "session check")
	has(t, h, "IsActive(address(\"PAYER\"), PLAN_ID)", "qeval check")
	hasNot(t, h, "127.0.0.1", "no local node")
	hasNot(t, h, "-chainid dev", "no dev chain")
	// Every gnokey line that talks to a node names onyx-1 or the Onyx RPC.
	for _, line := range strings.Split(h, "\n") {
		if strings.HasPrefix(line, "gnokey maketx") {
			has(t, line, net, "pinned: "+line)
		}
		if strings.HasPrefix(line, "gnokey query") {
			has(t, line, "-remote https://rpc.onyx.testnets.gno.land:443", "pinned: "+line)
		}
	}
}

func TestRenderPages(cur realm, t *testing.T) {
	resetState()
	pid := offer(cur, payee, "Weekly coffee", gnot, 7*day)
	demo := offer(cur, payee, "Demo plan", gnot, 60)
	p, _ := GetPlan(pid)

	// No collector key yet: no subscribe commands.
	pp := renders(t, "plan/1")
	has(t, pp, "# Weekly coffee", "plan title")
	has(t, pp, "**1 GNOT every week** to ["+payee.String()+"]("+base+":payee/"+payee.String()+")", "price line")
	has(t, pp, "has not published a collector key", "no key")
	hasNot(t, pp, "session create", "no command without key")
	has(t, renders(t, "plan/2"), "a test plan: the period is under a day", "short period flagged")
	hasNot(t, pp, "a test plan", "week plan not flagged")

	setKey(cur, payee, gpubA)
	subscribe(cur, payer, pid, sessA, now()+30*day)
	subscribe(cur, payer2, pid, sessB, now()+30*day)
	pullOK(payer, sessA, gnot)
	cancel(cur, payer2, payer2, sessB)

	pp = renders(t, "plan/1")
	exp := itoa(now() + 365*day)
	has(t, pp, "gnokey maketx session create -pubkey "+gpubA+" -allow-paths vm/exec:gno.land/r/mandate_dev/mandate -spend-limit 1050000ugnot -spend-period 604800 -expires-at "+exp+" -gas-fee 100000ugnot -gas-wanted 30000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY", "session create")
	has(t, pp, "gnokey maketx call -pkgpath gno.land/r/mandate_dev/mandate -func Subscribe -args 1 -args "+sessA.String()+" -args "+exp+" -gas-fee 100000ugnot", "subscribe command")
	has(t, pp, "at most 1.05 GNOT every week", "cap in words")
	has(t, pp, "1 active supporter ·", "active count")
	has(t, pp, "| ["+short(payer)+"]("+base+":payer/"+payer.String()+") |", "active supporter listed")
	hasNot(t, pp, short(payer2), "cancelled supporter not listed")
	has(t, pp, "1 payment, 1 GNOT in total", "plan totals")
	uassert.Equal(t, uint64(2), demo)
	_ = p

	pr := renders(t, "payer/"+payer.String())
	has(t, pr, "## Mandate 1: [Weekly coffee]("+base+":plan/1)", "mandate heading")
	has(t, pr, "Status here: **active**", "status")
	has(t, pr, "gnokey maketx session revoke -pubkey "+gpubA+" -gas-fee 100000ugnot -gas-wanted 30000000 -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY", "revoke command")
	has(t, pr, "-func Cancel -args "+payer.String()+" -args "+sessA.String()+" -gas-fee", "cancel command")
	has(t, pr, "Payments: 1, 1 GNOT in total", "payer totals")
	// Unknown session public key: show how to find it.
	setKey(cur, payee, gpubB)
	subscribe(cur, payer2, demo, sessA, now()+day)
	p2 := renders(t, "payer/"+payer2.String())
	has(t, p2, "Status here: **cancelled**", "cancelled mandate")
	has(t, p2, "gnokey query auth/accounts/"+payer2.String()+"/sessions -remote https://rpc.onyx.testnets.gno.land:443", "list sessions")

	pe := renders(t, "payee/"+payee.String())
	has(t, pe, "| 2 | 1 | 1 GNOT |", "payee totals")
	has(t, pe, "Collector key: `"+sessB.String()+"` (`"+gpubB+"`)", "collector key shown")
	has(t, pe, "| [Weekly coffee]("+base+":plan/1) | 1 GNOT every week | 2 | 1 |", "plan row")

	home := renders(t, "")
	has(t, home, "| 2 | 3 | 1 | 1 GNOT |", "home totals")
	has(t, home, "| [Demo plan]("+base+":plan/2) | 1 GNOT every minute |", "home list")
}

// Titles cannot inject Markdown, HTML, links, mentions or math anywhere they
// are shown (plan page heading, payer heading, home and payee tables).
func TestRenderInjection(cur realm, t *testing.T) {
	resetState()
	setKey(cur, payee, gpubA)
	evil := []string{
		"# heading",
		"[click](https://evil.example)",
		"![img](https://evil.example/x.png)",
		"<script>alert(1)</script>",
		"a | b | c",
		"$x^2$ and $$y$$",
		"@moul look",
		"g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5 leading address",
		"pay g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5 now",
		"`code` and ```fence",
		"*bold* _it_ ~~s~~",
		"> quote",
		"<https://auto.link>",
		"&amp; &#x41;",
	}
	for _, title := range evil {
		pid := offer(cur, payee, title, gnot, day)
		subscribe(cur, payer, pid, sessA, now()+day)
		cancel(cur, payer, payer, sessA)
		pages := map[string]string{
			"plan":  renders(t, "plan/"+utoa(pid)),
			"payer": renders(t, "payer/"+payer.String()),
			"payee": renders(t, "payee/"+payee.String()),
			"home":  renders(t, ""),
		}
		for name, pg := range pages {
			what := name + " " + title
			hasNot(t, pg, "](https://evil", what)
			hasNot(t, pg, "<script>", what)
			hasNot(t, pg, "\n# heading", what)
			hasNot(t, strings.ReplaceAll(pg, `\$`, ""), "$", what) // every $ escaped
			hasNot(t, strings.ReplaceAll(pg, `\@`, ""), "@", what) // every @ escaped
			hasNot(t, pg, " g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5", what)
			hasNot(t, stripKnown(pg), "<", what) // no raw "<": no HTML, no autolink
			hasNot(t, pg, "&amp; &#x41;", what)
			if name == "home" || name == "payee" { // tables: a "|" must not split the cell
				hasNot(t, pg, "| b |", what)
			}
		}
		has(t, pages["plan"], "# "+esc(title)+"\n", "escaped heading")
	}
	uassert.Equal(t, "\\# heading", esc("# heading"))
	uassert.Equal(t, "&#103;1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5", esc("g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5"))
	uassert.Equal(t, "a&#32;g1x", gnowebSafe("a g1x"))
	uassert.Equal(t, `\$1`, gnowebSafe("$1"))
	uassert.Equal(t, `\@x`, gnowebSafe("@x"))
}

// stripKnown removes escaped "<" and the realm's own placeholders in code
// spans, so any "<" left would come from a title.
func stripKnown(pg string) string {
	for _, k := range []string{`\<`, "`/r/mandate_dev/mandate:payer/<your address>`", "`gnokey maketx session revoke -pubkey <its gpub1 key> ... YOUR_KEY`"} {
		pg = strings.ReplaceAll(pg, k, "")
	}
	return pg
}

func TestRenderPaging(cur realm, t *testing.T) {
	resetState()
	setKey(cur, payee, gpubA)
	for i := 0; i < 21; i++ {
		offer(cur, payee, "Plan "+itoa(int64(i+1)), gnot, day)
	}
	for i := 0; i < 21; i++ {
		who := testutils.TestAddress("md_r" + itoa(int64(i)))
		subscribe(cur, who, 1, sessA, now()+day)
	}
	home := renders(t, "")
	has(t, home, "[Next page]("+base+"?page=2)", "home next")
	hasNot(t, home, "Previous page", "home no previous")
	h2 := renders(t, "?page=2")
	has(t, h2, "[Previous page]("+base+"?page=1)", "home previous")
	has(t, h2, "[Plan 1]("+base+":plan/1)", "oldest on page 2")
	plan := renders(t, "plan/1")
	has(t, plan, "21 active supporters", "count")
	has(t, plan, "[Next page]("+base+":plan/1?page=2)", "plan next")
	has(t, renders(t, "plan/1?page=2"), "[Previous page]("+base+":plan/1?page=1)", "plan previous")
	has(t, renders(t, "payee/"+payee.String()), "[Next page]("+base+":payee/"+payee.String()+"?page=2)", "payee next")
}
