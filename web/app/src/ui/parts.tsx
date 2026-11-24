import { type CSSProperties, type ReactNode } from "react";
import { config, explorerAccount, pkgStatusPage } from "../config";
import type { Mandate, Plan, PlanCounts } from "../lib/amino";
import { date, gnot, period, shortAddr, thousands } from "../lib/format";
import { ReadError, type PackageStatus } from "../lib/rpc";
import { DecodeError } from "../lib/amino";
import { Usd } from "./price";

// One small icon set: 24-unit grid, 1.75 stroke, round caps, currentColor.
const PATHS = {
  sun: "M12 4V2.5M12 21.5V20M4 12H2.5M21.5 12H20M6.3 6.3 5.3 5.3M18.7 18.7l-1-1M6.3 17.7l-1 1M18.7 5.3l-1 1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z",
  auto: "M12 3a9 9 0 1 0 0 18V3Z M12 3a9 9 0 1 1 0 18",
  "arrow-right": "M5 12h14M13 6l6 6-6 6",
  "arrow-left": "M19 12H5M11 6l-6 6 6 6",
  check: "M5 12.5l4.5 4.5L19 7",
  alert: "M12 7v6M12 17h.01",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  loop: "M4 12a8 8 0 0 1 13.7-5.6L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.7 5.6L4 15M4 20v-5h5",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  stop: "M7 7h10v10H7z",
  pause: "M9 6v12M15 6v12",
  play: "M8 5.5v13l11-6.5-11-6.5Z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg className={`icon ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}

/** An amount in GNOT with the approximate dollar hint beside it. */
export function Gnot({ ugnot, strong = false }: { ugnot: bigint; strong?: boolean }) {
  const v = `${gnot(ugnot)} GNOT`;
  return (
    <span className="gnot">
      {strong ? <strong>{v}</strong> : v}
      <Usd ugnot={ugnot} />
    </span>
  );
}

/** A short address that links to its creator or mandates page in the app. */
export function Addr({ a, to }: { a: string; to?: string }) {
  if (!a) return <span className="muted">none</span>;
  const label = (
    <span className="mono" title={a} translate="no">
      {shortAddr(a)}
    </span>
  );
  return to ? <a href={to}>{label}</a> : label;
}

export function ExplorerAccount({ a }: { a: string }) {
  return (
    <a href={explorerAccount(a)} target="_blank" rel="noreferrer noopener" className="ext">
      on GnoScan <Icon name="external" />
    </a>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      Reading {what} from the chain…
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** A read failed: say what happened in plain words and offer to try again. */
export function ReadFailed({ error, retry }: { error: Error; retry?: () => void }) {
  const msg =
    error instanceof ReadError || error instanceof DecodeError
      ? error.message
      : "Unable to read the chain. Check your connection and try again.";
  return (
    <section className="error-card card" role="alert">
      <div className="error-card-rail">
        <span className="error-card-beacon mono">
          <span className="status-dot status-dot-danger" aria-hidden="true" />
          Chain read failed
        </span>
      </div>
      <div className="error-card-body">
        <div className="error-card-mark" aria-hidden="true">
          <Icon name="alert" />
        </div>
        <div>
          <p>{msg}</p>
          {retry && (
            <div className="confirm-actions">
              <button type="button" className="btn btn-quiet" onClick={retry}>
                Try again
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Visual cap meter: shows how the plan's price and the collector's fee allowance
 * sit inside the cap, with the blocked zone beyond the cap that the chain refuses.
 */
export function CapMeter({ amount, feeAllowance, periodSec }: { amount: bigint; feeAllowance: bigint; periodSec: bigint }) {
  const cap = amount + feeAllowance;
  // Cap sits at 82% of the full track width; the remaining 18% represents the zone beyond the cap.
  const capBand = 82;
  const rawShare = cap > 0n ? Number((amount * 1000n) / cap) / 1000 : 0.9;
  const pricePct = Math.round(Math.min(capBand - 7, Math.max(16, rawShare * capBand)) * 10) / 10;
  const feePct = Math.round((capBand - pricePct) * 10) / 10;
  const beyondPct = 100 - capBand;
  const style = {
    "--price-pct": `${pricePct}%`,
    "--fee-pct": `${feePct}%`,
    "--beyond-pct": `${beyondPct}%`,
  } as CSSProperties;
  return (
    <div className="cap-meter" style={style}>
      <div className="cap-meter-head">
        <span className="console-kicker">Cap per {period(periodSec)}</span>
        <span className="cap-meter-ceiling mono">Cap {gnot(cap)} GNOT</span>
      </div>
      <div className="cap-meter-track" aria-hidden="true">
        <span className="cap-meter-price" />
        <span className="cap-meter-fee" />
        <span className="cap-meter-pin" />
        <span className="cap-meter-beyond" />
      </div>
      <div className="cap-meter-legend">
        <span className="cap-legend-item">
          <span className="cap-swatch cap-swatch-price" aria-hidden="true" />
          <span className="muted">Price</span> <strong className="mono">{gnot(amount)} GNOT</strong>
        </span>
        <span className="cap-legend-item">
          <span className="cap-swatch cap-swatch-fee" aria-hidden="true" />
          <span className="muted">Fee allowance</span> <strong className="mono">+{gnot(feeAllowance)} GNOT</strong>
        </span>
        <span className="cap-legend-item">
          <span className="cap-swatch cap-swatch-cap" aria-hidden="true" />
          <span className="muted">Cap</span> <strong className="mono">{gnot(cap)} GNOT</strong>
        </span>
        <span className="cap-legend-item cap-legend-beyond">
          <span className="cap-swatch cap-swatch-beyond" aria-hidden="true" />
          <span className="muted">Above the cap: refused by the chain</span>
        </span>
      </div>
    </div>
  );
}

/**
 * Preview / example rhythm strip for the Home example card and the Plan page
 * before subscribing. Explicitly labelled as an example or a preview.
 */
export function RhythmStrip({
  kicker,
  amountLabel,
  capLabel,
  periodLabel,
  endLabel,
  ratio = 0.86,
  ticks,
  totalPeriods,
  wide = false,
}: {
  kicker: string;
  amountLabel: string;
  capLabel: string;
  periodLabel: string;
  endLabel?: string;
  ratio?: number;
  ticks: string[];
  totalPeriods?: bigint;
  wide?: boolean;
}) {
  const pct = Math.round(Math.min(86, Math.max(44, ratio * 88)));
  const shown = ticks.length;
  const more = totalPeriods !== undefined && totalPeriods > BigInt(shown);
  return (
    <div className={`rhythm rhythm-preview${wide ? " rhythm-wide" : ""}`} aria-hidden="true">
      <div className="rhythm-top">
        <span className="rhythm-cap-tag mono">Cap {capLabel} GNOT</span>
        <span className="rhythm-cadence mono">
          {kicker} · {amountLabel} GNOT / {periodLabel}
          {endLabel ? ` · until ${endLabel}` : ""}
        </span>
      </div>
      <div className="rhythm-stage">
        <div className="rhythm-overband" />
        <div className="rhythm-ceiling" />
        <div className="rhythm-bars" style={{ "--cols": shown } as CSSProperties}>
          {ticks.map((t, i) => (
            <div key={t} className="rhythm-col" style={{ "--i": i, "--h": `${pct}%` } as CSSProperties}>
              <span className="rhythm-bar">
                <span className="rhythm-bar-cap" />
              </span>
              <span className="rhythm-tick mono">{t}</span>
            </div>
          ))}
        </div>
      </div>
      {more && totalPeriods !== undefined && (
        <div className="rhythm-foot mono">
          Showing first {shown} of {thousands(totalPeriods)} periods in a year
        </div>
      )}
    </div>
  );
}

interface RealPeriodSlot {
  index: bigint; // 1-based period number
  kind: "paid" | "current" | "upcoming" | "stopped";
  isCurrent: boolean;
}

/**
 * Real mandate period timeline computed strictly from m.createdAt, m.period,
 * m.expiresAt, m.paidThrough, and chain time `now`. Never invents dates or counts.
 */
export function MandatePeriods({
  m,
  now,
  cap,
  tone,
}: {
  m: Mandate;
  now: bigint;
  cap: bigint;
  tone: "ok" | "warn" | "off";
}) {
  const totalBig = m.period > 0n && m.expiresAt > m.createdAt ? (m.expiresAt - m.createdAt + m.period - 1n) / m.period : 1n;
  const maxShow = 12n;
  // Determine 0-based current period index from real chain time
  const rawCur = m.period > 0n && now >= m.createdAt ? (now - m.createdAt) / m.period : 0n;
  const curIdx = rawCur >= totalBig ? totalBig - 1n : rawCur;

  let startIdx = 0n;
  const count = totalBig < maxShow ? totalBig : maxShow;
  if (totalBig > maxShow) {
    // Anchor window around the current period so paid + current + upcoming are visible
    const desiredStart = curIdx > 2n ? curIdx - 2n : 0n;
    const maxStart = totalBig - maxShow;
    startIdx = desiredStart > maxStart ? maxStart : desiredStart;
  }

  const ratio = cap > 0n ? Number((m.amount * 100n) / cap) / 100 : 0.9;
  const pct = Math.round(Math.min(86, Math.max(44, ratio * 88)));

  const slots: RealPeriodSlot[] = [];
  for (let offset = 0n; offset < count; offset++) {
    const idx = startIdx + offset;
    const pStart = m.createdAt + idx * m.period;
    const pEnd = pStart + m.period;
    const isCurrent = now >= pStart && now < pEnd;
    // Paid through advances by one period per payment from the pull timestamp;
    // require coverage past the period midpoint so a few seconds' collector offset
    // never marks the next unpaid period as paid.
    const isPaid = m.paidThrough >= pStart + m.period / 2n;
    let kind: RealPeriodSlot["kind"];
    if (isPaid) kind = "paid";
    else if (tone === "warn") kind = "stopped";
    else if (isCurrent) kind = "current";
    else kind = "upcoming";
    slots.push({ index: idx + 1n, kind, isCurrent });
  }

  const paidCount = slots.filter((s) => s.kind === "paid").length;
  return (
    <div className={`rhythm rhythm-real rhythm-${tone}`} aria-hidden="true">
      <div className="rhythm-top">
        <span className="rhythm-cap-tag mono">Cap {gnot(cap)} GNOT</span>
        <span className="rhythm-cadence mono">
          {date(m.createdAt)} → {date(m.expiresAt)} · {thousands(totalBig)} {totalBig === 1n ? "period" : "periods"}
        </span>
      </div>
      <div className="rhythm-stage">
        <div className="rhythm-overband" />
        <div className="rhythm-ceiling" />
        <div className="rhythm-bars rhythm-bars-real" style={{ "--cols": slots.length } as CSSProperties}>
          {slots.map((slot, i) => (
            <div
              key={slot.index.toString()}
              className={`rhythm-col rhythm-slot-${slot.kind}${slot.isCurrent ? " rhythm-slot-now" : ""}`}
              style={{ "--i": i, "--h": `${pct}%` } as CSSProperties}
            >
              <span className="rhythm-bar">
                {slot.kind === "paid" && <span className="rhythm-bar-mark">✓</span>}
                {slot.kind === "stopped" && <span className="rhythm-bar-mark">×</span>}
              </span>
              <span className="rhythm-tick mono">{slot.isCurrent ? `NOW` : `#${slot.index.toString()}`}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="rhythm-legend mono">
        <span className="rhythm-legend-item">
          <span className="rhythm-key rhythm-key-paid" />
          Paid{paidCount > 0 ? "" : " (none yet)"}
        </span>
        <span className="rhythm-legend-item">
          <span className="rhythm-key rhythm-key-now" />
          Current period
        </span>
        <span className="rhythm-legend-item">
          <span className={`rhythm-key ${tone === "warn" ? "rhythm-key-stopped" : "rhythm-key-upcoming"}`} />
          {tone === "warn" ? "Stopped on chain" : "Upcoming"}
        </span>
        {totalBig > maxShow && (
          <span className="rhythm-legend-more">
            Showing #{(startIdx + 1n).toString()}–#{(startIdx + count).toString()} of {thousands(totalBig)}
          </span>
        )}
      </div>
    </div>
  );
}

/** 16-slot visual capacity gauge for a wallet's active mandates, or an explicit "unknown" state. */
export function SlotGauge({ active, max }: { active: number | null; max: number }) {
  if (active === null) {
    return (
      <div className="slot-gauge-wrap">
        <div className="slot-gauge slot-gauge-unknown" aria-hidden="true">
          {Array.from({ length: max }, (_, i) => (
            <span key={i} className="slot-cell slot-cell-unknown" />
          ))}
        </div>
        <span className="slot-gauge-label mono">unknown / {max}</span>
      </div>
    );
  }
  const warn = active >= max - 2;
  return (
    <div className="slot-gauge-wrap">
      <div className={warn ? "slot-gauge slot-gauge-warn" : "slot-gauge"} aria-hidden="true">
        {Array.from({ length: max }, (_, i) => (
          <span key={i} className={i < active ? "slot-cell slot-cell-on" : "slot-cell"} />
        ))}
      </div>
      <span className="slot-gauge-label mono">
        {active} / {max}
      </span>
    </div>
  );
}

/**
 * Creator payments-per-period bar chart built strictly from the real counts
 * already read by loadCreator (paidThisPeriod and paidLastPeriod).
 */
export function CreatorChart({ plans, counts }: { plans: Plan[]; counts: PlanCounts[] }) {
  const maxVal = counts.reduce((acc, c) => Math.max(acc, c.paidThisPeriod, c.paidLastPeriod), 0);
  const totalThis = counts.reduce((acc, c) => acc + c.paidThisPeriod, 0);
  const totalLast = counts.reduce((acc, c) => acc + c.paidLastPeriod, 0);
  return (
    <section className="card creator-chart" aria-labelledby="cchart-title">
      <div className="creator-chart-head">
        <div>
          <h2 id="cchart-title">Payments per period</h2>
          <p className="muted small">
            {thousands(totalThis)} this period · {thousands(totalLast)} the period before, across {thousands(plans.length)}{" "}
            {plans.length === 1 ? "plan" : "plans"}
          </p>
        </div>
        <div className="creator-chart-legend mono" aria-hidden="true">
          <span className="cap-legend-item">
            <span className="cap-swatch cap-swatch-price" />
            This period
          </span>
          <span className="cap-legend-item">
            <span className="cap-swatch cap-swatch-prev" />
            Last period
          </span>
        </div>
      </div>
      {maxVal === 0 ? (
        <p className="muted small creator-chart-empty">No payments recorded in the current or previous period yet.</p>
      ) : (
        <ul className="creator-chart-list">
          {plans.map((p, i) => {
            const c = counts[i];
            const thisPct = Math.round((c.paidThisPeriod / maxVal) * 100);
            const lastPct = Math.round((c.paidLastPeriod / maxVal) * 100);
            return (
              <li key={p.id.toString()} className="creator-chart-row">
                <div className="creator-chart-label">
                  <a href={`#/plan/${p.id}`} className="creator-chart-title">
                    <span className="plan-num mono">#{p.id.toString()}</span> {p.title}
                  </a>
                  <span className="creator-chart-nums mono">
                    {thousands(c.paidThisPeriod)} this · {thousands(c.paidLastPeriod)} last
                  </span>
                </div>
                <div className="creator-chart-tracks" aria-hidden="true">
                  <div className="creator-track">
                    <span className="creator-bar creator-bar-this" style={{ width: `${c.paidThisPeriod > 0 ? Math.max(4, thisPct) : 0}%` }} />
                  </div>
                  <div className="creator-track creator-track-last">
                    <span className="creator-bar creator-bar-last" style={{ width: `${c.paidLastPeriod > 0 ? Math.max(4, lastPct) : 0}%` }} />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * The calm state while the realm is deployed but parked until the network's
 * approver enables it (or not there at all). Never an error: nothing is wrong.
 */
export function NotLive({ status }: { status: PackageStatus }) {
  const gpas = pkgStatusPage();
  const parked = status.status === "inert";
  return (
    <section className="notlive card" aria-labelledby="notlive-title">
      <div className="notlive-rail">
        <span className="notlive-beacon">
          <span className="status-dot status-dot-signal" aria-hidden="true" />
          <span className="mono">{parked ? "Waiting for approval" : "Not published yet"}</span>
        </span>
        <span className="notlive-net mono">{config.networkName}</span>
      </div>
      <div className="notlive-body">
        <div className="notlive-mark" aria-hidden="true">
          <Icon name="clock" />
        </div>
        <div className="notlive-copy">
          <h2 id="notlive-title">{parked ? "Deployed, waiting for the network’s approval" : "Not on this network yet"}</h2>
          {parked ? (
            <p>
              Mandate is on the {config.networkName}, but new code there stays parked until the network’s package approver enables it. Until then nobody
              can read or use it, so there are no plans to show yet. Nothing is wrong, and nothing is needed from you: this page fills itself the
              moment the approval lands.
            </p>
          ) : (
            <p>Mandate has not been published on the {config.networkName} yet.</p>
          )}
        </div>
      </div>
      <ul className="notlive-links">
        <li>
          <a href="#/how" className="notlive-link">
            <span>
              <strong>How Mandate works</strong>
              <span className="muted small">, in two minutes</span>
            </span>
            <Icon name="arrow-right" />
          </a>
        </li>
        {gpas && parked && (
          <li>
            <a href={gpas} target="_blank" rel="noreferrer noopener" className="notlive-link ext">
              <span>The approval status</span>
              <Icon name="external" />
            </a>
          </li>
        )}
        <li>
          <a href={config.sourceUrl} target="_blank" rel="noreferrer noopener" className="notlive-link ext">
            <span>The source code</span>
            <Icon name="external" />
          </a>
        </li>
      </ul>
      <div className="notlive-realm">
        <span className="console-kicker">Realm path</span>
        <p className="muted small mono break">{config.realmPath}</p>
      </div>
    </section>
  );
}
