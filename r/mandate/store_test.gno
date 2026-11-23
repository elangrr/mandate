package mandate

import (
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
)

// mandateList keeps the first chunkSize entries inline and the rest in
// chunks; every index must map to the right entry across the boundaries.
func TestMandateList(t *testing.T) {
	var l mandateList
	for i := 0; i < 3*chunkSize+5; i++ {
		l.add(&Mandate{ID: uint64(i)})
		uassert.Equal(t, i+1, l.N)
		for _, j := range []int{0, i / 2, i} {
			uassert.Equal(t, uint64(j), l.at(j).ID)
		}
	}
	uassert.Equal(t, chunkSize, len(l.first))
	uassert.Equal(t, 3, len(l.chunks))
	uassert.Equal(t, chunkSize, len(l.chunks[1].items))
	uassert.Equal(t, 5, len(l.chunks[2].items))
	// No preallocation: a slot costs storage even when empty.
	var small mandateList
	small.add(&Mandate{ID: 7})
	uassert.Equal(t, 1, cap(small.first))
	// Pages cross the inline part and the chunks.
	for page := 1; page <= 6; page++ {
		list, more := l.page(page)
		lo := (page - 1) * PageSize
		want := l.N - lo
		if want > PageSize {
			want = PageSize
		}
		if want < 0 {
			want = 0
		}
		uassert.Equal(t, want, len(list))
		for k, m := range list {
			uassert.Equal(t, uint64(lo+k), m.ID)
		}
		uassert.Equal(t, lo+PageSize < l.N, more)
	}
}

// Supporters and collector lists keep their order across chunks.
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
		ks := MandatesForSession(sessA, page)
		uassert.Equal(t, len(list), len(ks))
		for k, m := range list {
			uassert.Equal(t, uint64(seen+1), m.ID)
			uassert.Equal(t, testutils.TestAddress("md_l"+itoa(int64(seen))).String(), m.Payer.String())
			uassert.Equal(t, m.ID, ks[k].ID)
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

// Free reads never create storage: looking up an unknown payer leaves every
// bucket empty.
func TestReadsDoNotWrite(cur realm, t *testing.T) {
	resetState()
	MandateOf(payer, sessA)
	IsActive(payer, 1)
	NextPullAt(payer, 1)
	MandatesOf(payer, 1)
	renders(t, "payer/"+payer.String())
	for i, bk := range buckets {
		if bk != nil {
			t.Fatalf("bucket %d was created by a read", i)
		}
	}
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

// Past activeCountLimit supporters the plan page says "at least".
func TestActiveCountLimit(cur realm, t *testing.T) {
	resetState()
	pid := offer(cur, payee, "Big plan", gnot, day)
	for i := 0; i < activeCountLimit+3; i++ {
		subscribe(cur, testutils.TestAddress("md_a"+itoa(int64(i))), pid, sessA, now()+day)
	}
	first := testutils.TestAddress("md_a0")
	cancel(cur, first, first, sessA)
	has(t, renders(t, "plan/"+utoa(pid)), "at least 200 active supporters (counted among the latest 200)", "capped count")
	last := testutils.TestAddress("md_a" + itoa(int64(activeCountLimit+2)))
	cancel(cur, last, last, sessA)
	has(t, renders(t, "plan/"+utoa(pid)), "at least 199 active supporters", "capped count after a cancel")
}
