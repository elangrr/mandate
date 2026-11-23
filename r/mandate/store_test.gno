package mandate

import (
	"strings"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
)

// supporterList keeps the newest entries in tail and full chunks of
// chunkSize; every index must map to the right entry across the boundaries.
func TestSupporterList(t *testing.T) {
	var l supporterList
	for i := 0; i < 3*chunkSize+5; i++ {
		l.add(entry{Payer: payer, ID: uint64(i)})
		uassert.Equal(t, i+1, l.N)
		for _, j := range []int{0, i / 2, i} {
			uassert.Equal(t, uint64(j), l.at(j).ID)
		}
		uassert.Equal(t, (i+1)%chunkSize, len(l.tail))
		uassert.Equal(t, (i+1)/chunkSize, len(l.chunks))
	}
	uassert.Equal(t, chunkSize, len(l.chunks[2].items))
	// No preallocation: a slot costs storage even when empty.
	var small supporterList
	small.add(entry{Payer: payer, ID: 7})
	uassert.Equal(t, 1, cap(small.tail))
}

// Supporter lists keep their order across chunks.
func TestLongLists(cur realm, t *testing.T) {
	resetState()
	pid := offer(cur, payee, "Plan", gnot, day)
	n := 2*chunkSize + 3
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
	uassert.True(t, IsActive(payer, pid2))
	uassert.False(t, IsActive(payer, pid))
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
	IsActive(payer, 1)
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

// Supporters are listed and counted only once they have paid; junk
// mandates that never pay are neither listed nor counted, and cannot hide
// a real supporter: the page walks ScanLimit entries and links onwards.
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
	uassert.Equal(t, 1, p.Paying)
	// the collector scan walks at most ScanLimit entries per call and says where to go on
	scan := CollectorScan(pid, sessA, 0)
	uassert.True(t, strings.HasSuffix(scan, "\nnext 200\n"), "scan cursor")
	uassert.Equal(t, ScanLimit+1, len(strings.Split(strings.TrimSuffix(scan, "\n"), "\n")))
	uassert.True(t, strings.HasSuffix(CollectorScan(pid, sessA, 400), "end\n"))
	page := renders(t, "plan/"+utoa(pid))
	has(t, page, "1 paying supporter ·", "count")
	has(t, page, "400 mandates have not paid yet (not listed)", "unpaid count")
	hasNot(t, page, short(testutils.TestAddress("md_j0")), "junk not listed")
	hasNot(t, page, short(real), "real one is beyond the first window")
	has(t, page, "[More supporters]("+base+":plan/"+utoa(pid)+"?from=200)", "cursor link")
	p2 := renders(t, "plan/"+utoa(pid)+"?from=200")
	has(t, p2, "?from=0)", "second cursor")
	p3 := renders(t, "plan/"+utoa(pid)+"?from=0")
	has(t, p3, "| ["+short(real)+"]", "real supporter reached")
	hasNot(t, p3, "More supporters", "list exhausted")
	// a cancel takes the supporter out of the count
	cancel(cur, real, real, sessA)
	p, _ = GetPlan(pid)
	uassert.Equal(t, 0, p.Paying)
	uassert.Equal(t, 1, p.Cancelled)
	// the home page lists only plans somebody pays for
	other := testutils.TestAddress("md_other")
	subscribe(cur, other, pid, sessB, now()+day)
	pullOK(other, sessB, gnot)
	home := renders(t, "")
	has(t, home, "[Real plan]("+base+":plan/"+utoa(pid)+")", "paid plan on home")
	hasNot(t, home, "Nobody pays", "unpaid plan not on home")
	has(t, renders(t, "plans"), "Nobody pays", "all plans page")
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
	has(t, home, "No plan has a paying supporter yet among those looked at.", "first window empty")
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
	uassert.False(t, IsActive(payer, pid))
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
	uassert.False(t, IsActive(payer, pid2))
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
