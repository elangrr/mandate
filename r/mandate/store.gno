package mandate

// chunkSize is the number of entries per chunk of a mandateList.
const chunkSize = 32

// mandateList is an append-only list. The first chunkSize entries live in
// the list itself (most plans and keys never need more); later ones go in
// chunks of chunkSize. Adding an entry rewrites at most one chunk of
// chunkSize references and, once every chunkSize entries, the short list of
// chunks. A plain slice would rewrite its whole backing array on every
// append, so subscribing to a plan would get dearer with every supporter.
// Slices are never preallocated: each stored slot costs storage, even empty.
type mandateList struct {
	N      int
	first  []*Mandate      // entries 0 .. chunkSize-1
	chunks []*mandateChunk // entries chunkSize .. N-1, chunkSize per chunk
	last   *mandateChunk   // chunks[len(chunks)-1], so an append never reads chunks
}

type mandateChunk struct {
	items []*Mandate
}

func (l *mandateList) add(m *Mandate) {
	switch {
	case l.N < chunkSize:
		l.first = append(l.first, m)
	case l.N%chunkSize == 0:
		l.last = &mandateChunk{items: []*Mandate{m}}
		l.chunks = append(l.chunks, l.last)
	default:
		l.last.items = append(l.last.items, m)
	}
	l.N++
}

// at returns entry i (0 = oldest).
func (l *mandateList) at(i int) *Mandate {
	if i < chunkSize {
		return l.first[i]
	}
	i -= chunkSize
	return l.chunks[i/chunkSize].items[i%chunkSize]
}

// page returns page `page` (1-based, PageSize rows) of the list, oldest
// first, and whether another page follows.
func (l *mandateList) page(page int) ([]*Mandate, bool) {
	lo, hi, more := pageBounds(l.N, page)
	out := make([]*Mandate, 0, hi-lo)
	for i := lo; i < hi; i++ {
		out = append(out, l.at(i))
	}
	return out, more
}

// MaxActivePerPayer is how many active mandates one payer may hold: the
// chain allows 16 sessions per account (tm2 std.MaxSessionsPerAccount), and
// each active mandate needs its own session key.
const MaxActivePerPayer = MaxSessionsPerWallet

// Payer holds one payer's own lookups and nothing of anyone else's, so no
// address can make another payer's Pull, Subscribe or Cancel read or write
// more than the payer tree's depth.
//   - Active: the payer's current mandates, at most MaxActivePerPayer that
//     are not expired. Cancel removes an entry at once; an expired entry is
//     removed at the payer's next Subscribe. Each entry carries the session
//     address and plan id inline, so finding a mandate reads one small array
//     and loads only the mandate found.
//   - Head: the payer's newest mandate; older ones follow through
//     prevOfPayer (history, walked only by free reads).
type Payer struct {
	Active []activeRef
	Head   *Mandate
}

type activeRef struct {
	Session address
	PlanID  uint64
	M       *Mandate
}

func payerOf(a address) *Payer {
	v := payers.Get(a.String())
	if v == nil {
		return nil
	}
	return v.(*Payer)
}

// activeBySession returns the payer's active-list mandate for this session
// key (it may have expired but not been pruned yet), or nil.
func activeBySession(payer, sess address) *Mandate {
	if pr := payerOf(payer); pr != nil {
		for _, r := range pr.Active {
			if r.Session == sess {
				return r.M
			}
		}
	}
	return nil
}

// activeByPlan returns the payer's active-list mandate for the plan, or nil.
func activeByPlan(payer address, planID uint64) *Mandate {
	if pr := payerOf(payer); pr != nil {
		for _, r := range pr.Active {
			if r.PlanID == planID {
				return r.M
			}
		}
	}
	return nil
}

// removeActive drops m's entry from the payer's active list.
func (pr *Payer) removeActive(m *Mandate) {
	out := make([]activeRef, 0, len(pr.Active))
	for _, r := range pr.Active {
		if r.M != m {
			out = append(out, r)
		}
	}
	pr.Active = out
}

// pruneExpired drops expired entries; it reports whether it changed anything.
func (pr *Payer) pruneExpired(now int64) {
	keep := 0
	for _, r := range pr.Active {
		if r.M.isActive(now) {
			keep++
		}
	}
	if keep == len(pr.Active) {
		return
	}
	out := make([]activeRef, 0, keep)
	for _, r := range pr.Active {
		if r.M.isActive(now) {
			out = append(out, r)
		}
	}
	pr.Active = out
}

// latestBySession returns the payer's newest mandate for this session key,
// active or not, walking the history when it is no longer active. For free
// reads only.
func latestBySession(payer, sess address) *Mandate {
	if m := activeBySession(payer, sess); m != nil {
		return m
	}
	if pr := payerOf(payer); pr != nil {
		for m := pr.Head; m != nil; m = m.prevOfPayer {
			if m.Session == sess {
				return m
			}
		}
	}
	return nil
}

// payerHead returns the payer's newest mandate.
func payerHead(payer address) *Mandate {
	if pr := payerOf(payer); pr != nil {
		return pr.Head
	}
	return nil
}
