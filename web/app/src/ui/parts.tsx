import { type ReactNode } from "react";
import { config, explorerAccount, pkgStatusPage } from "../config";
import { gnot, shortAddr } from "../lib/format";
import { ReadError, type PackageStatus } from "../lib/rpc";
import { DecodeError } from "../lib/amino";
import { Usd } from "./price";

// One small icon set: 24-unit grid, 1.75 stroke, round caps, currentColor.
const PATHS = {
  sun: "M12 4V2.5M12 21.5V20M4 12H2.5M21.5 12H20M6.3 6.3 5.3 5.3M18.7 18.7l-1-1M6.3 17.7l-1 1M18.7 5.3l-1 1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z",
  auto: "M12 3a9 9 0 1 0 0 18V3Z M12 3a9 9 0 1 1 0 18",
  "arrow-right": "M5 12h14M13 6l6 6-6 6",
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
    <div className="notice notice-error" role="alert">
      <Icon name="alert" />
      <div>
        <p>{msg}</p>
        {retry && (
          <button type="button" className="btn btn-quiet" onClick={retry}>
            Try again
          </button>
        )}
      </div>
    </div>
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
      <div className="notlive-mark" aria-hidden="true">
        <Icon name="clock" />
      </div>
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
      <ul className="notlive-links">
        <li>
          <a href="#/how">How Mandate works</a>, in two minutes
        </li>
        {gpas && parked && (
          <li>
            <a href={gpas} target="_blank" rel="noreferrer noopener" className="ext">
              The approval status <Icon name="external" />
            </a>
          </li>
        )}
        <li>
          <a href={config.sourceUrl} target="_blank" rel="noreferrer noopener" className="ext">
            The source code <Icon name="external" />
          </a>
        </li>
      </ul>
      <p className="muted small mono">{config.realmPath}</p>
    </section>
  );
}
