package mandate

import (
	"strconv"
	"strings"
	"time"
)

// Free reads. Each returns plain values (copies), never pointers into the
// realm's state, so callers and vm/qeval cannot change anything.

// PlanInfo is a copy of a plan.
type PlanInfo struct {
	ID         uint64
	Payee      address
	Title      string
	Amount     int64
	Period     int64
	CreatedAt  int64
	Mandates   int // mandates ever created for this plan
	Cancelled  int // how many of them were cancelled
	Paying     int // how many have paid at least once and are not cancelled
	Pulls      int64
	Paid       int64
	LastPullAt int64
}

// MandateInfo is a copy of a mandate with the realm's view of it.
type MandateInfo struct {
	ID            uint64
	PlanID        uint64
	Payer         address
	Payee         address
	Session       address
	SessionPubKey string
	Amount        int64
	Period        int64
	CreatedAt     int64
	ExpiresAt     int64
	NextPullAt    int64
	LastPullAt    int64
	Pulls         int64
	Paid          int64
	CancelledAt   int64
	CancelledBy   address
	// Status is "active", "expired" or "cancelled": the realm's view only.
	Status string
	// Due is true when the mandate is active and a pull is allowed now.
	Due bool
	// SessionPubKey is the session key's public key when it is the payee's
	// current collector key, "" otherwise.
	//
	// SessionQuery is the free query an off-chain checker must also run:
	// the realm cannot see a session revoked or expired on chain.
	SessionQuery string
}

// PayeeInfo is a copy of a payee's totals and collector key.
type PayeeInfo struct {
	Addr          address
	Plans         int
	Pulls         int64
	Paid          int64
	LastPullAt    int64
	CollectorKey  string
	CollectorAddr address
}

// GetPlan returns the plan with this id.
func GetPlan(id uint64) (PlanInfo, bool) {
	p := planOf(id)
	if p == nil {
		return PlanInfo{}, false
	}
	return p.info(), true
}

// MandateOf returns the latest mandate of payer for this session address.
func MandateOf(payer, sessionAddr address) (MandateInfo, bool) {
	m := latestBySession(payer, sessionAddr)
	if m == nil {
		return MandateInfo{}, false
	}
	return m.info(time.Now().Unix()), true
}

// IsActive reports whether payer has a mandate for the plan that is neither
// cancelled nor expired in the realm. It cannot see an on-chain revoke of
// the session: an off-chain service deciding whether to deliver must also
// check that auth/accounts/<payer>/session/<session> still exists (see
// SessionQuery in MandateInfo), and should rely on a successful Pull, not on
// this flag, as proof of payment.
func IsActive(payer address, planID uint64) bool {
	m := activeByPlan(payer, planID)
	return m != nil && m.isActive(time.Now().Unix())
}

// NextPullAt returns when the next pull of payer's active mandate for the
// plan is allowed (unix seconds), or 0 if there is no active mandate.
func NextPullAt(payer address, planID uint64) int64 {
	m := activeByPlan(payer, planID)
	if m == nil || !m.isActive(time.Now().Unix()) {
		return 0
	}
	return m.NextPullAt
}

// GetPayee returns a payee's totals and collector key.
func GetPayee(payee address) (PayeeInfo, bool) {
	pe := payeeOf(payee)
	if pe == nil {
		return PayeeInfo{}, false
	}
	return PayeeInfo{
		Addr:          pe.Addr,
		Plans:         pe.Plans,
		Pulls:         pe.Pulls,
		Paid:          pe.Paid,
		LastPullAt:    pe.LastPullAt,
		CollectorKey:  pe.CollectorKey,
		CollectorAddr: pe.CollectorAddr,
	}, true
}

// Totals returns the number of plans and mandates, and all pulls so far.
func Totals() (plansCount, mandatesCount int, pulls, paid int64) {
	return plans.Size(), int(nextMandateID), totalPulls, totalPaid
}

// Plans lists all plans, newest first, PageSize per page (page 1 first).
func Plans(page int) []PlanInfo {
	out := []PlanInfo{}
	plans.ReverseIterateByOffset(offset(page), PageSize, func(_ string, v any) bool {
		out = append(out, v.(*Plan).info())
		return false
	})
	return out
}

// PlansOf lists a payee's plans, oldest first.
func PlansOf(payee address, page int) []PlanInfo {
	out := []PlanInfo{}
	if pe := payeeOf(payee); pe != nil {
		lo, hi, _ := pageBounds(len(pe.PlanList), page)
		for _, p := range pe.PlanList[lo:hi] {
			out = append(out, p.info())
		}
	}
	return out
}

// MandatesOf lists a payer's mandates (all states), newest first.
func MandatesOf(payer address, page int) []MandateInfo {
	list, _ := payerPage(payer, page)
	return infos(list)
}

// payerPage returns page `page` of the payer's mandates, newest first, and
// whether another page follows. It walks the payer's history, which only
// free reads do.
func payerPage(payer address, page int) ([]*Mandate, bool) {
	skip := offset(page)
	out := []*Mandate{}
	for m := payerHead(payer); m != nil; m = m.prevOfPayer {
		if skip > 0 {
			skip--
			continue
		}
		if len(out) == PageSize {
			return out, true
		}
		out = append(out, m)
	}
	return out, false
}

// SupportersOf lists a plan's active mandates (not cancelled, replaced or
// expired), oldest first. Page n covers entries (n-1)*PageSize to
// n*PageSize-1 of the plan's list, so a page may hold fewer rows than
// PageSize; inactive ones are on the payers' own pages.
func SupportersOf(planID uint64, page int) []MandateInfo {
	p := planOf(planID)
	if p == nil {
		return []MandateInfo{}
	}
	now := time.Now().Unix()
	out := []MandateInfo{}
	lo, hi, _ := pageBounds(p.Supporters.N, page)
	for i := lo; i < hi; i++ {
		if m := activeMandate(p.Supporters.at(i)); m != nil && m.isActive(now) {
			out = append(out, m.info(now))
		}
	}
	return out
}

// ScanLimit is the most supporter-list entries one free read walks; reads
// that filter (the collector scan, the paying-supporter pages) return a
// cursor to continue from, so junk entries can delay but never hide a
// real one.
const ScanLimit = 200

// CollectorPlans lists a payee's plans for a collector script, one per line:
//
//	<plan id> <amount ugnot> <period seconds> <mandates>
//
// PageSize per page; the last line is "more" or "end".
func CollectorPlans(payee address, page int) string {
	var b strings.Builder
	more := false
	if pe := payeeOf(payee); pe != nil {
		lo, hi, m := pageBounds(len(pe.PlanList), page)
		more = m
		for _, p := range pe.PlanList[lo:hi] {
			b.WriteString(utoa(p.ID) + " " + itoa(p.Amount) + " " + itoa(p.Period) + " " + strconv.Itoa(p.Supporters.N) + "\n")
		}
	}
	if more {
		b.WriteString("more\n")
	} else {
		b.WriteString("end\n")
	}
	return b.String()
}

// CollectorScan walks at most ScanLimit entries of a plan's supporter list,
// from index `from` (0 = oldest), and returns the active mandates whose
// session key is sessionAddr, one per line:
//
//	<index> <mandate id> <payer> <amount ugnot> <next pull unix> <due|wait> <pulls>
//
// The last line is "next <index>" when more entries follow, "end" otherwise.
// Cancelled and expired mandates, and mandates for other keys, are skipped
// here, so a collector never needs to read them. A mandate with 0 pulls
// has never paid: a collector should check on chain that its session exists
// before signing a Pull for it.
func CollectorScan(planID uint64, sessionAddr address, from int) string {
	p := planOf(planID)
	if p == nil {
		return "end\n"
	}
	if from < 0 {
		from = 0
	}
	now := time.Now().Unix()
	var b strings.Builder
	end := from + ScanLimit
	if end > p.Supporters.N {
		end = p.Supporters.N
	}
	for i := from; i < end; i++ {
		e := p.Supporters.at(i)
		pr := payerOf(e.Payer)
		if pr == nil {
			continue
		}
		var m *Mandate
		for _, r := range pr.Active {
			if r.ID == e.ID && r.Session == sessionAddr {
				m = r.M
			}
		}
		if m == nil || !m.isActive(now) {
			continue
		}
		due := "wait"
		if now >= m.NextPullAt {
			due = "due"
		}
		b.WriteString(strconv.Itoa(i) + " " + utoa(m.ID) + " " + m.Payer.String() + " " + itoa(p.Amount) + " " +
			itoa(m.NextPullAt) + " " + due + " " + itoa(m.Pulls) + "\n")
	}
	if end < p.Supporters.N {
		b.WriteString("next " + strconv.Itoa(end) + "\n")
	} else {
		b.WriteString("end\n")
	}
	return b.String()
}

// payingFrom walks at most ScanLimit entries of the plan's supporter list,
// newest first, starting at index `from` (or the newest when from < 0), and
// returns up to PageSize active mandates that have paid at least once, and
// the index to continue from (-1 when the list is exhausted).
func payingFrom(p *Plan, from int, now int64) ([]*Mandate, int) {
	if from < 0 || from >= p.Supporters.N {
		from = p.Supporters.N - 1
	}
	out := []*Mandate{}
	i := from
	for walked := 0; i >= 0 && walked < ScanLimit && len(out) < PageSize; i, walked = i-1, walked+1 {
		if m := activeMandate(p.Supporters.at(i)); m != nil && m.Pulls > 0 && m.isActive(now) {
			out = append(out, m)
		}
	}
	return out, i
}

func infos(list []*Mandate) []MandateInfo {
	now := time.Now().Unix()
	out := []MandateInfo{}
	for _, m := range list {
		out = append(out, m.info(now))
	}
	return out
}

func (p *Plan) info() PlanInfo {
	return PlanInfo{
		ID:         p.ID,
		Payee:      p.Payee,
		Title:      p.Title,
		Amount:     p.Amount,
		Period:     p.Period,
		CreatedAt:  p.CreatedAt,
		Mandates:   p.Supporters.N,
		Cancelled:  p.Cancelled,
		Paying:     p.Paying,
		Pulls:      p.Pulls,
		Paid:       p.Pulls * p.Amount,
		LastPullAt: p.LastPullAt,
	}
}

func (m *Mandate) info(now int64) MandateInfo {
	p := m.plan
	st := m.status(now)
	return MandateInfo{
		ID:            m.ID,
		PlanID:        p.ID,
		Payer:         m.Payer,
		Payee:         p.Payee,
		Session:       m.Session,
		SessionPubKey: m.sessionPubKey(),
		Amount:        p.Amount,
		Period:        p.Period,
		CreatedAt:     m.CreatedAt,
		ExpiresAt:     m.ExpiresAt,
		NextPullAt:    m.NextPullAt,
		LastPullAt:    m.lastPullAt(),
		Pulls:         m.Pulls,
		Paid:          m.Pulls * p.Amount,
		CancelledAt:   m.CancelledAt,
		CancelledBy:   m.CancelledBy,
		Status:        st,
		Due:           st == "active" && now >= m.NextPullAt,
		SessionQuery:  "auth/accounts/" + m.Payer.String() + "/session/" + m.Session.String(),
	}
}

// lastPullAt is when the last pull happened (0 = never): each pull sets
// NextPullAt to its own time plus one period.
func (m *Mandate) lastPullAt() int64 {
	if m.Pulls == 0 {
		return 0
	}
	return m.NextPullAt - m.plan.Period
}

// sessionPubKey returns the session key's public key when it is the payee's
// current collector key, "" otherwise (the realm then does not know it).
func (m *Mandate) sessionPubKey() string {
	if pe := m.plan.payee; pe.CollectorAddr == m.Session {
		return pe.CollectorKey
	}
	return ""
}

// offset turns a 1-based page number into a row offset; pages below 1 and
// absurdly large pages are clamped.
func offset(page int) int {
	if page < 1 {
		page = 1
	}
	if page > 1_000_000 {
		page = 1_000_000
	}
	return (page - 1) * PageSize
}

// pageBounds returns the slice bounds of page `page` (1-based, PageSize
// rows) in a list of n rows, and whether another page follows.
func pageBounds(n, page int) (lo, hi int, more bool) {
	lo = offset(page)
	if lo > n {
		lo = n
	}
	hi = lo + PageSize
	if hi > n {
		hi = n
	}
	return lo, hi, hi < n
}
