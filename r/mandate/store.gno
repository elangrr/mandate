package mandate

import "crypto/sha256"

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
}

type mandateChunk struct {
	items []*Mandate
}

func (l *mandateList) add(m *Mandate) {
	switch {
	case l.N < chunkSize:
		l.first = append(l.first, m)
	case l.N%chunkSize == 0:
		l.chunks = append(l.chunks, &mandateChunk{items: []*Mandate{m}})
	default:
		c := l.chunks[len(l.chunks)-1]
		c.items = append(c.items, m)
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

// payerBucket returns the map that holds one payer's lookup entries,
// creating it on first use. The bucket is chosen by the first byte of
// sha256(payer), so all entries of one payer share one bucket and a lookup
// or a subscribe reads and writes a single small map.
func payerBucket(payer address) map[string]*Mandate {
	h := sha256.Sum256([]byte(payer.String()))
	i := int(h[0])
	if buckets[i] == nil {
		buckets[i] = map[string]*Mandate{}
	}
	return buckets[i]
}

// peekBucket is payerBucket for reads: it never creates a bucket, so free
// reads never write.
func peekBucket(payer address) map[string]*Mandate {
	h := sha256.Sum256([]byte(payer.String()))
	return buckets[int(h[0])]
}

// Bucket keys. Addresses have a fixed length, so the keys cannot collide.
func headKey(payer address) string              { return "h" + payer.String() }
func sessionKey(payer, sess address) string     { return "s" + payer.String() + sess.String() }
func planKey(payer address, plan uint64) string { return "p" + payer.String() + utoa(plan) }

// mandateBySession returns the payer's latest mandate for this session key.
func mandateBySession(payer, sess address) *Mandate {
	if bk := peekBucket(payer); bk != nil {
		return bk[sessionKey(payer, sess)]
	}
	return nil
}

// mandateByPayerPlan returns the payer's latest mandate for the plan.
func mandateByPayerPlan(payer address, planID uint64) *Mandate {
	if bk := peekBucket(payer); bk != nil {
		return bk[planKey(payer, planID)]
	}
	return nil
}

// payerHead returns the payer's newest mandate; older ones follow through
// prevOfPayer.
func payerHead(payer address) *Mandate {
	if bk := peekBucket(payer); bk != nil {
		return bk[headKey(payer)]
	}
	return nil
}
