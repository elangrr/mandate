package mandate

import "strconv"

// chunkSize is the number of entries per chunk of a supporterList.
const chunkSize = 32

// supporterList is a plan's append-only list of mandates, oldest first. It
// stores one short string per mandate (the payer's 40-character address
// followed by the mandate id), never pointers: on
// chain, rewriting an array costs about 0.37M gas for every pointer to a
// shared object it holds, which made appends cost up to 13M gas and the
// list of chunks grow dearer with every 32 supporters (docs/design.md).
//
// The newest entries live in tail, inside the plan itself; when tail is
// full it becomes a chunk. So an append rewrites the plan and its tail (at
// most chunkSize small values), and reads the list of chunks only once
// every chunkSize appends. Reads resolve an entry through the payer's own
// record (activeMandate), so they cost a lookup per entry: free reads only.
type supporterList struct {
	N      int
	tail   []string      // the newest N % chunkSize entries
	chunks []*entryChunk // full chunks of chunkSize entries, oldest first
}

// entry is a decoded list item. Items are stored as strings: measured,
// about 400 bytes less per mandate than this two-field struct and about 80
// less than a pointer.
type entry struct {
	Payer address
	ID    uint64 // mandate id
}

type entryChunk struct {
	items []string
}

func (l *supporterList) add(e entry) {
	l.tail = append(l.tail, e.Payer.String()+utoa(e.ID))
	if len(l.tail) == chunkSize {
		l.chunks = append(l.chunks, &entryChunk{items: l.tail})
		l.tail = nil
	}
	l.N++
}

// at returns entry i (0 = oldest).
func (l *supporterList) at(i int) entry {
	var s string
	if c := i / chunkSize; c < len(l.chunks) {
		s = l.chunks[c].items[i%chunkSize]
	} else {
		s = l.tail[i%chunkSize]
	}
	id, _ := strconv.ParseUint(s[40:], 10, 64)
	return entry{Payer: address(s[:40]), ID: id}
}

// activeMandate returns the mandate an entry names if it is still in its
// payer's active list (cancelled and replaced ones are not), or nil. It may
// have expired: callers check isActive.
func activeMandate(e entry) *Mandate {
	if pr := payerOf(e.Payer); pr != nil {
		for _, r := range pr.Active {
			if r.ID == e.ID {
				return r.M
			}
		}
	}
	return nil
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
	ID      uint64 // mandate id, so a supporter entry resolves without loading mandates
	M       *Mandate
}

// payerOf returns a copy of the payer's record, or nil. Records are stored
// by value (no heap item, about 400 bytes less per payer); after changing
// one, write it back with save.
func payerOf(a address) *Payer {
	v := payers.Get(a.String())
	if v == nil {
		return nil
	}
	pr := v.(Payer)
	return &pr
}

func (pr *Payer) save(a address) { payers.Set(a.String(), *pr) }

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
