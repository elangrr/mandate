package mandate

import (
	"strings"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
)

// fixedList keeps the newest entries in tail, full chunks of fanout, and
// fanout chunks per super-chunk; every index maps to the right entry across
// the boundaries, and set rewrites in place.
func TestFixedList(t *testing.T) {
	var l fixedList
	n := fanout*fanout + 3*fanout + 5 // past the first super-chunk
	for i := 0; i < n; i++ {
		l.add(encodeEntry(payer, uint64(i), statusUnpaid))
		uassert.Equal(t, i+1, l.N)
		for _, j := range []int{0, i / 2, i} {
			uassert.Equal(t, uint64(j), decodeEntry(l.at(j)).ID)
		}
		uassert.Equal(t, (i+1)%fanout, len(l.tail))
		full := (i + 1) / fanout
		uassert.Equal(t, (full+fanout-1)/fanout, len(l.supers))
	}
	uassert.Equal(t, fanout, len(l.supers[0].chunks))
	uassert.Equal(t, 3, len(l.supers[1].chunks))
	for _, j := range []int{0, 31, 32, 33, fanout*fanout - 1, fanout * fanout, n - 1} {
		l.setStatus(j, statusPaid)
		e := decodeEntry(l.at(j))
		uassert.Equal(t, uint64(j), e.ID)
		uassert.True(t, e.Status == statusPaid)
		uassert.Equal(t, entryWidth, len(l.at(j)))
		uassert.Equal(t, payer.String(), e.Payer.String())
	}
	// No preallocation: a slot costs storage even when empty.
	var small fixedList
	small.add("x")
	uassert.Equal(t, 1, cap(small.tail))
}

// Supporter lists keep their order across chunks.
func TestLongLists(cur realm, t *testing.T) {
	resetState()
	pid := offer(cur, payee, "Plan", gnot, day)
	n := 2*fanout + 3
	for i := 0; i < n; i++ {
		subscribe(cur, testutils.TestAddress("md_l"+itoa(int64(i))), pid, sessA, now()+day)
	}
	uassert.Equal(t, n, planOf(pid).Supporters.N)
	seen := 0
	for page := 1; ; page++ {
		list := SupportersOf(pid, page)
		for _, m := range list {
			uassert.Equal(t, uint64(seen+1), m.ID)
			uassert.Equal(t, testutils.TestAddress("md_l"+itoa(int64(seen))).String(), m.Payer.String())
			seen++
		}
		if len(list) < PageSize {
			break
		}
	}
	uassert.Equal(t, n, seen)
}

// A payer's history is newest first and paged; lookups by session and by
// plan return the latest mandate.
func TestPayerHistory(cur realm, t *testing.T) {
	resetState()
	pid := offer(cur, payee, "Plan", gnot, day)
	pid2 := offer(cur, payee, "Plan 2", gnot, day)
	var ids []uint64
	for i := 0; i < 25; i++ {
		ids = append(ids, subscribe(cur, payer, pid, sessA, now()+day))
		cancel(cur, payer, payer, sessA)
	}
	last := subscribe(cur, payer, pid2, sessA, now()+day)
	p1 := MandatesOf(payer, 1)
	p2 := MandatesOf(payer, 2)
	uassert.Equal(t, PageSize, len(p1))
	uassert.Equal(t, 6, len(p2))
	uassert.Equal(t, 0, len(MandatesOf(payer, 3)))
	uassert.Equal(t, last, p1[0].ID)
	uassert.Equal(t, ids[24], p1[1].ID)
	uassert.Equal(t, ids[0], p2[5].ID)
	m, _ := MandateOf(payer, sessA)
	uassert.Equal(t, last, m.ID)
	uassert.True(t, HasMandate(payer, pid2))
	uassert.False(t, HasMandate(payer, pid))
	pl, _ := GetPlan(pid)
	uassert.Equal(t, 25, pl.Mandates)
	uassert.Equal(t, 25, pl.Cancelled)
	// The payer page pages the same way.
	has(t, renders(t, "payer/"+payer.String()), "## Mandate "+utoa(last)+":", "newest first")
	has(t, renders(t, "payer/"+payer.String()+"?page=2"), "## Mandate "+utoa(ids[0])+":", "oldest on page 2")
}

// Free reads never create storage: looking up an unknown payer creates no
// payer record.
func TestReadsDoNotWrite(cur realm, t *testing.T) {
	resetState()
	MandateOf(payer, sessA)
	HasMandate(payer, 1)
	NextPullAt(payer, 1)
	MandatesOf(payer, 1)
	renders(t, "payer/"+payer.String())
	uassert.Equal(t, 0, payers.Size())
}

// Paid, LastPullAt and SessionPubKey are derived, not stored.
func TestDerivedFields(cur realm, t *testing.T) {
	resetState()
	pid := offer(cur, payee, "Plan", 2*gnot, MinPeriod)
	setKey(cur, payee, gpubA)
	subscribe(cur, payer, pid, sessA, now()+day)
	m, _ := MandateOf(payer, sessA)
	uassert.Equal(t, int64(0), m.LastPullAt)
	uassert.Equal(t, int64(0), m.Paid)
	uassert.Equal(t, gpubA, m.SessionPubKey)
	t0 := now()
	pullOK(payer, sessA, 2*gnot)
	testing.SkipHeights(13)
	t1 := now()
	pullOK(payer, sessA, 2*gnot)
	m, _ = MandateOf(payer, sessA)
	uassert.Equal(t, t1, m.LastPullAt)
	uassert.True(t, t1 > t0)
	uassert.Equal(t, int64(2), m.Pulls)
	uassert.Equal(t, 4*gnot, m.Paid)
	p, _ := GetPlan(pid)
	uassert.Equal(t, 4*gnot, p.Paid)
	uassert.Equal(t, t1, p.LastPullAt)
	// The payee moves to another collector key: the realm no longer knows
	// this session's public key, and the payer page says how to find it.
	setKey(cur, payee, gpubB)
	m, _ = MandateOf(payer, sessA)
	uassert.Equal(t, "", m.SessionPubKey)
	has(t, renders(t, "payer/"+payer.String()), "/sessions -remote", "lookup command")
}

// Supporters are listed only once they have paid. Junk mandates that never
// pay are skipped by their status character, without a lookup, so they
// cannot hide a real supporter; payment counts come from the plan's own
// counters and junk cannot move them.
func TestPayingSupporters(cur realm, t *testing.T) {
	resetState()
	pid := offer(cur, payee, "Real plan", gnot, MinPeriod)
	offer(cur, payee, "Nobody pays", gnot, MinPeriod)
	real := testutils.TestAddress("md_real")
	subscribe(cur, real, pid, sessA, now()+day)
	pullOK(real, sessA, gnot)
	// 2*ScanLimit junk mandates after the real one, none of them ever pays
	for i := 0; i < 2*ScanLimit; i++ {
		subscribe(cur, testutils.TestAddress("md_j"+itoa(int64(i))), pid, sessA, now()+day)
	}
	p, _ := GetPlan(pid)
	uassert.Equal(t, 1, p.PaidThisPeriod)
	// the collector scan resolves at most ScanLimit entries per call and says where to go on
	scan := CollectorScan(pid, sessA, 0)
	uassert.True(t, strings.HasSuffix(scan, "\nnext 200\n"), "scan cursor")
	uassert.Equal(t, ScanLimit+1, len(strings.Split(strings.TrimSuffix(scan, "\n"), "\n")))
	uassert.True(t, strings.HasSuffix(CollectorScan(pid, sessA, 400), "end\n"))
	uassert.Equal(t, "end\n", CollectorScan(pid, sessA, 1<<62)) // the cursor is clamped
	page := renders(t, "plan/"+utoa(pid))
	has(t, page, "1 supporter paid in the current period", "count")
	has(t, page, "200 active mandates have not paid yet (not listed), among the latest 200", "unpaid count, bounded")
	hasNot(t, page, short(testutils.TestAddress("md_j0")), "junk not listed")
	has(t, page, "| ["+short(real)+"]", "real supporter found past 400 junk entries in one walk")
	hasNot(t, page, "More supporters", "nothing more to walk")
	// a cancel takes the supporter off the list; the payment stays in the counts
	cancel(cur, real, real, sessA)
	p, _ = GetPlan(pid)
	uassert.Equal(t, 1, p.PaidThisPeriod)
	uassert.Equal(t, 1, p.Cancelled)
	list, _ := payingFrom(planOf(pid), -1, now())
	uassert.Equal(t, 0, len(list))
	// the home page lists only plans somebody paid for in this or the last period
	home := renders(t, "")
	has(t, home, "[Real plan]("+base+":plan/"+utoa(pid)+")", "paid plan on home")
	hasNot(t, home, "Nobody pays", "unpaid plan not on home")
	has(t, renders(t, "plans"), "Nobody pays", "all plans page")
	// two periods without payments: off the home page
	testing.SkipHeights(25)
	hasNot(t, renders(t, ""), "[Real plan]", "no payment for two periods")
}

// The supporter list walks at most WalkLimit entries per page, and the
// next page continues where it stopped: a real supporter behind more than
// WalkLimit never-paid entries is on a later page, never lost.
func TestPayingWalkBounded(cur realm, t *testing.T) {
	resetState()
	pid := offer(cur, payee, "Plan", gnot, MinPeriod)
	real := testutils.TestAddress("md_real")
	subscribe(cur, real, pid, sessA, now()+day)
	pullOK(real, sessA, gnot)
	for i := 0; i < WalkLimit+10; i++ {
		subscribe(cur, testutils.TestAddress("md_w"+itoa(int64(i))), pid, sessA, now()+day)
	}
	p := planOf(pid)
	list, next := payingFrom(p, -1, now())
	uassert.Equal(t, 0, len(list), "first walk stops after WalkLimit entries")
	uassert.Equal(t, p.Supporters.N-1-WalkLimit, next, "cursor where the walk stopped")
	list, next = payingFrom(p, next, now())
	uassert.Equal(t, 1, len(list), "found on the next walk")
	uassert.Equal(t, real.String(), list[0].Payer.String())
	uassert.Equal(t, -1, next)
}

// The payment counters read against the current time: a payment counts in
// its own period window, then in "the one before", then not at all.
func TestPaymentWindows(cur realm, t *testing.T) {
	resetState()
	pid := offer(cur, payee, "Plan", gnot, MinPeriod)
	toNextWindow := func() {
		need := (now()/MinPeriod+1)*MinPeriod - now()
		testing.SkipHeights((need + 4) / 5)
	}
	windows := func(cur, prev int, what string) {
		p, _ := GetPlan(pid)
		uassert.Equal(t, cur, p.PaidThisPeriod, what+": this period")
		uassert.Equal(t, prev, p.PaidLastPeriod, what+": last period")
	}
	toNextWindow()
	subscribe(cur, payer, pid, sessA, now()+day)
	subscribe(cur, payer2, pid, sessB, now()+day)
	windows(0, 0, "nothing paid")
	pullOK(payer, sessA, gnot)
	pullOK(payer2, sessB, gnot)
	windows(2, 0, "two payments")
	toNextWindow()
	windows(0, 2, "next window, no payment yet")
	testing.SkipHeights(1) // a full period after the first payment
	pullOK(payer, sessA, gnot)
	windows(1, 2, "one payment in the next window")
	toNextWindow()
	toNextWindow()
	windows(0, 0, "two windows later")
	pullOK(payer, sessA, gnot)
	windows(1, 0, "after a gap")
}

// Churn cannot hide a plan someone keeps paying for (audit LOW-1): one
// steady supporter, and 300 others who subscribe, pay once and cancel.
func TestHomeSurvivesChurn(cur realm, t *testing.T) {
	resetState()
	pid := offer(cur, payee, "Steady", gnot, MinPeriod)
	steady := testutils.TestAddress("md_steady")
	subscribe(cur, steady, pid, sessA, now()+day)
	for round := 0; round < 3; round++ {
		pullOK(steady, sessA, gnot)
		for i := 0; i < 100; i++ {
			who := testutils.TestAddress("md_c" + itoa(int64(round*100+i)))
			subscribe(cur, who, pid, sessB, now()+day)
			pullOK(who, sessB, gnot)
			cancel(cur, who, who, sessB)
		}
		has(t, renders(t, ""), "[Steady]("+base+":plan/"+utoa(pid)+")", "steady plan stays on home")
		list, _ := payingFrom(planOf(pid), -1, now())
		uassert.Equal(t, 1, len(list), "the steady supporter is listed")
		uassert.Equal(t, steady.String(), list[0].Payer.String())
		testing.SkipHeights(13)
	}
}

// Offer spam cannot push paid plans off the home page: it walks ScanLimit
// plans and links onwards.
func TestOfferSpam(cur realm, t *testing.T) {
	resetState()
	pid := offer(cur, payee, "Real plan", gnot, MinPeriod)
	subscribe(cur, payer, pid, sessA, now()+day)
	pullOK(payer, sessA, gnot)
	for i := 0; i < ScanLimit+5; i++ {
		offer(cur, stranger, "spam "+itoa(int64(i)), MinAmount, MinPeriod)
	}
	home := renders(t, "")
	hasNot(t, home, "spam", "no spam on home")
	has(t, home, "No plan has been paid for in its current or last period among those looked at.", "first window empty")
	has(t, home, "[More plans with supporters]("+base+"?from=5)", "cursor")
	has(t, renders(t, "?from=5"), "[Real plan]", "paid plan reached")
}

// At most MaxActivePerPayer active mandates; a cancelled or expired one
// frees its slot.
func TestActiveCap(cur realm, t *testing.T) {
	resetState()
	var pids []uint64
	for i := 0; i < MaxActivePerPayer+2; i++ {
		pids = append(pids, offer(cur, payee, "Plan "+itoa(int64(i)), gnot, MinPeriod))
	}
	sess := func(i int) address { return testutils.TestAddress("md_cap" + itoa(int64(i))) }
	for i := 0; i < MaxActivePerPayer; i++ {
		subscribe(cur, payer, pids[i], sess(i), now()+day)
	}
	uassert.Equal(t, MaxActivePerPayer, len(payerOf(payer).Active))
	testing.SetOriginSend(nil)
	testing.SetRealm(testing.NewUserRealm(payer))
	fails(t, cur, "at most 16 active mandates", func() { Subscribe(cross(cur), pids[16], sess(16), now()+day) }, "17th mandate")
	// a cancel frees a slot
	cancel(cur, payer, payer, sess(0))
	uassert.Equal(t, MaxActivePerPayer-1, len(payerOf(payer).Active))
	subscribe(cur, payer, pids[16], sess(16), now()+day)
	// an expired mandate frees its slot at the next Subscribe
	resetState()
	pids = nil
	for i := 0; i < MaxActivePerPayer+1; i++ {
		pids = append(pids, offer(cur, payee, "Plan "+itoa(int64(i)), gnot, MinPeriod))
	}
	subscribe(cur, payer, pids[0], sess(0), now()+120)
	for i := 1; i < MaxActivePerPayer; i++ {
		subscribe(cur, payer, pids[i], sess(i), now()+day)
	}
	testing.SetOriginSend(nil)
	testing.SetRealm(testing.NewUserRealm(payer))
	fails(t, cur, "at most 16 active", func() { Subscribe(cross(cur), pids[16], sess(16), now()+day) }, "17th before expiry")
	testing.SkipHeights(24) // 120 s: mandate 1 expires
	subscribe(cur, payer, pids[16], sess(16), now()+day)
	uassert.Equal(t, MaxActivePerPayer, len(payerOf(payer).Active))
	for _, r := range payerOf(payer).Active {
		uassert.True(t, r.Session != sess(0), "expired entry pruned")
	}
}

// What the reads return for cancelled and expired mandates (documented in
// docs/design.md): MandateOf still returns the newest mandate for that payer
// and session with its status; IsActive is false; NextPullAt is 0; Pull and
// Cancel find no active mandate.
func TestInactiveReads(cur realm, t *testing.T) {
	resetState()
	pid := offer(cur, payee, "Plan", gnot, MinPeriod)
	pid2 := offer(cur, payee, "Plan 2", gnot, MinPeriod)
	subscribe(cur, payer, pid, sessA, now()+day)
	subscribe(cur, payer, pid2, sessB, now()+120)
	cancel(cur, payer, payer, sessA)
	m, ok := MandateOf(payer, sessA)
	uassert.True(t, ok)
	uassert.Equal(t, "cancelled", m.Status)
	uassert.False(t, HasMandate(payer, pid))
	uassert.Equal(t, int64(0), NextPullAt(payer, pid))
	panicsLocal(t, cur, "no active mandate", func() { checkPull(true, sessA, []string{selfPaths}, payer, ugnot(gnot), now()) }, "pull cancelled")
	testing.SetOriginSend(nil)
	testing.SetRealm(testing.NewUserRealm(payer))
	fails(t, cur, "no active mandate", func() { Cancel(cross(cur), payer, sessA) }, "cancel twice")
	uassert.Equal(t, 1, len(payerOf(payer).Active)) // the cancel removed its entry
	// expired: entry kept until the next Subscribe; reads say expired
	testing.SkipHeights(24)
	m, _ = MandateOf(payer, sessB)
	uassert.Equal(t, "expired", m.Status)
	uassert.Equal(t, 0, len(SupportersOf(pid2, 1))) // only active mandates are listed
	uassert.Equal(t, 0, len(SupportersOf(pid, 1)))  // the cancelled one neither
	uassert.False(t, HasMandate(payer, pid2))
	uassert.Equal(t, int64(0), NextPullAt(payer, pid2))
	panicsLocal(t, cur, "mandate: expired", func() { checkPull(true, sessB, []string{selfPaths}, payer, ugnot(gnot), now()) }, "pull expired")
	subscribe(cur, payer, pid, sessA, now()+day) // prunes the expired entry
	uassert.Equal(t, 1, len(payerOf(payer).Active))
	m, _ = MandateOf(payer, sessB) // still found through the history
	uassert.Equal(t, "expired", m.Status)
	uassert.Equal(t, 3, len(MandatesOf(payer, 1)))
}

// Nothing another address does changes a payer's own record: an attacker's
// subscribe/cancel loop leaves the victim's Payer exactly as it was.
func TestPayerIsolation(cur realm, t *testing.T) {
	resetState()
	pid := offer(cur, payee, "Plan", gnot, MinPeriod)
	pid2 := offer(cur, payee, "Plan 2", gnot, MinPeriod)
	subscribe(cur, payer, pid, sessA, now()+day)
	victim := func() string {
		pr := payerOf(payer)
		s := utoa(pr.Head.ID) + ":"
		for _, r := range pr.Active {
			s += r.Session.String() + "/" + utoa(r.PlanID) + "=" + utoa(r.M.ID) + ","
		}
		return s
	}
	before := victim()
	for i := 0; i < 40; i++ {
		s := testutils.TestAddress("md_junk" + itoa(int64(i)))
		subscribe(cur, stranger, pid2, s, now()+day)
		cancel(cur, stranger, stranger, s)
	}
	uassert.Equal(t, before, victim())
	uassert.Equal(t, 0, len(payerOf(stranger).Active)) // cancels left nothing behind
	uassert.Equal(t, 40, len(MandatesOf(stranger, 1))+len(MandatesOf(stranger, 2)))
}

// Counts true at read time. "Supporters" (listed) are mandates that have
// paid and are active now: an expired or cancelled one is not, and is not
// "not yet paid" either; a payer who comes back counts once. The per-period
// payment counts are history (who paid in this period window and the one
// before) and are checked against the tests' own log of payments. Every view
// must agree: GetPlan, the plan headline, the supporter list, SupportersOf,
// the home page and the payee table.
func checkCounts(t *testing.T, pid uint64, listed, unpaid int, what string) {
	t.Helper()
	p, _ := GetPlan(pid)
	cur, prev := expectedWindows(pid, p.Period)
	uassert.Equal(t, cur, p.PaidThisPeriod, what+": GetPlan this period")
	uassert.Equal(t, prev, p.PaidLastPeriod, what+": GetPlan last period")
	uassert.Equal(t, now()/p.Period*p.Period, p.PeriodStart, what+": period start")
	pp := renders(t, "plan/"+utoa(pid))
	has(t, pp, plural(cur, "supporter", "supporters")+" paid in the current period", what+": headline")
	has(t, pp, ", "+itoa(int64(prev))+" in the one before", what+": headline previous")
	list, _ := payingFrom(planOf(pid), -1, now())
	uassert.Equal(t, listed, len(list), what+": listed")
	active := len(SupportersOf(pid, 1))
	uassert.Equal(t, listed+unpaid, active, what+": SupportersOf")
	if unpaid == 1 {
		has(t, pp, "1 active mandate has not paid yet", what+": unpaid")
	} else {
		has(t, pp, itoa(int64(unpaid))+" active mandates have not paid yet", what+": unpaid")
	}
	home := renders(t, "")
	pe := renders(t, "payee/"+payee.String())
	row := "| [Plan](" + base + ":plan/" + utoa(pid) + ") | 1 GNOT every minute | "
	if cur+prev > 0 {
		has(t, home, "[Plan]("+base+":plan/"+utoa(pid)+")", what+": on home")
	} else {
		hasNot(t, home, "[Plan]("+base+":plan/"+utoa(pid)+")", what+": not on home")
	}
	has(t, pe, row+itoa(int64(cur))+" / "+itoa(int64(prev))+" |", what+": payee table")
}

func TestExpirySequences(cur realm, t *testing.T) {
	period := MinPeriod
	short := func() int64 { return now() + 2*period } // expires in 2 minutes
	expire := func() { testing.SkipHeights(25) }      // 125 s

	// 1. pay, expire: not a supporter any more, not "unpaid" either
	resetState()
	pid := offer(cur, payee, "Plan", gnot, period)
	subscribe(cur, payer, pid, sessA, short())
	checkCounts(t, pid, 0, 1, "subscribed, not paid")
	pullOK(payer, sessA, gnot)
	checkCounts(t, pid, 1, 0, "paid")
	expire()
	checkCounts(t, pid, 0, 0, "expired")
	// 2. come back after expiry and pay: counted once
	subscribe(cur, payer, pid, sessA, now()+day)
	checkCounts(t, pid, 0, 1, "re-subscribed after expiry")
	pullOK(payer, sessA, gnot)
	checkCounts(t, pid, 1, 0, "paid again after expiry")

	// 3. expire, then cancel the expired (unpruned) mandate, then come back
	resetState()
	pid = offer(cur, payee, "Plan", gnot, period)
	subscribe(cur, payer, pid, sessA, short())
	pullOK(payer, sessA, gnot)
	expire()
	cancel(cur, payer, payer, sessA)
	checkCounts(t, pid, 0, 0, "expired then cancelled")
	subscribe(cur, payer, pid, sessA, now()+day)
	pullOK(payer, sessA, gnot)
	checkCounts(t, pid, 1, 0, "back after expire+cancel")

	// 4. expire, re-subscribe (prunes), cancel, come back again
	resetState()
	pid = offer(cur, payee, "Plan", gnot, period)
	subscribe(cur, payer, pid, sessA, short())
	pullOK(payer, sessA, gnot)
	expire()
	subscribe(cur, payer, pid, sessB, now()+day)
	pullOK(payer, sessB, gnot)
	checkCounts(t, pid, 1, 0, "expired, re-subscribed with another key, paid")
	cancel(cur, payer, payer, sessB)
	checkCounts(t, pid, 0, 0, "then cancelled")
	subscribe(cur, payer, pid, sessA, now()+day)
	pullOK(payer, sessA, gnot)
	checkCounts(t, pid, 1, 0, "and back once more")

	// 5. cancel a paying mandate, come back: counted once
	resetState()
	pid = offer(cur, payee, "Plan", gnot, period)
	subscribe(cur, payer, pid, sessA, now()+day)
	pullOK(payer, sessA, gnot)
	cancel(cur, payer, payer, sessA)
	checkCounts(t, pid, 0, 0, "cancelled")
	subscribe(cur, payer, pid, sessA, now()+day)
	checkCounts(t, pid, 0, 1, "back, not paid yet")
	pullOK(payer, sessA, gnot)
	checkCounts(t, pid, 1, 0, "back and paid")
	testing.SkipHeights(13) // next period: a second payment adds nothing to the lists
	pullOK(payer, sessA, gnot)
	checkCounts(t, pid, 1, 0, "paid twice")

	// 5b. never paid, then expired: not "not yet paid" any more
	resetState()
	pid = offer(cur, payee, "Plan", gnot, period)
	subscribe(cur, payer, pid, sessA, short())
	checkCounts(t, pid, 0, 1, "unpaid")
	expire()
	checkCounts(t, pid, 0, 0, "unpaid, expired")

	// 6. two payers, one expires: the other still counts
	resetState()
	pid = offer(cur, payee, "Plan", gnot, period)
	subscribe(cur, payer, pid, sessA, short())
	subscribe(cur, payer2, pid, sessA, now()+day)
	pullOK(payer, sessA, gnot)
	pullOK(payer2, sessA, gnot)
	checkCounts(t, pid, 2, 0, "two paying")
	expire()
	checkCounts(t, pid, 1, 0, "one expired")
}
