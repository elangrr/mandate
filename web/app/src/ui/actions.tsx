import { useEffect, useRef, useState, type ReactNode } from "react";
import { config, explorerTx, gnowebPage, rules } from "../config";
import type { Mandate, Plan } from "../lib/amino";
import { date, dateTime, gnot, period } from "../lib/format";
import { isActive, permissionAllows, removeCheck, stopCheck, stopState, subscribeState, termsCheck, type ChainView, type FreshKey, type SubscribeState } from "../lib/flows";
import { invalidate, read, type SessionEntry } from "../lib/rpc";
import {
  buildCancel,
  buildCreateSession,
  buildRevokeSession,
  buildSubscribe,
  capFor,
  collectorKeyProblem,
  doContractParams,
  fromBase64,
  gasFor,
  type Gas,
  type Msg,
} from "../lib/tx";
import { allPending, clearPending, getPending, onChain, repeatAdvice, setPending, usePending, usePendingAll, type Pending, type PendingCheck } from "../lib/pending";
import { send, WalletError } from "../lib/wallet";
import { useAsync } from "./hooks";
import { Icon, Loading, ReadFailed } from "./parts";
import { useWallet } from "./WalletContext";

const DAY = 86_400n;

// ------------------------------------------------------------------ running approvals

/**
 * Where one approval stands. A step is done only when the chain shows its
 * result (the permission or the mandate read back), never on the wallet's
 * word alone; "pending" means it may have been sent and the chain does not
 * show it yet (kept in lib/pending.ts until it does).
 */
type StepState = "waiting" | "wallet" | "block" | "done" | "failed" | "pending";
interface Step {
  label: string;
  state: StepState;
  hash?: string;
}

/** One approval: what to sign, how to see on chain that it happened, and what to check again right before it. */
export interface StepPlan {
  label: string;
  messages: () => Msg[];
  gas: Gas;
  check: PendingCheck;
  /** read afresh right before this step (not the first: `prepare` did that); a sentence = what changed, send nothing */
  precheck?: () => Promise<string | null>;
}

const STEP_NOTE: Record<StepState, string> = {
  waiting: "",
  wallet: ": waiting for your approval in Adena",
  block: ": waiting for the network to include it",
  done: ": done",
  failed: ": not done",
  pending: ": not on chain yet",
};

const STEP_BADGE: Record<StepState, string> = {
  waiting: "Waiting",
  wallet: "Approve in Adena",
  block: "Waiting for network",
  done: "Done",
  failed: "Not done",
  pending: "Not on chain yet",
};

function Steps({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="steps-panel">
      <div className="steps-panel-head">
        <span className="console-kicker">Approval progress</span>
      </div>
      <ol className="steps-run">
        {steps.map((s, i) => (
          <li key={i} className={`step-run step-${s.state}`}>
            <span className="step-dot" aria-hidden="true">
              {s.state === "done" ? <Icon name="check" /> : s.state === "failed" ? <Icon name="alert" /> : s.state === "pending" ? <Icon name="clock" /> : i + 1}
            </span>
            <span className="step-main">
              <span className="step-label">{s.label}</span>
              <span className="visually-hidden">{STEP_NOTE[s.state]}</span>
              <span className="step-meta">
                <span className={`step-tag step-tag-${s.state} mono`} aria-hidden="true">
                  {STEP_BADGE[s.state]}
                </span>
                {s.hash && (
                  <a href={explorerTx(s.hash)} target="_blank" rel="noreferrer noopener" className="ext small">
                    transaction <Icon name="external" />
                  </a>
                )}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads the chain until `check` holds or `ms` have passed. Every read has its own time limit (rpc.ts). */
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

/** How long the page reads the chain after Adena reports "cancelled", in case its window was closed after the transaction went out. */
const AFTER_CANCEL_MS = 10_000;

/** "left": the page was left before the next approval, so it was not opened */
type RunResult = "done" | "failed" | "changed" | "pending" | "left";

const quote = (labels: string[]) => labels.map((l) => `“${l}”`).join(", ");

/**
 * Runs approvals in order. Each approval opens only after the one before is
 * on chain, and only if its fresh check still holds. Keeps the steps, a
 * message for the polite live region and an error (role=alert), and never
 * lets an exception escape.
 */
export function useRunner() {
  const [steps, setStepsNow] = useState<Step[]>([]);
  const [busy, setBusyNow] = useState(false);
  const [message, setMessageNow] = useState("");
  const [error, setErrorNow] = useState("");
  const busyRef = useRef(false);
  // Once the panel is gone (the page was left, another account connected), no new popup opens for it.
  // A step already sent is still watched, and recorded as pending if the chain does not show it in time.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const setSteps = (v: Step[]) => mounted.current && setStepsNow(v);
  const setBusy = (v: boolean) => mounted.current && setBusyNow(v);
  const setMessage = (v: string) => mounted.current && setMessageNow(v);
  const setError = (v: string) => mounted.current && setErrorNow(v);

  async function runSteps(signer: string, plan: StepPlan[], s: Step[]): Promise<RunResult> {
    const done = () => s.filter((x) => x.state === "done").map((x) => x.label);
    for (let k = 0; k < plan.length; k++) {
      const step = plan[k];
      const seen = () => onChain(signer, step.check);
      if (!mounted.current) return "left";
      if (k > 0 && step.precheck) {
        let unread = false;
        const why = await step.precheck().catch(() => {
          unread = true;
          return "Unable to read the chain just now.";
        });
        if (!mounted.current) return "left";
        if (why) {
          // what went before may have been undone meanwhile (a permission removed elsewhere): say only what is known now
          setError(`${why} So “${step.label}” was not sent. ${unread ? "Try again in a moment." : "The page now shows the current state."}`);
          return "changed";
        }
      }
      s[k] = { ...s[k], state: "wallet" };
      setSteps([...s]);
      setMessage(`${step.label}: approve it in Adena.`);
      let hash: string | null = null;
      try {
        hash = (await send(signer, doContractParams(step.messages(), step.gas))).hash;
      } catch (e) {
        if (e instanceof WalletError && e.kind === "rejected") {
          // Adena says "rejected" also when its window is closed after the transaction went out: look on chain first
          s[k] = { ...s[k], state: "block" };
          setSteps([...s]);
          setMessage(`${step.label}: Adena reports it cancelled. Checking the chain to be sure.`);
          if (await waitFor(seen, AFTER_CANCEL_MS)) {
            s[k] = { ...s[k], state: "done" };
            setSteps([...s]);
            setMessage(`${step.label}: done (it went out before Adena’s window closed).`);
            continue;
          }
          s[k] = { ...s[k], state: "failed" };
          setSteps([...s]);
          const before = done();
          setError(
            `You cancelled “${step.label}” in Adena, or closed its window, and the chain does not show it. ${repeatAdvice(step.check, "cancelled")}` +
              (before.length ? ` What went through before stays on chain: ${quote(before)}.` : ""),
          );
          return "failed";
        }
        s[k] = { ...s[k], state: "failed" };
        setSteps([...s]);
        const before = done();
        setError((e instanceof Error ? e.message : "Adena could not complete this.") + (before.length ? ` What went through before stays on chain: ${quote(before)}.` : ""));
        return "failed";
      }
      s[k] = { ...s[k], state: "block", hash: hash ?? undefined };
      setSteps([...s]);
      setMessage(`${step.label}: ${hash ? "sent" : "Adena did not say whether it was sent"}. Waiting until the chain shows it.`);
      if (!(await waitFor(seen, config.confirmWaitMs))) {
        s[k] = { ...s[k], state: "pending" };
        setSteps([...s]);
        setPending({ payer: signer, label: step.label, hash, check: step.check, tries: 0 });
        setMessage(`${step.label}: not on chain yet.`);
        return "pending";
      }
      s[k] = { ...s[k], state: "done" };
      setSteps([...s]);
      setMessage(`${step.label}: done.`);
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
    try {
      if (getPending(signer)) {
        setError("A step you approved earlier is not on chain yet. Check it first (at the top of the page).");
        return "failed";
      }
      let plan: StepPlan[] | string;
      try {
        invalidate();
        plan = await prepare();
      } catch {
        setError("Unable to read the chain just now. Nothing was sent; try again.");
        return "failed";
      }
      if (!mounted.current) return "left";
      if (typeof plan === "string") {
        setSteps([]);
        setError(`${plan} Nothing was sent. The page now shows the current state.`);
        return "changed";
      }
      const s: Step[] = plan.map((p) => ({ label: p.label, state: "waiting" }));
      setSteps([...s]);
      return await runSteps(signer, plan, s);
    } catch {
      setError("Something went wrong on this page. Look at the page again before repeating anything: part of it may have gone through.");
      return "failed";
    } finally {
      invalidate();
      busyRef.current = false;
      setBusy(false);
    }
  }

  return { steps, busy, message, error, setMessage: setMessageNow, run };
}

export type Runner = ReturnType<typeof useRunner>;

/** The live region, the steps and the error of one runner. */
export function RunnerStatus({ r }: { r: Runner }) {
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
    </>
  );
}

/**
 * The steps that may have been sent and are not on chain yet, at the top of
 * every page (they survive a reload, a network switch and leaving the page).
 * Dropped when the chain shows the result or another account is connected.
 */
export function PendingNotices() {
  const all = usePendingAll();
  const w = useWallet();
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    for (const p of all) if (w.address && w.address !== p.payer) clearPending(p.payer);
  }, [all, w.address]);
  useEffect(() => {
    // on arrival (a reload, another page) look once
    let stop = false;
    void (async () => {
      for (const p of allPending()) {
        invalidate();
        if (!stop && (await onChain(p.payer, p.check).catch(() => false))) clearPending(p.payer);
      }
    })();
    return () => {
      stop = true;
    };
  }, []);
  if (all.length === 0) return null;
  async function check(p: Pending) {
    setChecking(true);
    try {
      if (await waitFor(() => onChain(p.payer, p.check), 3000)) clearPending(p.payer);
      else setPending({ ...p, tries: p.tries + 1 });
    } finally {
      setChecking(false);
    }
  }
  return (
    <>
      {all.map((p) => (
        <div key={p.payer} className="notice notice-warn pending" role="alert">
          <Icon name="clock" />
          <div>
            <p>
              <strong>{p.hash ? "Sent, but not on chain yet:" : "Adena did not say whether this was sent:"}</strong> “{p.label}”. The chain does not show it so far.
              Do not approve it again: wait a minute, then check.
            </p>
            {p.tries > 0 && (
              <p className="small">Still not there. {repeatAdvice(p.check, "missing")}</p>
            )}
            <div className="confirm-actions">
              <button type="button" className="btn btn-quiet" disabled={checking} onClick={() => void check(p)}>
                {checking ? "Checking the chain…" : "Check again"}
              </button>
              {p.tries > 0 && (
                <button type="button" className="btn btn-quiet" disabled={checking} onClick={() => clearPending(p.payer)}>
                  Show the options again
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

// ------------------------------------------------------------------ wallet gate

/** Connect, install or switch network: what has to happen before any approval. `doing`: "subscribing", "publishing". */
export function WalletGate({ children, doing = "subscribing" }: { children: (address: string) => ReactNode; doing?: "subscribing" | "publishing" }) {
  const w = useWallet();
  if (!w.installed)
    return (
      <div className="notice wallet-gate-notice">
        <Icon name="alert" />
        <div>
          <p>
            {doing === "publishing" ? "Publishing" : "Subscribing"} here needs the{" "}
            <a href="https://adena.app" target="_blank" rel="noreferrer noopener" className="ext">
              Adena wallet <Icon name="external" />
            </a>{" "}
            in this browser.
          </p>
        </div>
      </div>
    );
  if (!w.address)
    return (
      <button type="button" className="btn btn-primary" onClick={() => void w.connect()} disabled={w.busy}>
        {doing === "publishing" ? "Connect wallet to publish" : "Connect wallet to subscribe"}
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
      for (let page = 1; page <= rules.historyPages; page++) {
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
    payer,
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
  // keyed on the account: nothing read or done for one account is ever shown for another
  return <WalletGate>{(address) => <SubscribeFor key={address} plan={plan} payer={address} />}</WalletGate>;
}

function SubscribeFor({ plan: shown, payer }: { plan: Plan; payer: string }) {
  const [tick, setTick] = useState(0);
  const pending = usePending(payer);
  // a pending step that the chain now shows (or that was given up) changes what can be done: read again
  const [view, reload] = useAsync(() => loadView(shown, payer), [shown.id, payer], [tick, pending ? 1 : 0]);
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
      const permissionCheck: PendingCheck = { kind: "permission", key: key.collectorAddr, period: p.period.toString(), cap: capFor(p).toString(), end: end.toString() };
      const mandateCheck: PendingCheck = { kind: "mandate", key: key.collectorAddr, planId: p.id.toString() };
      // right before the second approval: the plan, the collector key, the permission just given and the wallet's mandates are still as they were
      const stillSame = async () => {
        invalidate();
        return termsCheck(await loadView(plan, payer), { amount: p.amount, period: p.period, collectorKey: key.collectorKey, collectorAddr: key.collectorAddr, end });
      };
      if (state.resume) return [{ label: "Record the terms in Mandate", messages: () => [sub()], gas: gasFor("call", gp), check: mandateCheck }];
      if (oneApproval())
        return [{ label: "Give the permission and record the terms (one approval)", messages: () => [session(), sub()], gas: gasFor("sessionAndCall", gp), check: mandateCheck }];
      return [
        { label: "Give the permission (approval 1 of 2)", messages: () => [session()], gas: gasFor("session", gp), check: permissionCheck },
        { label: "Record the terms in Mandate (approval 2 of 2)", messages: () => [sub()], gas: gasFor("call", gp), check: mandateCheck, precheck: stillSame },
      ];
    });
    if (out === "done") {
      setDone(true);
      r.setMessage("Subscribed. The creator’s collector takes the first payment when it is due.");
    }
    refresh();
  }

  async function removePermission(s: SessionEntry) {
    await r.run(payer, async () => {
      const why = removeCheck(s.address, await freshKey(payer, s.address));
      if (why) return why;
      const pub = fromBase64(s.pubKey);
      const gp = await read.gasPrice();
      return [{ label: "Remove the permission", messages: () => [buildRevokeSession({ creator: payer, pub33: pub })], gas: gasFor("session", gp), check: { kind: "permission-gone", key: s.address } }];
    });
    refresh();
  }

  const busy = r.busy || pending !== null;
  const stoppedOnChain = st?.kind === "already" && st.permission === false;
  return (
    <div className="subscribe">
      <RunnerStatus r={r} />
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
        <SubscribeBody
          st={st}
          plan={plan}
          payer={payer}
          balance={v?.balance ?? 0n}
          busy={busy}
          busyLabel={r.busy ? "Working…" : "Waiting for the step above…"}
          onSubscribe={subscribe}
          onRemove={removePermission}
        />
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
        <div className={busy ? "confirm confirm-paused" : "confirm"}>
          <div className="confirm-head">
            <span className="console-kicker">
              <span className={busy ? "status-dot status-dot-signal" : "status-dot status-dot-accent"} aria-hidden="true" />
              {busy ? busyLabel.replace(/…$/, "") : st.resume ? "Permission on chain · 1 step left" : "Ready to sign"}
            </span>
            <span className="mono small muted">Cap {gnot(st.cap)} GNOT / {period(plan.period)}</span>
          </div>
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
              Adena shows the exact network fee before you sign; expect about {gnot(st.fees)} GNOT in all, plus a storage deposit of about {gnot(st.depositShown)} GNOT.
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
  const pending = usePending(payer);
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
  async function stop() {
    const out = await r.run(payer, async () => {
      const fresh = await freshKey(payer, m.session);
      const c = stopCheck(m, fresh, tidy ? "tidy" : "stop");
      if (c.kind === "changed") return c.reason;
      const gp = await read.gasPrice();
      const key = m.session;
      const id = m.id.toString();
      const revoke = c.revoke ? () => [buildRevokeSession({ creator: payer, pub33: fromBase64(c.revoke!.pubKey) }) as Msg] : null;
      const cancel = c.cancel ? () => [buildCancel({ payer, sessionAddr: key }) as Msg] : null;
      // right before the cancel (the permission is removed by then): the key's active mandate is still the one shown
      const stillThisOne = async () => {
        invalidate();
        const fresh = await freshKey(payer, key);
        const again = stopCheck(m, fresh, "stop");
        if (again.kind !== "changed") return null;
        // stopCheck's "so it was left in place" is untrue here: the step before removed the permission
        const other = fresh.byKey && isActive(fresh.byKey, fresh.now) && fresh.byKey.id !== m.id ? fresh.byKey : null;
        return other ? `Another of your mandates (plan #${other.planId}) now uses this collector key.` : again.reason;
      };
      if (revoke && cancel && oneApproval())
        return [
          { label: "Remove the permission and cancel (one approval)", messages: () => [...revoke(), ...cancel()], gas: gasFor("sessionAndCall", gp), check: { kind: "gone-and-cancelled", key, mandateId: id } },
        ];
      return [
        ...(revoke ? [{ label: "Remove the permission: no payment can be taken any more", messages: revoke, gas: gasFor("session", gp), check: { kind: "permission-gone", key } as PendingCheck }] : []),
        ...(cancel
          ? [{ label: "Cancel the mandate in Mandate", messages: cancel, gas: gasFor("call", gp), check: { kind: "cancelled", key, mandateId: id } as PendingCheck, precheck: stillThisOne }]
          : []),
      ];
    });
    if (out === "done") r.setMessage(tidy ? "The leftover permission is removed." : "Stopped. No payment can be taken any more.");
    setConfirming(false);
    onChanged();
  }
  const session = st.kind === "ready" ? st.session : null;
  const busy = r.busy || pending !== null;
  return (
    <div className="stop">
      <RunnerStatus r={r} />
      {st.kind === "ready" && tidy && session && <PermissionAllows s={session} now={now} />}
      {st.kind === "ready" &&
        (!confirming ? (
          <button type="button" className="btn btn-quiet" onClick={() => setConfirming(true)} disabled={busy}>
            <Icon name="stop" />
            {label}
          </button>
        ) : (
          <div className="confirm-inline" role="group" aria-label={`${label}?`}>
            <p>
              {st.cancel
                ? `Stop paying ${gnot(m.amount)} GNOT every ${period(m.period)}? ${st.session ? "Your permission is removed first, so no payment can be taken from then on; then the mandate is cancelled." : "Your permission is already gone; this cancels the mandate in Mandate."} Time you already paid for stays yours. (If this wallet already keeps paid time for 16 other plans, the one that ends soonest is given up.)`
                : "Remove the permission this mandate left behind?"}
            </p>
            <div className="confirm-actions">
              <button type="button" className="btn btn-danger" onClick={() => void stop()} disabled={busy}>
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

/** What a permission for Mandate without an active mandate still allows, in plain words. */
function PermissionAllows({ s, now, own = true }: { s: SessionEntry; now: bigint; own?: boolean }) {
  return <p className="small">{permissionAllows(s, now, own)}</p>;
}

/**
 * A permission for Mandate that no mandate on this page uses (a collector key
 * the creator has replaced, a subscription started and not finished, or a
 * mandate older than the history shown): what it allows, and a way to remove it.
 */
export function LoosePermission({ s, payer, now, onChanged }: { s: SessionEntry; payer: string; now: bigint; onChanged: () => void }) {
  const w = useWallet();
  const r = useRunner();
  const pending = usePending(payer);
  async function remove() {
    await r.run(payer, async () => {
      const why = removeCheck(s.address, await freshKey(payer, s.address));
      if (why) return why;
      const gp = await read.gasPrice();
      return [
        {
          label: "Remove the permission",
          messages: () => [buildRevokeSession({ creator: payer, pub33: fromBase64(s.pubKey) })],
          gas: gasFor("session", gp),
          check: { kind: "permission-gone", key: s.address },
        },
      ];
    });
    onChanged();
  }
  return (
    <div className="stop">
      <PermissionAllows s={s} now={now} own={w.address === payer} />
      <RunnerStatus r={r} />
      {w.address === payer ? (
        <button type="button" className="btn btn-quiet" onClick={() => void remove()} disabled={r.busy || pending !== null || !s.pubKey}>
          <Icon name="stop" />
          {r.busy ? "Working…" : "Remove this permission"}
        </button>
      ) : (
        <p className="small muted">To remove it, connect the wallet that gave it.</p>
      )}
    </div>
  );
}
