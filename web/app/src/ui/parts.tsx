import { type CSSProperties, type ReactNode } from "react";
import { config, explorerAccount, pkgStatusPage } from "../config";
import type { Mandate, Plan } from "../lib/amino";
import { date, gnot, period, shortAddr, thousands, windowCounts } from "../lib/format";
import { ReadError, type PackageStatus } from "../lib/rpc";
import { DecodeError } from "../lib/amino";
import { buildMandateTimeline, scaleBarHeight, scaleCapMeter, type MandateTimelineStatus } from "./mandateView";
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
 * Visual cap meter: draws the plan's price and the collector's fee allowance
 * proportionally inside the cap, with a minimum visible sliver when needed
 * (explicitly marked "not to scale"), and the blocked zone beyond the cap
 * that the chain refuses.
 */
export function CapMeter({ amount, feeAllowance, periodSec }: { amount: bigint; feeAllowance: bigint; periodSec: bigint }) {
  const cap = amount + feeAllowance;
  const { pricePct, feePct, beyondPct, notToScale } = scaleCapMeter(amount, feeAllowance);
  const style = {
    "--price-n": pricePct,
    "--fee-n": feePct,
    "--beyond-n": beyondPct,
  } as CSSProperties;
  return (
    <div className="cap-meter" style={style}>
      <div className="cap-meter-head">
        <span className="console-kicker">Cap per {period(periodSec)}</span>
        <span className="cap-meter-head-right">
          {notToScale && <span className="scale-note mono">not to scale</span>}
          <span className="cap-meter-ceiling mono">Cap {gnot(cap)} GNOT</span>
        </span>
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
 * before subscribing. Explicitly labelled as an example or a preview; all drawn
 * bars stay visible at every width so the footer always matches what is shown.
 */
export function RhythmStrip({
  kicker,
  amount,
  cap,
  periodLabel,
  endLabel,
  ticks,
  totalPossible,
  wide = false,
}: {
  kicker: string;
  amount: bigint;
  cap: bigint;
  periodLabel: string;
  endLabel?: string;
  ticks: string[];
  totalPossible?: bigint;
  wide?: boolean;
}) {
  const { heightPct, notToScale } = scaleBarHeight(amount, cap);
  const shown = ticks.length;
  const extra = totalPossible !== undefined && totalPossible > BigInt(shown) ? totalPossible - BigInt(shown) : 0n;
  return (
    <div className={`rhythm rhythm-preview${wide ? " rhythm-wide" : ""}`} aria-hidden="true">
      <div className="rhythm-top">
        <span className="rhythm-cap-tag mono">Cap {gnot(cap)} GNOT</span>
        <span className="rhythm-cadence mono">
          {kicker} · {gnot(amount)} GNOT / {periodLabel}
          {endLabel ? ` · until ${endLabel}` : ""}
          {notToScale ? " · not to scale" : ""}
        </span>
      </div>
      <div className="rhythm-stage">
        <div className="rhythm-overband" />
        <div className="rhythm-ceiling" />
        <div className="rhythm-bars" style={{ "--cols": shown } as CSSProperties}>
          {ticks.map((t, i) => (
            <div key={t} className="rhythm-col" style={{ "--i": i, "--h-n": heightPct } as CSSProperties}>
              <span className="rhythm-bar">
                <span className="rhythm-bar-cap" />
              </span>
              <span className="rhythm-tick mono">{t}</span>
            </div>
          ))}
        </div>
      </div>
      {totalPossible !== undefined && (
        <div className="rhythm-foot mono">
          {extra > 0n
            ? `Showing ${shown} of up to ${thousands(totalPossible)} possible payments (+${thousands(extra)} more)`
            : `Up to ${thousands(totalPossible)} possible ${totalPossible === 1n ? "payment" : "payments"} before ${endLabel ?? "the end"}`}
        </div>
      )}
    </div>
  );
}

/**
 * Facts-only view of a real mandate:
 * 1. Payments made = m.pulls (latest 6 marks + "+N earlier"). Never inferred from dates.
 * 2. Now = paid until <date> (or carried over), payment due, or inactive state.
 * 3. Still possible before end = only when active; reason when stopped/cancelled/expired.
 */
export function MandatePeriods({
  m,
  now,
  status,
  cap,
  permissionExpiresAt,
}: {
  m: Mandate;
  now: bigint;
  status: MandateTimelineStatus;
  cap: bigint | null;
  permissionExpiresAt?: bigint;
}) {
  const model = buildMandateTimeline({
    pulls: m.pulls,
    period: m.period,
    nextPullAt: m.nextPullAt,
    paidThrough: m.paidThrough,
    expiresAt: m.expiresAt,
    now,
    status,
    permissionExpiresAt,
  });
  const effectiveStatus: MandateTimelineStatus = status === "active" && now >= m.expiresAt ? "expired" : status;
  const tone = effectiveStatus === "active" ? "ok" : effectiveStatus === "stopped" || effectiveStatus === "permission-expired" ? "warn" : "off";
  const activeCap = effectiveStatus === "active" ? cap : null;

  return (
    <div className={`mandate-timeline mandate-timeline-${tone}`}>
      <p className="sr-only">{model.summaryText}</p>
      <div className="mt-head mono" aria-hidden="true">
        <span>{activeCap !== null ? `Cap ${gnot(activeCap)} GNOT` : "No active permission"}</span>
        <span className="muted">Ends {date(m.expiresAt)}</span>
      </div>
      <div className="mt-grid" aria-hidden="true">
        <div className="mt-section">
          <span className="mt-label mono">Payments made</span>
          <div className="mt-marks">
            {model.paidEarlier > 0n && <span className="mt-overflow mono">+{thousands(model.paidEarlier)} earlier</span>}
            {model.paidMarks > 0 ? (
              Array.from({ length: model.paidMarks }, (_, i) => (
                <span key={i} className="mt-mark mt-mark-paid">
                  <span className="mt-mark-glyph">✓</span>
                </span>
              ))
            ) : (
              <span className="mt-empty mono">{model.paidSummary}</span>
            )}
          </div>
        </div>

        <div className="mt-section mt-section-now">
          <span className="mt-label mono">Now</span>
          <span className={`mt-now mt-now-${model.nowState.kind} mono`}>{model.nowState.label}</span>
        </div>

        <div className="mt-section mt-section-possible">
          <span className="mt-label mono">Still possible before end</span>
          {effectiveStatus === "active" ? (
            model.possibleMarks > 0 ? (
              <div className="mt-marks">
                {Array.from({ length: model.possibleMarks }, (_, i) => (
                  <span key={i} className="mt-mark mt-mark-possible" />
                ))}
                {model.possibleMore > 0n && <span className="mt-overflow mono">+{thousands(model.possibleMore)} more</span>}
              </div>
            ) : (
              <span className="mt-empty mono">0 possible before {date(m.expiresAt)}</span>
            )
          ) : (
            <span className="mt-reason small">{model.stoppedReason}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** 16-slot visual capacity gauge for a wallet's active mandates, with floor display when history is incomplete. */
export function SlotGauge({ active, max, incomplete = false }: { active: number; max: number; incomplete?: boolean }) {
  const warn = active >= max - 2;
  const filled = Math.min(max, Math.max(0, active));
  return (
    <div className="slot-gauge-wrap">
      <div className={warn ? "slot-gauge slot-gauge-warn" : "slot-gauge"} aria-hidden="true">
        {Array.from({ length: max }, (_, i) => (
          <span
            key={i}
            className={i < filled ? "slot-cell slot-cell-on" : incomplete ? "slot-cell slot-cell-unknown" : "slot-cell"}
          />
        ))}
      </div>
      <span className="slot-gauge-label mono">
        {incomplete ? `at least ${active}` : active} / {max}
      </span>
    </div>
  );
}

/**
 * Creator payments bar chart built strictly from the real counts in each
 * plan as read (paidThisPeriod and paidLastPeriod, counted in the realm's
 * fixed windows that began at periodStart).
 */
export function CreatorChart({ plans }: { plans: Plan[] }) {
  const maxVal = plans.reduce((acc, p) => Math.max(acc, p.paidThisPeriod, p.paidLastPeriod), 0);
  return (
    <section className="card creator-chart" aria-labelledby="cchart-title">
      <div className="creator-chart-head">
        <div>
          <h2 id="cchart-title">Payments by counting window</h2>
          <p className="muted small">
            In each plan’s current counting window and the one before, across {thousands(plans.length)} {plans.length === 1 ? "plan" : "plans"}. A window is
            one period of the plan on the UTC clock, the same for every supporter: not anyone’s paid period.
          </p>
        </div>
        <div className="creator-chart-legend mono" aria-hidden="true">
          <span className="cap-legend-item">
            <span className="cap-swatch cap-swatch-price" />
            Current window
          </span>
          <span className="cap-legend-item">
            <span className="cap-swatch cap-swatch-prev" />
            Window before
          </span>
        </div>
      </div>
      {maxVal === 0 ? (
        <p className="muted small creator-chart-empty">No payments recorded in any plan’s current or previous counting window yet.</p>
      ) : (
        <ul className="creator-chart-list">
          {plans.map((p) => {
            const thisPct = Math.round((p.paidThisPeriod / maxVal) * 100);
            const lastPct = Math.round((p.paidLastPeriod / maxVal) * 100);
            return (
              <li key={p.id.toString()} className="creator-chart-row">
                <div className="creator-chart-label">
                  <a href={`#/plan/${p.id}`} className="creator-chart-title">
                    <span className="plan-num mono">#{p.id.toString()}</span> {p.title}
                  </a>
                  <span className="creator-chart-nums mono">
                    {windowCounts(p.paidThisPeriod, p.paidLastPeriod, p.periodStart, p.period)}
                  </span>
                </div>
                <div className="creator-chart-tracks" aria-hidden="true">
                  <div className="creator-track">
                    <span className="creator-bar creator-bar-this" style={{ width: `${p.paidThisPeriod > 0 ? Math.max(4, thisPct) : 0}%` }} />
                  </div>
                  <div className="creator-track creator-track-last">
                    <span className="creator-bar creator-bar-last" style={{ width: `${p.paidLastPeriod > 0 ? Math.max(4, lastPct) : 0}%` }} />
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
