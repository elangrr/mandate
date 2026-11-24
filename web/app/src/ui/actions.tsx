import { useRef, useState, type ReactNode } from "react";
import { config, explorerTx, gnowebPage, rules } from "../config";
import type { Mandate, Plan } from "../lib/amino";
import { date, dateTime, gnot, period } from "../lib/format";
import { isActive, permissionFits, removeCheck, stopCheck, stopState, subscribeState, type ChainView, type FreshKey, type SubscribeState } from "../lib/flows";
import { invalidate, read, type SessionEntry } from "../lib/rpc";
import {
  buildCancel,
  buildCreateSession,
  buildRevokeSession,
  buildSubscribe,
  collectorKeyProblem,
  doContractParams,
  fromBase64,
  gasFor,
  type Gas,
  type Msg,
} from "../lib/tx";
import { send, WalletError } from "../lib/wallet";
import { useAsync } from "./hooks";
import { Icon, Loading, ReadFailed } from "./parts";
import { useWallet } from "./WalletContext";

const DAY = 86_400n;

// ------------------------------------------------------------------ running approvals

/**
 * Where one approval stands. A step is done only when the chain shows its
 * result (the permission or the mandate read back), never on the wallet's
 * word alone; "pending" means the wallet sent it and the chain does not show
 * it yet.
 */
type StepState = "waiting" | "wallet" | "block" | "done" | "failed" | "pending";
interface Step {
  label: string;
  state: StepState;
  hash?: string;
}

/** One approval: what to sign, and how to see on chain that it happened. */
interface StepPlan {
  label: string;
  messages: () => Msg[];
  gas: Gas;
  /** reads the chain afresh; true once the step's result is there */
  onChain: () => Promise<boolean>;
}

const STEP_NOTE: Record<StepState, string> = {
  waiting: "",
  wallet: ": waiting for your approval in Adena",
  block: ": waiting for the network to include it",
  done: ": done",
  failed: ": not done",
  pending: ": sent, not on chain yet",
};

function Steps({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="steps-run">
      {steps.map((s, i) => (
        <li key={i} className={`step-run step-${s.state}`}>
          <span className="step-dot" aria-hidden="true">
            {s.state === "done" ? <Icon name="check" /> : s.state === "failed" ? <Icon name="alert" /> : s.state === "pending" ? <Icon name="clock" /> : i + 1}
          </span>
          <span>
            {s.label}
            <span className="visually-hidden">{STEP_NOTE[s.state]}</span>
            {s.state === "wallet" && <span className="muted small"> · approve it in Adena</span>}
            {s.state === "block" && <span className="muted small"> · waiting for the network</span>}
            {s.state === "pending" && <span className="muted small"> · sent, not on chain yet</span>}
            {s.hash && (
              <>
                {" "}
                <a href={explorerTx(s.hash)} target="_blank" rel="noreferrer noopener" className="ext small">
                  transaction <Icon name="external" />
                </a>
              </>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads the chain until `check` holds or `ms` have passed. */
async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    invalidate();
    try {
      if (await check()) return true;
    } catch {
      /* a failed read is retried until the deadline */
    }
    if (Date.now() >= until) return false;
    await sleep(Math.min(1500, Math.max(0, until - Date.now())));
  }
}

type RunResult = "done" | "partial" | "failed" | "changed" | "pending";

/**
 * Runs approvals in order. Each approval opens only after the one before is
 * on chain. Keeps the steps, a message for the polite live region, an error
 * (role=alert) and the pending state, and never lets an exception escape.
 */
function useRunner() {
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{ check: () => Promise<boolean>; rest: StepPlan[]; tries: number } | null>(null);
  const busyRef = useRef(false);

  async function runSteps(signer: string, plan: StepPlan[], s: Step[]): Promise<RunResult> {
    for (let i = 0; i < plan.length; i++) {
      const k = i;
      s[k] = { ...s[k], state: "wallet" };
      setSteps([...s]);
      setMessage(`${plan[i].label}: approve it in Adena.`);
      let hash: string | null = null;
      try {
        const out = await send(signer, doContractParams(plan[i].messages(), plan[i].gas));
        hash = out.hash;
      } catch (e) {
        s[k] = { ...s[k], state: "failed" };
        setSteps([...s]);
        const before = s.slice(0, k).filter((x) => x.state === "done");
        if (e instanceof WalletError && e.kind === "rejected" && before.length > 0)
          setError(`You cancelled “${plan[i].label}” in Adena, so it was not sent. What went through before stays on chain: ${before.map((x) => `“${x.label}”`).join(", ")}. The page now shows what is left.`);
        else setError(e instanceof Error ? e.message : "Adena could not complete this.");
        return "failed";
      }
      s[k] = { ...s[k], state: "block", hash: hash ?? undefined };
      setSteps([...s]);
      setMessage(`${plan[i].label}: sent. Waiting until the chain shows it.`);
      if (!(await waitFor(plan[i].onChain, config.confirmWaitMs))) {
        s[k] = { ...s[k], state: "pending" };
        setSteps([...s]);
        setPending({ check: plan[i].onChain, rest: plan.slice(i + 1), tries: 0 });
        setMessage(`${plan[i].label}: sent, but the chain does not show it yet.`);
        return "pending";
      }
      s[k] = { ...s[k], state: "done" };
      setSteps([...s]);
      setMessage(`${plan[i].label}: done.`);
    }
    return "done";
  }

  /**
   * prepare: reads the chain afresh and returns the approvals to run, or a
   * sentence saying what changed (then nothing is sent).
   */
  async function run(signer: string, prepare: () => Promise<StepPlan[] | string>): Promise<RunResult> {
    if (busyRef.current) return "failed";
    busyRef.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    setPending(null);
    try {
      let plan: StepPlan[] | string;
      try {
        invalidate();
        plan = await prepare();
      } catch {
        setError("Unable to read the chain just now. Nothing was sent; try again.");
        return "failed";
      }
      if (typeof plan === "string") {
        setSteps([]);
        setError(`${plan} Nothing was sent. The page now shows the current state.`);
        return "changed";
      }
      const s: Step[] = plan.map((p) => ({ label: p.label, state: "waiting" }));
      setSteps([...s]);
      return await runSteps(signer, plan, s);
    } catch {
      setError("Something went wrong on this page. Check the page before trying again: part of it may have gone through.");
      return "failed";
    } finally {
      invalidate();
      busyRef.current = false;
      setBusy(false);
    }
  }

  /**
   * The pending step: read the chain again. Once it is there the run ends; any
   * approval left is offered again from a fresh read (Finish subscribing, Cancel
   * it in Mandate), never sent from messages built before the wait.
   */
  async function checkAgain(): Promise<RunResult> {
    const p = pending;
    if (!p || busyRef.current) return "pending";
    busyRef.current = true;
    setBusy(true);
    try {
      if (!(await waitFor(p.check, 3000))) {
        setPending({ ...p, tries: p.tries + 1 });
        setMessage("Still not on chain.");
        return "pending";
      }
      setSteps((cur) => cur.map((x) => (x.state === "pending" ? { ...x, state: "done" } : x)));
      setPending(null);
      if (p.rest.length === 0) return "done";
      setMessage("It is on chain now. The next step is below.");
      return "partial";
    } catch {
      return "pending";
    } finally {
      invalidate();
      busyRef.current = false;
      setBusy(false);
    }
  }

  return {
    steps,
    busy,
    message,
    error,
    pending: pending !== null,
    pendingTries: pending?.tries ?? 0,
    setMessage,
    run,
    checkAgain,
    /** give up waiting: show the options again (repeating costs a network fee at most) */
    forget: () => setPending(null),
  };
}

type Runner = ReturnType<typeof useRunner>;

/** The live region, the steps, the error and the pending notice of one runner. */
function RunnerStatus({ r, after }: { r: Runner; after: (out: RunResult) => void }) {
  return (
    <>
      <div role="status" aria-live="polite" className="visually-hidden">
        {r.message}
      </div>
      <Steps steps={r.steps} />
      {r.error && (
        <div className="notice notice-error" role="alert">
          <Icon name="alert" />
          <p>{r.error}</p>
        </div>
      )}
      {r.pending && (
        <div className="notice notice-warn" role="alert">
          <Icon name="clock" />
          <div>
            <p>
              <strong>Sent, but not on chain yet.</strong> Adena sent it, and the network has not included it so far. Do not approve it again: wait a minute,
              then check.
            </p>
            {r.pendingTries > 0 && (
              <p className="small">
                Still not there. If it does not appear within a few minutes, it was most likely not included; repeating it then costs at most a network fee.
              </p>
            )}
            <div className="confirm-actions">
              <button type="button" className="btn btn-quiet" disabled={r.busy} onClick={() => void r.checkAgain().then(after)}>
                {r.busy ? "Checking the chain…" : "Check again"}
              </button>
              {r.pendingTries > 0 && (
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={r.busy}
                  onClick={() => {
                    r.forget();
                    after("failed");
                  }}
                >
                  Show the options again
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ wallet gate

/** Connect, install or switch network: what has to happen before any approval. */
function WalletGate({ children }: { children: (address: string) => ReactNode }) {
  const w = useWallet();
  if (!w.installed)
    return (
      <p className="notice">
        <Icon name="alert" />
        <span>
          Subscribing here needs the{" "}
          <a href="https://adena.app" target="_blank" rel="noreferrer noopener">
            Adena wallet
          </a>{" "}
          in this browser.
        </span>
      </p>
    );
  if (!w.address)
    return (
      <button type="button" className="btn btn-primary" onClick={() => void w.connect()} disabled={w.busy}>
        Connect wallet to subscribe
      </button>
    );
  if (!w.onRightNetwork)
    return (
      <div className="notice notice-warn">
        <Icon name="alert" />
        <div>
          <p>Adena is on another network. Mandate runs on the {config.networkName}.</p>
          <button type="button" className="btn btn-quiet" onClick={() => void w.switchNetwork()} disabled={w.busy}>
            Switch Adena to {config.chainId}
          </button>
        </div>
      </div>
    );
  return <>{children(w.address)}</>;
}

// ------------------------------------------------------------------ reads

/** How many of a wallet's history pages the page reads to count its active mandates (20 a page). */
const HISTORY_PAGES = 50;

/**
 * Everything subscribing depends on, read fresh from the chain: the plan and
 * the creator's collector key too, so the terms shown and the messages built
 * never come from an older read than the wallet's own state.
 */
async function loadView(shown: Plan, payer: string): Promise<ChainView> {
  const plan = (await read.plan(shown.id)) ?? shown;
  const payee = await read.payee(plan.payee);
  const key = payee?.collectorAddr ?? "";
  const [now, byKey, hasForPlan, history, sessions, paidThrough, balance, gasPrice, collectorIsAccount, keyProblem] = await Promise.all([
    read.chainTime(),
    key ? read.mandateOf(payer, key) : Promise.resolve(null),
    read.hasMandate(payer, plan.id),
    (async () => {
      const out: Mandate[] = [];
      for (let page = 1; page <= HISTORY_PAGES; page++) {
        const list = await read.mandatesOf(payer, page);
        out.push(...list);
        if (list.length < rules.pageSize) return { list: out, complete: true };
      }
      return { list: out, complete: false };
    })(),
    read.sessions(payer),
    read.paidThrough(payer, plan.id),
    read.balance(payer),
    read.gasPrice(),
    key ? read.accountExists(key) : Promise.resolve(false),
    payee?.collectorKey ? collectorKeyProblem(payee.collectorKey, payee.collectorAddr) : Promise.resolve(null),
  ]);
  const active = history.list.filter((m) => isActive(m, now));
  return {
    now,
    plan,
    payee,
    keyProblem,
    collectorIsAccount,
    byKey,
    hasForPlan,
    planMandate: active.find((m) => m.planId === plan.id) ?? null,
    activeCount: history.complete ? active.length : null,
    hasHistory: history.list.length > 0,
    sessions,
    paidThrough,
    balance,
    gasPrice,
  };
}

async function freshKey(payer: string, key: string): Promise<FreshKey> {
  const [now, byKey, sessions] = await Promise.all([read.chainTime(), read.mandateOf(payer, key), read.sessions(payer)]);
  return { now, byKey, sessions };
}

/** What changed between the terms on screen and the chain now, in words; null if nothing that matters. */
function changedSince(a: ChainView, sa: SubscribeState, b: ChainView, sb: SubscribeState): string | null {
  if (b.plan.amount !== a.plan.amount || b.plan.period !== a.plan.period) return "the plan’s price or period";
  if ((b.payee?.collectorKey ?? "") !== (a.payee?.collectorKey ?? "") || (b.payee?.collectorAddr ?? "") !== (a.payee?.collectorAddr ?? "")) return "the creator’s collector key";
  if (sb.kind !== sa.kind) return "what your wallet can do here";
  if (sa.kind === "ready" && sb.kind === "ready") {
    if (sa.resume !== sb.resume || sa.cap !== sb.cap || sa.session?.expiresAt !== sb.session?.expiresAt) return "your wallet’s permissions";
    if (sa.paidThrough !== sb.paidThrough) return "how long you have already paid for";
    // the end date shown is the one signed: it must still be allowed
    if (sa.end <= b.now + DAY || sa.end > b.now + BigInt(rules.maxTermDays) * DAY) return "the date";
  }
  return null;
}

/** One approval for both messages only when asked for (#…?approval=one, experimental); two otherwise. */
function oneApproval(): boolean {
  return /[?&]approval=one\b/.test(window.location.hash);
}

// ------------------------------------------------------------------ subscribe

export function SubscribePanel({ plan }: { plan: Plan }) {
  return <WalletGate>{(address) => <SubscribeFor plan={plan} payer={address} />}</WalletGate>;
}

function SubscribeFor({ plan: shown, payer }: { plan: Plan; payer: string }) {
  const [tick, setTick] = useState(0);
  const [view, reload] = useAsync(() => loadView(shown, payer), [shown.id, payer, tick]);
  const r = useRunner();
  const [done, setDone] = useState(false);
  const refresh = () => {
    invalidate();
    setTick((t) => t + 1);
  };
  if (view.status === "loading" && r.steps.length === 0 && !r.error) return <Loading what="your wallet’s permissions" />;
  if (view.status === "error") return <ReadFailed error={view.error} retry={reload} />;
  const v = view.status === "ready" ? view.value : null;
  const st: SubscribeState | null = v ? subscribeState(v) : null;
  const plan = v?.plan ?? shown;

  /** The permission for the collector key is on chain with the plan's terms. */
  const permissionOnChain = (key: string, p: Plan) => async () => {
    const s = (await read.sessions(payer)).find((x) => x.address === key);
    return !!s && permissionFits(s, p, await read.chainTime()) === null;
  };
  /** The mandate for this plan is recorded and active for the collector key. */
  const mandateOnChain = (key: string, p: Plan) => async () => {
    const m = await read.mandateOf(payer, key);
    return !!m && m.planId === p.id && isActive(m, await read.chainTime());
  };
  const permissionGone = (key: string) => async () => !(await read.sessions(payer)).some((x) => x.address === key);

  async function subscribe(shownState: Extract<SubscribeState, { kind: "ready" }>) {
    const shownView = v!;
    const out = await r.run(payer, async () => {
      // read the chain once more right before the first popup
      const fresh = await loadView(plan, payer);
      const state = subscribeState(fresh);
      const what = changedSince(shownView, shownState, fresh, state);
      if (what || state.kind !== "ready") return `Something changed on chain since this page was read (${what ?? "what your wallet can do here"}).`;
      const gp = fresh.gasPrice;
      const p = fresh.plan;
      const key = fresh.payee!;
      const end = shownState.end; // the date shown is the date signed
      const session = () => buildCreateSession({ creator: payer, collectorKey: key.collectorKey, plan: p, expiresAt: end });
      const sub = () => buildSubscribe({ payer, planId: p.id, sessionAddr: key.collectorAddr, expiresAt: end });
      if (state.resume) return [{ label: "Record the terms in Mandate", messages: () => [sub()], gas: gasFor("call", gp), onChain: mandateOnChain(key.collectorAddr, p) }];
      if (oneApproval())
        return [
          {
            label: "Give the permission and record the terms (one approval)",
            messages: () => [session(), sub()],
            gas: gasFor("sessionAndCall", gp),
            onChain: mandateOnChain(key.collectorAddr, p),
          },
        ];
      return [
        { label: "Give the permission (approval 1 of 2)", messages: () => [session()], gas: gasFor("session", gp), onChain: permissionOnChain(key.collectorAddr, p) },
        { label: "Record the terms in Mandate (approval 2 of 2)", messages: () => [sub()], gas: gasFor("call", gp), onChain: mandateOnChain(key.collectorAddr, p) },
      ];
    });
    if (out === "done") subscribed();
    refresh();
  }
  function subscribed() {
    setDone(true);
    r.setMessage("Subscribed. The creator’s collector takes the first payment when it is due.");
  }

  async function removePermission(s: SessionEntry) {
    await r.run(payer, async () => {
      const why = removeCheck(s.address, await freshKey(payer, s.address));
      if (why) return why;
      const pub = fromBase64(s.pubKey);
      const gp = await read.gasPrice();
      return [{ label: "Remove the permission", messages: () => [buildRevokeSession({ creator: payer, pub33: pub })], gas: gasFor("session", gp), onChain: permissionGone(s.address) }];
    });
    refresh();
  }

  const busy = r.busy || r.pending;
  const stoppedOnChain = st?.kind === "already" && st.permission === false;
  return (
    <div className="subscribe">
      <RunnerStatus
        r={r}
        after={(out) => {
          if (out === "done") subscribed();
          refresh();
        }}
      />
      {done && st?.kind === "already" && st.permission !== false && (
        <div className="notice notice-ok">
          <Icon name="check" />
          <p>
            You support this plan.{" "}
            {st.mandate && st.mandate.nextPullAt > (v?.now ?? 0n)
              ? `The first payment is due from ${dateTime(st.mandate.nextPullAt)}; the creator’s collector takes it on its next run after that.`
              : "The first payment is due now; the creator’s collector takes it on its next run."}{" "}
            <a href={`#/mine?a=${payer}`}>See your mandates</a>
          </p>
        </div>
      )}
      {(!done || stoppedOnChain || st?.kind !== "already") && st && (
        <SubscribeBody st={st} plan={plan} payer={payer} balance={v?.balance ?? 0n} busy={busy} busyLabel={r.busy ? "Working…" : "Waiting…"} onSubscribe={subscribe} onRemove={removePermission} />
      )}
    </div>
  );
}

function SubscribeBody({
  st,
  plan,
  payer,
  balance,
  busy,
  busyLabel,
  onSubscribe,
  onRemove,
}: {
  st: SubscribeState;
  plan: Plan;
  payer: string;
  balance: bigint;
  busy: boolean;
  busyLabel: string;
  onSubscribe: (s: Extract<SubscribeState, { kind: "ready" }>) => void;
  onRemove: (s: SessionEntry) => void;
}) {
  switch (st.kind) {
    case "blocked":
      return (
        <div className="notice notice-warn">
          <Icon name="alert" />
          <p>
            <strong>{st.title}.</strong> {st.reason}
          </p>
        </div>
      );
    case "already":
      if (st.permission === false)
        return (
          <div className="notice notice-warn">
            <Icon name="alert" />
            <p>
              <strong>Stopped on chain.</strong> Your mandate for this plan is recorded, but its permission is gone, so no payment can be taken.{" "}
              <a href={`#/mine?a=${payer}`}>Cancel it on your mandates page</a>, then subscribe again.
            </p>
          </div>
        );
      return (
        <div className="notice notice-ok">
          <Icon name="check" />
          <p>
            You support this plan{st.mandate && st.mandate.paidThrough > 0n ? `, paid through ${date(st.mandate.paidThrough)}` : ""}.{" "}
            <a href={`#/mine?a=${payer}`}>See or stop it</a>
          </p>
        </div>
      );
    case "fix-permission":
      return (
        <div className="notice notice-warn">
          <Icon name="alert" />
          <div>
            <p>{st.reason}</p>
            <button type="button" className="btn btn-quiet" onClick={() => onRemove(st.session)} disabled={busy}>
              Remove the old permission
            </button>
          </div>
        </div>
      );
    case "ready": {
      const leftover = st.leftover;
      const need = st.deposit + st.fees + plan.amount + rules.feeAllowanceUgnot;
      return (
        <div className="confirm">
          <p className="confirm-sentence">
            From this wallet: <strong>at most {gnot(st.cap)} GNOT every {period(plan.period)}</strong>, through Mandate only, until{" "}
            <strong>{date(st.end)}</strong>.
          </p>
          <ul className="confirm-list">
            <li>
              {st.paidThrough > 0n
                ? `You already paid for this plan until ${date(st.paidThrough)}: the first new payment is due then, and the creator’s collector takes it on its next run after that.`
                : `The first payment, ${gnot(plan.amount)} GNOT, is due as soon as the terms are recorded: the creator’s collector takes it on its next run.`}
            </li>
            <li>
              {st.resume
                ? "Your permission is already on chain: one approval records the terms."
                : oneApproval()
                  ? "One approval in Adena (experimental: not yet tried with the real wallet)."
                  : "Two approvals in Adena: the permission, then the terms. The second opens once the first is on chain."}{" "}
              Adena shows the exact network fee before you sign; expect about {gnot(st.fees)} GNOT in all, plus a storage deposit of about {gnot(st.deposit)} GNOT.
            </li>
          </ul>
          {st.lowBalance && (
            <p className="notice notice-warn">
              <Icon name="alert" />
              <span>
                This wallet has {gnot(balance)} GNOT. That covers the deposit and fees, but not also the first payment and the collector’s fee allowance: keep
                about {gnot(need)} GNOT in it, or the payment fails until you add more.
              </span>
            </p>
          )}
          {st.resume && leftover && (
            <p className="small muted">
              This permission is left from your earlier mandate for plan #{leftover.planId.toString()}, which{" "}
              {leftover.status === "cancelled" || leftover.cancelledAt > 0n ? "was cancelled" : "has ended"}. It ends on {date(st.end)}, so a new mandate on it
              ends then too. To start a full new term instead, remove it first.
            </p>
          )}
          {st.resume && !leftover && (
            <p className="small muted">
              Your wallet already gave this creator’s collector key the permission, but no mandate is recorded for it: a subscription was started and not
              finished. Finish it, or undo it by removing the permission.
            </p>
          )}
          <div className="confirm-actions">
            <button type="button" className="btn btn-primary" onClick={() => onSubscribe(st)} disabled={busy}>
              {busy
                ? busyLabel
                : st.resume
                  ? leftover
                    ? `Subscribe until ${date(st.end)}`
                    : "Finish subscribing"
                  : `Subscribe for ${gnot(plan.amount)} GNOT every ${period(plan.period)}`}
            </button>
            {st.resume && st.session && (
              <button type="button" className="btn btn-quiet" onClick={() => onRemove(st.session!)} disabled={busy}>
                {leftover ? "Remove it and start fresh" : "Undo: remove the permission"}
              </button>
            )}
          </div>
        </div>
      );
    }
  }
}

// ------------------------------------------------------------------ stop

export function StopControls({ m, all, payer, now, sessions, onChanged }: { m: Mandate; all: Mandate[]; payer: string; now: bigint; sessions: SessionEntry[]; onChanged: () => void }) {
  const w = useWallet();
  const r = useRunner();
  const [confirming, setConfirming] = useState(false);
  const st = stopState(m, all, sessions, now);
  if (st.kind === "nothing" && r.steps.length === 0 && !r.error) return null;
  const tidy = st.kind === "ready" && !st.cancel;
  const label = st.kind !== "ready" ? "" : st.cancel ? (st.session ? "Stop this mandate" : "Cancel it in Mandate") : "Remove the leftover permission";
  if (st.kind === "ready" && w.address !== payer)
    return (
      <p className="small muted">
        To {st.cancel ? "stop" : "tidy up"} this mandate, connect the wallet that gave it. Or run the commands on its{" "}
        <a href={gnowebPage(`payer/${payer}`)} target="_blank" rel="noreferrer noopener" className="ext">
          gnoweb page <Icon name="external" />
        </a>
      </p>
    );
  const sessionOf = (list: SessionEntry[]) => list.find((s) => s.address === m.session);
  async function stop() {
    const out = await r.run(payer, async () => {
      const fresh = await freshKey(payer, m.session);
      const c = stopCheck(m, fresh, tidy ? "tidy" : "stop");
      if (c.kind === "changed") return c.reason;
      const gp = await read.gasPrice();
      const revoked = async () => !sessionOf(await read.sessions(payer));
      const cancelled = async () => {
        const now2 = await read.chainTime();
        const x = await read.mandateOf(payer, m.session);
        return !x || x.id !== m.id || !isActive(x, now2);
      };
      const revoke = c.revoke ? () => [buildRevokeSession({ creator: payer, pub33: fromBase64(c.revoke!.pubKey) }) as Msg] : null;
      const cancel = c.cancel ? () => [buildCancel({ payer, sessionAddr: m.session }) as Msg] : null;
      if (revoke && cancel && oneApproval())
        return [
          {
            label: "Remove the permission and cancel (one approval)",
            messages: () => [...revoke(), ...cancel()],
            gas: gasFor("sessionAndCall", gp),
            onChain: async () => (await revoked()) && (await cancelled()),
          },
        ];
      return [
        ...(revoke ? [{ label: "Remove the permission: no payment can be taken any more", messages: revoke, gas: gasFor("session", gp), onChain: revoked }] : []),
        ...(cancel ? [{ label: "Cancel the mandate in Mandate", messages: cancel, gas: gasFor("call", gp), onChain: cancelled }] : []),
      ];
    });
    if (out === "done") r.setMessage(tidy ? "The leftover permission is removed." : "Stopped. No payment can be taken any more.");
    setConfirming(false);
    onChanged();
  }
  const session = st.kind === "ready" ? st.session : null;
  return (
    <div className="stop">
      <RunnerStatus
        r={r}
        after={(out) => {
          if (out === "done") r.setMessage(tidy ? "The leftover permission is removed." : "Stopped. No payment can be taken any more.");
          onChanged();
        }}
      />
      {st.kind === "ready" && tidy && session && (
        <p className="small">
          Its permission is still on chain{session.expiresAt > 0n ? ` until ${date(session.expiresAt)}` : ""}. No payment can go through without an active
          mandate, but the creator’s collector can still use it to call Mandate for this wallet and spend up to {gnot(session.spendLimit)} GNOT every{" "}
          {period(session.spendPeriod)} of yours on the network fees of those calls. Remove it unless you plan to subscribe again soon.
        </p>
      )}
      {st.kind === "ready" &&
        (!confirming ? (
          <button type="button" className="btn btn-quiet" onClick={() => setConfirming(true)} disabled={r.busy || r.pending}>
            <Icon name="stop" />
            {label}
          </button>
        ) : (
          <div className="confirm-inline" role="group" aria-label={`${label}?`}>
            <p>
              {st.cancel
                ? `Stop paying ${gnot(m.amount)} GNOT every ${period(m.period)}? ${st.session ? "Your permission is removed first, so no payment can be taken from then on; then the mandate is cancelled." : "Your permission is already gone; this cancels the mandate in Mandate."} Time you already paid for stays yours.`
                : "Remove the permission this mandate left behind?"}
            </p>
            <div className="confirm-actions">
              <button type="button" className="btn btn-danger" onClick={() => void stop()} disabled={r.busy || r.pending}>
                {r.busy ? "Working…" : label}
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => setConfirming(false)} disabled={r.busy}>
                Keep it
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}
