import { useState, type FormEvent, type ReactNode } from "react";
import { config, gnowebPage, rules } from "../config";
import type { Mandate, Plan } from "../lib/amino";
import { date, dateTime, gnot, isTestPeriod, period, plural, price, relative, shortAddr, thousands } from "../lib/format";
import { isAddress, read, type Session, type SessionEntry } from "../lib/rpc";
import { LoosePermission, StopControls, SubscribePanel } from "./actions";
import { usePending } from "../lib/pending";
import { allowPath } from "../lib/tx";
import { FlowPicture } from "./FlowPicture";
import { go, useAsync } from "./hooks";
import { useLive } from "./live";
import { Addr, CapMeter, Empty, ExplorerAccount, Gnot, Icon, Loading, NotLive, ReadFailed, RhythmStrip, SlotGauge } from "./parts";
import { useWallet } from "./WalletContext";

const PLAN_WALK_PAGES = 10; // the home page looks at the newest 200 plans

/** Runs `children` only once the realm is live; otherwise the calm waiting state. */
function WhenLive({ children }: { children: ReactNode }) {
  const live = useLive();
  if (live.status === "loading") return <Loading what="Mandate’s status" />;
  if (live.status === "error") return <ReadFailed error={live.error} retry={live.reload} />;
  if (live.value.status !== "live") return <NotLive status={live.value} />;
  return <>{children}</>;
}

function PlanCard({ p }: { p: Plan }) {
  const cap = p.amount + rules.feeAllowanceUgnot;
  return (
    <li className="plan-card">
      <a href={`#/plan/${p.id}`} className="plan-card-link">
        <span className="plan-card-main">
          <span className="plan-card-title">
            <span className="plan-num mono">#{p.id.toString()}</span> {p.title}
          </span>
          <span className="plan-card-meta">
            {plural(p.paidThisPeriod, "payment")} this period · {plural(p.paidLastPeriod, "payment")} the one before
            {isTestPeriod(p.period) && <span className="badge">test plan</span>}
          </span>
        </span>
        <span className="plan-card-right">
          <span className="plan-card-price">{price(p.amount, p.period)}</span>
          <span className="plan-card-cap mono">cap {gnot(cap)} GNOT</span>
        </span>
      </a>
    </li>
  );
}

// ------------------------------------------------------------------ home

export function Home() {
  return (
    <>
      <section className="hero">
        <div className="hero-grid">
          <div className="hero-copy">
            <span className="eyebrow mono">
              <span className="status-dot status-dot-accent" aria-hidden="true" />
              Direct debit on GNOT · capped on chain
            </span>
            <h1>Support a creator every month, with a cap you set yourself.</h1>
            <p className="lede">
              You sign one permission from your own wallet: <em>at most this much, every period, through Mandate only, until you stop</em>. The
              creator’s collector takes each payment when it is due, and Mandate checks who, how much and when before any coin moves.
            </p>
            <div className="hero-actions">
              <a className="btn btn-primary" href="#/plans">
                See the plans <Icon name="arrow-right" />
              </a>
              <a className="btn btn-quiet" href="#/how">
                How it works
              </a>
            </div>
          </div>
          <aside className="hero-console" aria-hidden="true">
            <div className="console-bar">
              <span className="console-kicker">Standing order · example</span>
              <span className="console-stamp mono">ENFORCED</span>
            </div>
            <div className="console-amount">
              <span className="console-figure mono">1.00</span>
              <span className="console-unit">
                <strong className="mono">GNOT</strong>
                <span className="muted small">every 30 days</span>
              </span>
            </div>
            <RhythmStrip
              amountLabel="1"
              capLabel="1.1"
              periodLabel="30 DAYS"
              tone="ok"
              ratio={1 / 1.1}
              ticks={["M1", "M2", "M3", "M4", "M5", "M6"]}
            />
            <div className="console-specs">
              <div>
                <span className="console-spec-k">Locked up front</span>
                <span className="console-spec-v mono">0 GNOT</span>
              </div>
              <div>
                <span className="console-spec-k">Fee allowance</span>
                <span className="console-spec-v mono">0.1 GNOT</span>
              </div>
              <div>
                <span className="console-spec-k">Revocation</span>
                <span className="console-spec-v mono">Any time</span>
              </div>
            </div>
          </aside>
        </div>
      </section>
      <FlowPicture />
      <Limits />
      <WhenLive>
        <Numbers />
        <PaidPlans />
      </WhenLive>
    </>
  );
}

function Limits() {
  return (
    <section className="limits" aria-labelledby="limits-title">
      <div className="section-head">
        <h2 id="limits-title">The honest limits</h2>
        <span className="console-kicker">Protocol guarantees</span>
      </div>
      <ul className="limit-grid">
        <li>
          <strong>Direct debit, not escrow.</strong> Nothing is locked up front. You can stop at any time, and a creator is only paid when a
          payment goes through.
        </li>
        <li>
          <strong>A cap the chain enforces.</strong> At most the price plus a {gnot(rules.feeAllowanceUgnot)} GNOT fee allowance per period,
          never more, never more often.
        </li>
        <li>
          <strong>Stop any time.</strong> Revoking the permission in your wallet stops every payment at once; cancelling here ends the mandate.
        </li>
        <li>
          <strong>Test GNOT.</strong> This runs on the {config.networkName}. Dollar figures show what the same amount of real GNOT is worth today.
        </li>
      </ul>
    </section>
  );
}

function Numbers() {
  const [t] = useAsync(() => read.totals(), []);
  if (t.status !== "ready") return null;
  const { plans, mandates, pulls, paid } = t.value;
  return (
    <section className="numbers" aria-label="Mandate in numbers">
      <div className="num-cell">
        <span className="num">{thousands(plans)}</span>
        <span className="num-label">plans</span>
      </div>
      <div className="num-cell">
        <span className="num">{thousands(mandates)}</span>
        <span className="num-label">mandates recorded</span>
      </div>
      <div className="num-cell">
        <span className="num">{thousands(pulls)}</span>
        <span className="num-label">payments</span>
      </div>
      <div className="num-cell num-cell-accent">
        <span className="num">{gnot(paid)}</span>
        <span className="num-label">GNOT paid to creators</span>
      </div>
    </section>
  );
}

async function walkPlans(): Promise<Plan[]> {
  const out: Plan[] = [];
  for (let page = 1; page <= PLAN_WALK_PAGES; page++) {
    const list = await read.plans(page);
    out.push(...list);
    if (list.length < rules.pageSize) break;
  }
  return out;
}

function PaidPlans() {
  const [s, reload] = useAsync(walkPlans, []);
  return (
    <section aria-labelledby="paid-title">
      <div className="section-head">
        <h2 id="paid-title">Plans people pay for</h2>
        <a href="#/plans" className="section-link">
          All plans <Icon name="arrow-right" />
        </a>
      </div>
      {s.status === "loading" && <Loading what="the plans" />}
      {s.status === "error" && <ReadFailed error={s.error} retry={reload} />}
      {s.status === "ready" &&
        (() => {
          const paid = s.value.filter((p) => p.paidThisPeriod + p.paidLastPeriod > 0);
          if (paid.length === 0)
            return (
              <Empty>
                No plan has been paid for in its current or last period yet. <a href="#/plans">See every plan</a>
              </Empty>
            );
          return (
            <ul className="plan-list">
              {paid.map((p) => (
                <PlanCard key={p.id.toString()} p={p} />
              ))}
            </ul>
          );
        })()}
    </section>
  );
}

// ------------------------------------------------------------------ all plans

export function AllPlans({ page }: { page: number }) {
  return (
    <>
      <h1>All plans</h1>
      <p className="lede">Every plan ever published, newest first. A plan never changes: new terms mean a new plan.</p>
      <WhenLive>
        <PlansPage page={page} />
      </WhenLive>
    </>
  );
}

function PlansPage({ page }: { page: number }) {
  const [s, reload] = useAsync(() => read.plans(page), [page]);
  if (s.status === "loading") return <Loading what="the plans" />;
  if (s.status === "error") return <ReadFailed error={s.error} retry={reload} />;
  if (s.value.length === 0) return <Empty>No plans on this page.</Empty>;
  return (
    <>
      <ul className="plan-list">
        {s.value.map((p) => (
          <PlanCard key={p.id.toString()} p={p} />
        ))}
      </ul>
      <Pager base="#/plans" page={page} more={s.value.length === rules.pageSize} />
    </>
  );
}

function Pager({ base, page, more }: { base: string; page: number; more: boolean }) {
  if (page <= 1 && !more) return null;
  return (
    <nav className="pager" aria-label="Pages">
      {page > 1 ? <a href={`${base}?page=${page - 1}`}>Previous page</a> : <span />}
      {more && <a href={`${base}?page=${page + 1}`}>Next page</a>}
    </nav>
  );
}

// ------------------------------------------------------------------ plan page

export function PlanPage({ id }: { id: string }) {
  if (!/^\d{1,19}$/.test(id) || id === "0") return <Empty>There is no plan with that number.</Empty>;
  return (
    <WhenLive>
      <PlanBody id={BigInt(id)} />
    </WhenLive>
  );
}

async function loadPlan(id: bigint) {
  const plan = await read.plan(id);
  if (!plan) return null;
  const [counts, now] = await Promise.all([read.planCounts(id), read.chainTime()]);
  return { plan, counts, now };
}

function PlanBody({ id }: { id: bigint }) {
  const [s, reload] = useAsync(() => loadPlan(id), [id]);
  if (s.status === "loading") return <Loading what={`plan #${id}`} />;
  if (s.status === "error") return <ReadFailed error={s.error} retry={reload} />;
  if (!s.value) return <Empty>There is no plan #{id.toString()}.</Empty>;
  const { plan: p, counts, now } = s.value;
  const cap = p.amount + rules.feeAllowanceUgnot;
  const until = now + 365n * 86400n;
  const capRatio = cap > 0n ? Number((p.amount * 100n) / cap) / 100 : 0.9;
  return (
    <article className="plan-page">
      <header className="plan-hero card">
        <p className="plan-meta">
          <span className="plan-id-chip mono">Plan #{p.id.toString()}</span>
          <span>
            by <Addr a={p.payee} to={`#/creator/${p.payee}`} />
          </span>
          {isTestPeriod(p.period) && <span className="badge">test plan: shorter than a day</span>}
        </p>
        <h1>{p.title}</h1>
        <div className="plan-financials">
          <p className="plan-price">
            <Gnot ugnot={p.amount} strong /> <span>every {period(p.period)}</span>
          </p>
          <CapMeter amount={p.amount} feeAllowance={rules.feeAllowanceUgnot} periodSec={p.period} />
        </div>
      </header>

      <dl className="stats">
        <div>
          <dt>Payments this period</dt>
          <dd>{thousands(counts.paidThisPeriod)}</dd>
        </div>
        <div>
          <dt>The period before</dt>
          <dd>{thousands(counts.paidLastPeriod)}</dd>
        </div>
        <div>
          <dt>Paid to the creator</dt>
          <dd>{gnot(p.paid)} GNOT</dd>
        </div>
        <div>
          <dt>Last payment</dt>
          <dd>{p.lastPullAt > 0n ? relative(p.lastPullAt, now) : "never"}</dd>
        </div>
      </dl>
      {counts.unpaid > 0 && (
        <p className="muted small">
          {plural(counts.unpaid, "mandate")} recorded but not paid yet{counts.unpaidExact ? "" : ", among the latest 200"}: anyone can record a
          mandate without paying, so these are not counted as supporters.
        </p>
      )}

      <section className="card allow" aria-labelledby="allow-title">
        <div className="allow-rail">
          <span className="console-kicker">Standing order authorization</span>
          <span className="allow-cap-chip mono">HARD CAP {gnot(cap)} GNOT</span>
        </div>
        <h2 id="allow-title">What supporting this plan means</h2>
        <p className="allow-sentence">
          You allow the creator’s collector to take <strong>at most {gnot(cap)} GNOT every {period(p.period)}</strong>, through Mandate only,
          until <strong>{date(until)}</strong>. You can stop at any time.
        </p>
        <RhythmStrip
          amountLabel={gnot(p.amount)}
          capLabel={gnot(cap)}
          periodLabel={period(p.period).toUpperCase()}
          endLabel={date(until).toUpperCase()}
          tone="ok"
          ratio={capRatio}
          wide
          ticks={["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "P12"]}
        />
        <ul className="costs">
          <li>
            <span>Each period</span>
            <span>
              <Gnot ugnot={p.amount} /> to the creator, plus the collector’s network fee from your {gnot(rules.feeAllowanceUgnot)} GNOT allowance
            </span>
          </li>
          <li>
            <span>Once, to set it up</span>
            <span>a storage deposit of about 0.54 GNOT the first time you subscribe to anything here (about 0.19 GNOT after), plus network fees</span>
          </li>
          <li>
            <span>One plan per creator</span>
            <span>you can support one plan of each creator at a time, and hold at most {rules.maxActive} mandates in all</span>
          </li>
        </ul>
        <SubscribePanel plan={p} />
        <p className="small muted other-ways">
          Prefer the command line? The plan’s own page shows the two exact gnokey commands:{" "}
          <a href={gnowebPage(`plan/${p.id}`)} target="_blank" rel="noreferrer noopener" className="ext">
            open plan #{p.id.toString()} on gnoweb <Icon name="external" />
          </a>
        </p>
      </section>

      <Supporters plan={p} now={now} />
    </article>
  );
}

function Supporters({ plan, now }: { plan: Plan; now: bigint }) {
  const [pages, setPages] = useState<{ list: Mandate[]; next: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [first, reload] = useAsync(() => read.payingSupporters(plan.id, -1), [plan.id]);
  const all = first.status === "ready" ? [first.value, ...pages] : [];
  const cursor = all.length ? all[all.length - 1].next : -1;
  const list = all.flatMap((p) => p.list);
  async function more() {
    if (cursor < 0) return; // -1: the list is exhausted; stop
    setBusy(true);
    setError(null);
    try {
      const page = await read.payingSupporters(plan.id, cursor);
      setPages((ps) => [...ps, page]);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="sup-title">
      <div className="section-head">
        <h2 id="sup-title">Supporters</h2>
        {list.length > 0 && <span className="console-kicker mono">{plural(list.length, "supporter")} shown</span>}
      </div>
      <p className="muted small">People with an active mandate who have paid at least once, newest first.</p>
      {first.status === "loading" && <Loading what="the supporters" />}
      {first.status === "error" && <ReadFailed error={first.error} retry={reload} />}
      {first.status === "ready" && list.length === 0 && cursor < 0 && <Empty>No supporters yet. The first payment puts someone here.</Empty>}
      {list.length > 0 && (
        <ul className="sup-list">
          {list.map((m) => (
            <li key={m.id.toString()}>
              <Addr a={m.payer} to={`#/mine?a=${m.payer}`} />
              <span className="sup-count mono">{plural(Number(m.pulls), "payment")}</span>
              <span className="muted">paid through {date(m.paidThrough)}</span>
              <span className="muted">since {relative(m.createdAt, now)}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <ReadFailed error={error} />}
      {cursor >= 0 && (
        <button type="button" className="btn btn-quiet" onClick={more} disabled={busy}>
          {busy ? "Reading…" : "Show more supporters"}
        </button>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ my mandates

function AddressForm({ value, label, submit: submitLabel, onAddress }: { value: string; label: string; submit: string; onAddress: (a: string) => void }) {
  const [text, setText] = useState(value);
  const [bad, setBad] = useState(false);
  const wallet = useWallet();
  function submit(e: FormEvent) {
    e.preventDefault();
    const a = text.trim();
    if (!isAddress(a)) {
      setBad(true);
      document.getElementById("addr")?.focus();
      return;
    }
    setBad(false);
    onAddress(a);
  }
  return (
    <form className="addr-form card" onSubmit={submit} noValidate>
      <label htmlFor="addr">{label}</label>
      <div className="addr-row">
        <input
          id="addr"
          name="address"
          className="input mono"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="g1…"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={bad}
          aria-describedby={bad ? "addr-err" : undefined}
        />
        <button type="submit" className="btn btn-primary">
          {submitLabel}
        </button>
        {wallet.address ? (
          <button type="button" className="btn btn-quiet" onClick={() => onAddress(wallet.address!)}>
            Use my wallet
          </button>
        ) : (
          wallet.installed && (
            <button type="button" className="btn btn-quiet" onClick={() => void wallet.connect()} disabled={wallet.busy}>
              Connect wallet
            </button>
          )
        )}
      </div>
      {bad && (
        <p id="addr-err" className="field-error">
          That is not a gno.land address (g1 followed by 38 letters and digits).
        </p>
      )}
    </form>
  );
}

export function Mine({ address }: { address: string }) {
  const wallet = useWallet();
  const a = address || wallet.address || "";
  return (
    <>
      <div className="page-head">
        <span className="console-kicker">Supporter ledger · chain verified</span>
        <h1>My mandates</h1>
        <p className="lede">Every mandate a wallet has given, with what the chain itself says about each permission.</p>
      </div>
      <AddressForm key={a} value={a} label="Wallet address" submit="Show mandates" onAddress={(x) => go(`/mine?a=${x}`)} />
      {a && isAddress(a) && (
        <WhenLive>
          <MandateList payer={a} />
        </WhenLive>
      )}
    </>
  );
}

interface MandateRow {
  m: Mandate;
  plan: Plan | null;
  session: Session | null;
}

async function loadMandates(payer: string): Promise<{ rows: MandateRow[]; now: bigint; sessions: SessionEntry[] }> {
  const ms: Mandate[] = [];
  for (let page = 1; page <= rules.historyPages; page++) {
    const list = await read.mandatesOf(payer, page);
    ms.push(...list);
    if (list.length < rules.pageSize) break;
  }
  const now = await read.chainTime();
  const rows = await Promise.all(
    ms.map(async (m) => ({
      m,
      plan: await read.plan(m.planId),
      session: m.status === "active" ? await read.session(payer, m.session) : null,
    })),
  );
  return { rows, now, sessions: await read.sessions(payer) };
}

/** What a mandate really is: the realm's view combined with the chain's view of the permission. */
export function mandateState(m: Mandate, session: Session | null, now: bigint): { label: string; tone: "ok" | "warn" | "off"; note: string } {
  if (m.status === "cancelled") return { label: "Cancelled", tone: "off", note: `Cancelled ${relative(m.cancelledAt, now)}.` };
  if (m.status === "expired") return { label: "Ended", tone: "off", note: `Its term ended on ${date(m.expiresAt)}.` };
  if (!session) return { label: "Stopped on chain", tone: "warn", note: "The permission is gone on chain (revoked or never created), so no payment can be taken. Cancel it here to tidy up." };
  if (session.expiresAt > 0n && session.expiresAt <= now) return { label: "Permission expired", tone: "warn", note: `The permission ended on ${date(session.expiresAt)}, so no payment can be taken.` };
  return { label: "Active", tone: "ok", note: m.due ? "A payment is due now: the creator’s collector takes it on its next run." : `Next payment from ${dateTime(m.nextPullAt)}.` };
}

function MandateList({ payer }: { payer: string }) {
  const pending = usePending(payer);
  const [s, reload] = useAsync(() => loadMandates(payer), [payer, pending ? 1 : 0]);
  if (s.status === "loading") return <Loading what="the mandates" />;
  if (s.status === "error") return <ReadFailed error={s.error} retry={reload} />;
  const { rows, now, sessions } = s.value;
  const all = rows.map((r) => r.m);
  // permissions for Mandate that no mandate shown here uses
  const loose = sessions.filter((x) => x.allowPaths.length === 1 && x.allowPaths[0] === allowPath() && !rows.some((r) => r.m.session === x.address));
  const looseList = loose.length > 0 && (
    <section className="loose" aria-labelledby="loose-h">
      <div className="section-head">
        <h2 id="loose-h">Permissions without a mandate</h2>
        <span className="console-kicker mono">{plural(loose.length, "permission")}</span>
      </div>
      <p className="muted small">
        These permissions for Mandate are on chain, but no mandate listed here uses them: a collector key its creator has since replaced, a subscription
        started and not finished, or a mandate older than the history shown.
      </p>
      <ul className="mandate-list">
        {loose.map((x) => (
          <li key={x.address} className="card mandate" data-tone="warn">
            <div className="mandate-head">
              <span className="mandate-title">
                Permission for key <Addr a={x.address} />
              </span>
              <span className="pill pill-warn">No mandate</span>
            </div>
            <p className="mandate-price">At most {price(x.spendLimit, x.spendPeriod)}</p>
            <LoosePermission s={x} payer={payer} onChanged={reload} />
          </li>
        ))}
      </ul>
    </section>
  );
  if (rows.length === 0 && loose.length > 0) return <>{looseList}</>;
  if (rows.length === 0)
    return (
      <Empty>
        No mandates from <span className="mono">{shortAddr(payer)}</span> yet. <a href="#/plans">Find a plan</a>
      </Empty>
    );
  const active = rows.filter((r) => r.m.status === "active").length;
  const nearLimit = active >= rules.maxActive - 2;
  return (
    <>
      <div className={nearLimit ? "capacity-bar notice notice-warn" : "capacity-bar"}>
        <div className="capacity-copy">
          <p className={nearLimit ? "" : "muted small"}>
            {plural(active, "active mandate")} of the {rules.maxActive} a wallet can hold.
            {nearLimit && " You are close to the limit: cancel one you no longer need before adding another."}
          </p>
        </div>
        <SlotGauge active={active} max={rules.maxActive} />
      </div>
      <ul className="mandate-list">
        {rows.map(({ m, plan, session }) => {
          const st = mandateState(m, session, now);
          const cap = session ? session.spendLimit : m.amount + rules.feeAllowanceUgnot;
          const capRatio = cap > 0n ? Number((m.amount * 100n) / cap) / 100 : 0.9;
          return (
            <li key={m.id.toString()} className="card mandate" data-tone={st.tone}>
              <div className="mandate-head">
                <a href={`#/plan/${m.planId}`} className="mandate-title">
                  <span className="plan-num mono">#{m.planId.toString()}</span> {plan?.title ?? "plan"}
                </a>
                <span className={`pill pill-${st.tone}`}>{st.label}</span>
              </div>
              <div className="mandate-amount-row">
                <p className="mandate-price">{price(m.amount, m.period)}</p>
                <span className="mandate-cap-tag mono">cap {gnot(cap)} GNOT</span>
              </div>
              <p className="mandate-note small">{st.note}</p>
              {st.tone !== "off" && (
                <RhythmStrip
                  amountLabel={gnot(m.amount)}
                  capLabel={gnot(cap)}
                  periodLabel={period(m.period).toUpperCase()}
                  endLabel={date(m.expiresAt).toUpperCase()}
                  tone={st.tone}
                  ratio={capRatio}
                  wide
                  ticks={["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "P12"]}
                />
              )}
              <dl className="mandate-facts">
                <div>
                  <dt>Payments</dt>
                  <dd>
                    {thousands(m.pulls)} · {gnot(m.paid)} GNOT
                  </dd>
                </div>
                <div>
                  <dt>Paid through</dt>
                  <dd>{m.paidThrough > 0n ? date(m.paidThrough) : "not paid yet"}</dd>
                </div>
                <div>
                  <dt>Ends</dt>
                  <dd>{date(m.expiresAt)}</dd>
                </div>
                <div>
                  <dt>Creator</dt>
                  <dd>
                    <Addr a={m.payee} to={`#/creator/${m.payee}`} />
                  </dd>
                </div>
              </dl>
              {m.status === "active" && m.pulls === 0n && m.paidThrough > 0n && (
                <p className="small muted mandate-carry">Your current period is already paid (time carried over from an earlier mandate for this plan).</p>
              )}
              <StopControls m={m} all={all} payer={payer} now={now} sessions={sessions} onChanged={reload} />
            </li>
          );
        })}
      </ul>
      {looseList}
    </>
  );
}

// ------------------------------------------------------------------ creator page

export function Creator({ address }: { address: string }) {
  const wallet = useWallet();
  const a = address || "";
  return (
    <>
      <h1>Creator</h1>
      {!a && <p className="lede">A creator’s plans, payments received and collector key. Paste a creator’s address, or use your own wallet.</p>}
      <AddressForm key={a || wallet.address || ""} value={a} label="Creator address" submit="Show creator" onAddress={(x) => go(`/creator/${x}`)} />
      {a && isAddress(a) && (
        <WhenLive>
          <CreatorBody payee={a} />
        </WhenLive>
      )}
    </>
  );
}

async function loadCreator(payee: string) {
  const info = await read.payee(payee);
  if (!info) return null;
  const plans: Plan[] = [];
  for (let page = 1; page <= 10; page++) {
    const list = await read.plansOf(payee, page);
    plans.push(...list);
    if (list.length < rules.pageSize) break;
  }
  const counts = await Promise.all(plans.map((p) => read.planCounts(p.id)));
  const keyBlocked = info.collectorAddr ? info.collectorFunded || (await read.accountExists(info.collectorAddr)) : false;
  return { info, plans, counts, keyBlocked, now: await read.chainTime() };
}

function CreatorBody({ payee }: { payee: string }) {
  const [s, reload] = useAsync(() => loadCreator(payee), [payee]);
  if (s.status === "loading") return <Loading what="the creator" />;
  if (s.status === "error") return <ReadFailed error={s.error} retry={reload} />;
  if (!s.value)
    return (
      <Empty>
        No plans from <span className="mono">{shortAddr(payee)}</span> yet.
      </Empty>
    );
  const { info, plans, counts, keyBlocked, now } = s.value;
  return (
    <>
      <p className="muted">
        <span className="mono break">{payee}</span> · <ExplorerAccount a={payee} />
      </p>
      <dl className="stats">
        <div>
          <dt>Plans</dt>
          <dd>{thousands(info.plans)}</dd>
        </div>
        <div>
          <dt>Payments received</dt>
          <dd>{thousands(info.pulls)}</dd>
        </div>
        <div>
          <dt>Received</dt>
          <dd>{gnot(info.paid)} GNOT</dd>
        </div>
        <div>
          <dt>Last payment</dt>
          <dd>{info.lastPullAt > 0n ? relative(info.lastPullAt, now) : "never"}</dd>
        </div>
      </dl>
      <section className="card" aria-labelledby="key-title">
        <h2 id="key-title">Collector key</h2>
        {!info.collectorKey ? (
          <p>Not published yet: nobody can subscribe until it is.</p>
        ) : (
          <>
            <p className="mono small break">{info.collectorAddr}</p>
            {keyBlocked ? (
              <p className="notice notice-warn">
                <Icon name="alert" /> This key’s address has received coins, so the chain refuses new permissions for it: nobody new can subscribe.
                The creator must publish a new collector key; existing mandates keep being collected with this one until they expire.
              </p>
            ) : (
              <p className="small muted">Supporters give this key their permission. It must never receive coins.</p>
            )}
          </>
        )}
      </section>
      <section aria-labelledby="cplans-title">
        <h2 id="cplans-title">Plans</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col">Price</th>
                <th scope="col">Payments this / last period</th>
                <th scope="col">Not paid yet</th>
                <th scope="col">Received</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p, i) => (
                <tr key={p.id.toString()}>
                  <td>
                    <a href={`#/plan/${p.id}`}>
                      <span className="plan-num">#{p.id.toString()}</span> {p.title}
                    </a>
                  </td>
                  <td data-label="Price">{price(p.amount, p.period)}</td>
                  <td data-label="Payments this / last period">
                    {counts[i].paidThisPeriod} / {counts[i].paidLastPeriod}
                  </td>
                  <td data-label="Not paid yet">
                    {counts[i].unpaid}
                    {counts[i].unpaidExact ? "" : "+"}
                  </td>
                  <td data-label="Received">{gnot(p.paid)} GNOT</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

// ------------------------------------------------------------------ how it works

export function How() {
  return (
    <article className="how">
      <h1>How Mandate works</h1>
      <p className="lede">A subscription you control on gno.land, built on the chain’s session keys. Two minutes to read.</p>
      <FlowPicture />
      <ol className="steps">
        <li>
          <h2>A creator publishes a plan</h2>
          <p>
            For example “Support Fluxen’s work: 1 GNOT every 30 days”. Plans never change; new terms mean a new plan. The creator also publishes a
            collector key: a separate key that only ever asks for payments.
          </p>
        </li>
        <li>
          <h2>You give one capped permission</h2>
          <p>
            From your own wallet you sign a permission for the creator’s collector key: at most the price plus a{" "}
            {gnot(rules.feeAllowanceUgnot)} GNOT fee allowance per period, through Mandate only, until a date you choose (at most a year). Then
            you record the terms in Mandate. Both are signed by you; nothing is paid yet.
          </p>
        </li>
        <li>
          <h2>The creator collects each period</h2>
          <p>
            When a payment is due, the creator’s collector asks for exactly the price. Mandate checks that the request comes from your permission,
            that the amount is right and that the period has come, then sends the coins straight to the creator in the same transaction. The chain
            itself refuses anything above your cap.
          </p>
        </li>
        <li>
          <h2>You stop whenever you like</h2>
          <p>
            Revoke the permission in your wallet and no payment can be taken any more. Cancel the mandate in Mandate to end it there too. Time you
            already paid for stays yours: if you come back to the same plan within it, your first new payment waits until it ends.
          </p>
        </li>
      </ol>
      <section aria-labelledby="facts-title">
        <h2 id="facts-title">Good to know</h2>
        <dl className="faq">
          <dt>Is my money locked?</dt>
          <dd>No. Mandate is direct debit, not escrow: nothing leaves your wallet until a payment is taken, and the realm never holds coins.</dd>
          <dt>What is the most I can lose?</dt>
          <dd>
            Your cap per period. A dishonest creator could at worst spend your {gnot(rules.feeAllowanceUgnot)} GNOT allowance on network fees,
            which go to the network, not to them.
          </dd>
          <dt>How long can a period be?</dt>
          <dd>From one minute (for tests) to 30 days: the chain does not allow a longer spending period. So there are no yearly plans.</dd>
          <dt>How many can I hold?</dt>
          <dd>
            At most {rules.maxActive} mandates at a time (the chain allows {rules.maxActive} sessions per wallet), and one plan of each creator at a time.
          </dd>
          <dt>Why does a plan page sometimes say nobody can join?</dt>
          <dd>
            A collector key’s address must never receive coins: the chain refuses permissions for an address that is an account. When that happens,
            the creator publishes a new key.
          </dd>
        </dl>
      </section>
    </article>
  );
}
