package mandate

import (
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
	Mandates   int
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
	m := mandateBySession(payer, sessionAddr)
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
	m := mandateByPayerPlan(payer, planID)
	return m != nil && m.isActive(time.Now().Unix())
}

// NextPullAt returns when the next pull of payer's active mandate for the
// plan is allowed (unix seconds), or 0 if there is no active mandate.
func NextPullAt(payer address, planID uint64) int64 {
	m := mandateByPayerPlan(payer, planID)
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

// MandatesOf lists a payer's mandates (all states), oldest first.
func MandatesOf(payer address, page int) []MandateInfo {
	pr := payerOf(payer)
	if pr == nil {
		return []MandateInfo{}
	}
	return infos(pr.Mandates, page)
}

// SupportersOf lists a plan's mandates (all states), oldest first.
func SupportersOf(planID uint64, page int) []MandateInfo {
	p := planOf(planID)
	if p == nil {
		return []MandateInfo{}
	}
	return infos(p.Supporters, page)
}

// MandatesForSession lists the mandates of every payer that gave a session
// to this key, oldest first. A collector holding the key reads this.
func MandatesForSession(sessionAddr address, page int) []MandateInfo {
	ki := keyIndexOf(sessionAddr)
	if ki == nil {
		return []MandateInfo{}
	}
	return infos(ki.Mandates, page)
}

// CollectorList is MandatesForSession as plain text for scripts: one line
// per mandate, fields separated by single spaces:
//
//	<mandate id> <payer> <amount ugnot> <next pull unix> <status> <due|wait>
//
// The last line is "more" when another page follows, "end" otherwise.
func CollectorList(sessionAddr address, page int) string {
	now := time.Now().Unix()
	var b strings.Builder
	more := false
	if ki := keyIndexOf(sessionAddr); ki != nil {
		lo, hi, m := pageBounds(len(ki.Mandates), page)
		more = m
		for _, mm := range ki.Mandates[lo:hi] {
			mi := mm.info(now)
			due := "wait"
			if mi.Due {
				due = "due"
			}
			b.WriteString(utoa(mi.ID) + " " + mi.Payer.String() + " " + itoa(mi.Amount) + " " +
				itoa(mi.NextPullAt) + " " + mi.Status + " " + due + "\n")
		}
	}
	if more {
		b.WriteString("more\n")
	} else {
		b.WriteString("end\n")
	}
	return b.String()
}

func infos(list []*Mandate, page int) []MandateInfo {
	now := time.Now().Unix()
	out := []MandateInfo{}
	lo, hi, _ := pageBounds(len(list), page)
	for _, m := range list[lo:hi] {
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
		Mandates:   p.Mandates,
		Pulls:      p.Pulls,
		Paid:       p.Paid,
		LastPullAt: p.LastPullAt,
	}
}

func (m *Mandate) info(now int64) MandateInfo {
	p := m.plan
	st := m.status(now)
	return MandateInfo{
		ID:            m.ID,
		PlanID:        m.PlanID,
		Payer:         m.Payer,
		Payee:         p.Payee,
		Session:       m.Session,
		SessionPubKey: m.SessionPubKey,
		Amount:        p.Amount,
		Period:        p.Period,
		CreatedAt:     m.CreatedAt,
		ExpiresAt:     m.ExpiresAt,
		NextPullAt:    m.NextPullAt,
		LastPullAt:    m.LastPullAt,
		Pulls:         m.Pulls,
		Paid:          m.Paid,
		CancelledAt:   m.CancelledAt,
		CancelledBy:   m.CancelledBy,
		Status:        st,
		Due:           st == "active" && now >= m.NextPullAt,
		SessionQuery:  "auth/accounts/" + m.Payer.String() + "/session/" + m.Session.String(),
	}
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
