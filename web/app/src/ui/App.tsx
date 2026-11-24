import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from "react";
import { config } from "../config";
import { shortAddr } from "../lib/format";
import { parseRoute, useRoute, useTheme, type Theme } from "./hooks";
import { LiveProvider } from "./live";
import { PendingNotices } from "./actions";
import { AllPlans, Creator, Home, How, Mine, PlanPage } from "./pages";
import { Icon } from "./parts";
import { PriceFootnote } from "./price";
import { useWallet, WalletProvider } from "./WalletContext";

function NotFound() {
  return (
    <section className="notfound card" aria-labelledby="notfound-title">
      <div className="notfound-rail">
        <span className="console-kicker">
          <span className="status-dot status-dot-signal" aria-hidden="true" />
          404 · Page not found
        </span>
      </div>
      <div className="notfound-body">
        <p className="notfound-code mono" aria-hidden="true">
          404
        </p>
        <div>
          <h1 id="notfound-title">This page does not exist.</h1>
          <p className="muted">Check the address in your browser, or start from the home page or the list of plans.</p>
          <div className="hero-actions">
            <a className="btn btn-primary" href="#/">
              Go to the start
            </a>
            <a className="btn btn-quiet" href="#/plans">
              See all plans
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function Routes() {
  const { path, query } = parseRoute(useRoute());
  let m: RegExpExecArray | null;
  const page = Math.max(1, Number.parseInt(query.get("page") ?? "1", 10) || 1);
  if (path === "/" || path === "") return <Home />;
  if (path === "/plans") return <AllPlans page={page} />;
  if (path === "/how") return <How />;
  if (path === "/mine") return <Mine address={query.get("a") ?? ""} />;
  if (path === "/creator") return <Creator address="" />;
  if ((m = /^\/plan\/([^/]+)$/.exec(path))) return <PlanPage id={m[1]} />;
  if ((m = /^\/creator\/([^/]+)$/.exec(path))) return <Creator address={m[1]} />;
  return <NotFound />;
}

function titleFor(path: string): string {
  const site = "Mandate";
  let m: RegExpExecArray | null;
  if (path === "/" || path === "") return `${site} · subscriptions on GNOT with a cap you set`;
  const fixed: Record<string, string> = { "/plans": "All plans", "/how": "How it works", "/mine": "My mandates", "/creator": "Creator" };
  if (fixed[path]) return `${fixed[path]} · ${site}`;
  if ((m = /^\/plan\/(\d+)$/.exec(path))) return `Plan #${m[1]} · ${site}`;
  if ((m = /^\/creator\/(g1[0-9a-z]{38})$/.exec(path))) return `Creator ${shortAddr(m[1])} · ${site}`;
  return `Page not found · ${site}`;
}

/** New title, back to the top and focus on main after each route change (not the first). */
function PageFrame() {
  const { path } = parseRoute(useRoute());
  const first = useRef(true);
  useEffect(() => {
    document.title = titleFor(path);
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo(0, 0);
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [path]);
  return (
    <div key={path} className="page-enter">
      <Routes />
    </div>
  );
}

function NavLink({ to, children }: { to: string; children: string }) {
  const { path } = parseRoute(useRoute());
  const active = to === "/" ? path === "/" || path === "" : path === to || path.startsWith(to + "/");
  return (
    <a href={`#${to}`} className={active ? "nav-link active" : "nav-link"} aria-current={active ? "page" : undefined}>
      {children}
    </a>
  );
}

function ThemeButton() {
  const [theme, setTheme] = useTheme();
  const next: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
  const label: Record<Theme, string> = { system: "Theme: follows your system", light: "Theme: light", dark: "Theme: dark" };
  const icon = theme === "light" ? "sun" : theme === "dark" ? "moon" : "auto";
  return (
    <button type="button" className="btn btn-quiet icon-btn" onClick={() => setTheme(next[theme])} aria-label={`${label[theme]}. Change theme`} title={label[theme]}>
      <Icon name={icon} />
    </button>
  );
}

function WalletButton() {
  const w = useWallet();
  if (!w.installed)
    return (
      <a className="btn btn-quiet" href="https://adena.app" target="_blank" rel="noreferrer noopener">
        Get Adena
      </a>
    );
  if (!w.address)
    return (
      <button type="button" className="btn btn-quiet" onClick={() => void w.connect()} disabled={w.busy}>
        Connect wallet
      </button>
    );
  if (!w.onRightNetwork)
    return (
      <button type="button" className="btn btn-quiet btn-signal" onClick={() => void w.switchNetwork()} disabled={w.busy}>
        Switch to {config.chainId}
      </button>
    );
  return (
    <a className="btn btn-quiet btn-wallet mono" href={`#/mine?a=${w.address}`} title={w.address}>
      <span className="status-dot status-dot-ok" aria-hidden="true" />
      {shortAddr(w.address)}
    </a>
  );
}

function Mark() {
  return (
    <svg className="brand-mark" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="26" height="26" rx="7" className="brand-mark-bg" />
      <path d="M6.5 7.5h15" className="brand-mark-cap" />
      <path d="M7.5 20.5v-8.5l6.5 5.5 6.5-5.5v8.5" className="brand-mark-m" />
    </svg>
  );
}

/** A value the page cannot show must not blank the whole page: this part says so and the rest stays. */
class Boundary extends Component<{ children: ReactNode; resetKey: string }, { failed: boolean; key: string }> {
  state = { failed: false, key: this.props.resetKey };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(p: { resetKey: string }, s: { failed: boolean; key: string }) {
    return p.resetKey !== s.key ? { failed: false, key: p.resetKey } : null;
  }
  componentDidCatch(_e: Error, _info: ErrorInfo) {
    /* shown below; nothing is sent anywhere */
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="error-card card" role="alert" aria-labelledby="boundary-title">
        <div className="error-card-rail">
          <span className="error-card-beacon mono">
            <span className="status-dot status-dot-danger" aria-hidden="true" />
            Display error
          </span>
        </div>
        <div className="error-card-body">
          <div className="error-card-mark" aria-hidden="true">
            <Icon name="alert" />
          </div>
          <div>
            <h1 id="boundary-title">This page could not be shown</h1>
            <p>
              Something on this page could not be shown: the chain returned a value this page does not understand. If you were approving something in Adena,
              look at <a href="#/mine">your mandates</a> before repeating it. Or <a href="#/">go to the start page</a>.
            </p>
            <div className="confirm-actions">
              <a className="btn btn-primary" href="#/mine">
                My mandates
              </a>
              <a className="btn btn-quiet" href="#/">
                Go to the start
              </a>
            </div>
          </div>
        </div>
      </section>
    );
  }
}

function Shell() {
  const w = useWallet();
  const route = useRoute();
  return (
    <>
      {/* the page routes by the hash, so the skip link moves focus itself instead of changing the hash */}
      <a
        className="skip"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="top">
        <div className="top-inner">
          <a className="brand" href="#/" translate="no">
            <Mark />
            <span className="brand-name">Mandate</span>
          </a>
          <nav className="nav" aria-label="Main">
            <NavLink to="/plans">Plans</NavLink>
            <NavLink to="/mine">My mandates</NavLink>
            <NavLink to="/creator">Creators</NavLink>
            <NavLink to="/how">How it works</NavLink>
          </nav>
          <div className="top-tools">
            <span className="net">
              <span className="status-dot status-dot-accent" aria-hidden="true" />
              {config.networkName} · test GNOT
            </span>
            <ThemeButton />
            <WalletButton />
          </div>
        </div>
        {w.error && (
          <div className="top-alert-wrap">
            <div className="notice notice-error top-alert" role="alert">
              <Icon name="alert" />
              <p>{w.error}</p>
            </div>
          </div>
        )}
      </header>
      <main id="main" tabIndex={-1}>
        <Boundary resetKey={route}>
          <PendingNotices />
          <PageFrame />
        </Boundary>
      </main>
      <footer className="foot">
        <div className="foot-inner">
          <div className="foot-row">
            <p className="foot-note">
              <span className="status-dot status-dot-signal" aria-hidden="true" />
              Mandate runs on the {config.networkName} with test GNOT. Nothing here is real money.
            </p>
            <p className="foot-links">
              <a href={config.sourceUrl} target="_blank" rel="noreferrer noopener" className="ext">
                Source code <Icon name="external" />
              </a>
            </p>
          </div>
          <PriceFootnote />
        </div>
      </footer>
    </>
  );
}

export function App() {
  return (
    <WalletProvider>
      <LiveProvider>
        <Shell />
      </LiveProvider>
    </WalletProvider>
  );
}
