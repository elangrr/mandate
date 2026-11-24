import { useState, type ReactNode } from "react";
import { config, explorerTx, gnowebPage } from "../config";
import type { Mandate, Plan } from "../lib/amino";
import { date, dateTime, gnot, period } from "../lib/format";
import { stopState, subscribeState, type ChainView, type SubscribeState } from "../lib/flows";
import { invalidate, read, type SessionEntry } from "../lib/rpc";
import { buildCancel, buildCreateSession, buildRevokeSession, buildSubscribe, doContractParams, fromBase64, gasFor, type Msg } from "../lib/tx";
import { send, WalletError, type Sent } from "../lib/wallet";
import { useAsync } from "./hooks";
import { Icon, Loading, ReadFailed } from "./parts";
import { useWallet } from "./WalletContext";

/** Approvals run one after another; each step shows where it stands. */
type StepState = "waiting" | "wallet" | "done" | "failed";
interface Step {
  label: string;
  state: StepState;
  hash?: string;
}

function Steps({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="steps-run">
      {steps.map((s, i) => (
        <li key={i} className={`step-run step-${s.state}`}>
          <span className="step-dot" aria-hidden="true">
            {s.state === "done" ? <Icon name="check" /> : s.state === "failed" ? <Icon name="alert" /> : i + 1}
          </span>
          <span>
            {s.label}
            <span className="visually-hidden">
              {s.state === "wallet" ? ": waiting for your approval in Adena" : s.state === "done" ? ": done" : s.state === "failed" ? ": not done" : ""}
            </span>
            {s.state === "wallet" && <span className="muted small"> · approve it in Adena</span>}
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

/** Runs approvals in order and keeps the steps and a message for the live region. */
function useRunner() {
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function run(signer: string, plan: { label: string; messages: () => Msg[]; gas: Parameters<typeof doContractParams>[1] }[]): Promise<boolean> {
    setBusy(true);
    setError("");
    setMessage("");
    const s: Step[] = plan.map((p) => ({ label: p.label, state: "waiting" }));
    setSteps([...s]);
    try {
      for (let i = 0; i < plan.length; i++) {
        s[i] = { ...s[i], state: "wallet" };
        setSteps([...s]);
        setMessage(`${plan[i].label}: approve it in Adena.`);
        const sent: Sent = await send(signer, doContractParams(plan[i].messages(), plan[i].gas));
        s[i] = { ...s[i], state: "done", hash: sent.hash };
        setSteps([...s]);
        invalidate();
      }
      return true;
    } catch (e) {
      const i = s.findIndex((x) => x.state === "wallet");
      if (i >= 0) s[i] = { ...s[i], state: "failed" };
      setSteps([...s]);
      setError(e instanceof WalletError || e instanceof Error ? e.message : "Adena could not complete this.");
      invalidate();
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { steps, busy, message, error, setMessage, setError, run, reset: () => setSteps([]) };
}

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

/**
 * Everything subscribing depends on, read fresh from the chain: the plan and
 * the creator's collector key too, so the terms shown and the messages built
 * never come from an older read than the wallet's own state.
 */
async function loadView(shown: Plan, payer: string): Promise<ChainView> {
  const plan = (await read.plan(shown.id)) ?? shown;
  const payee = await read.payee(plan.payee);
  const [now, mandates, sessions, paidThrough, balance, gasPrice, collectorIsAccount] = await Promise.all([
    read.chainTime(),
    (async () => {
      const out: Mandate[] = [];
      for (let page = 1; page <= 10; page++) {
        const list = await read.mandatesOf(payer, page);
        out.push(...list);
        if (list.length < 20) break;
      }
      return out;
    })(),
    read.sessions(payer),
    read.paidThrough(payer, plan.id),
    read.balance(payer),
    read.gasPrice(),
    payee?.collectorAddr ? read.accountExists(payee.collectorAddr) : Promise.resolve(false),
  ]);
  return { now, plan, payee, collectorIsAccount, mandates, sessions, paidThrough, balance, gasPrice };
}

/** What changed between the terms on screen and the chain now, in words; null if nothing that matters. */
function changedSince(a: ChainView, sa: SubscribeState, b: ChainView, sb: SubscribeState): string | null {
  if (b.plan.amount !== a.plan.amount || b.plan.period !== a.plan.period) return "the plan’s price or period";
  if ((b.payee?.collectorKey ?? "") !== (a.payee?.collectorKey ?? "") || (b.payee?.collectorAddr ?? "") !== (a.payee?.collectorAddr ?? "")) return "the creator’s collector key";
  if (sb.kind !== sa.kind) return "what your wallet can do here";
  if (sa.kind === "ready" && sb.kind === "ready" && (sa.resume !== sb.resume || sa.cap !== sb.cap)) return "your wallet’s permissions";
  return null;
}

/** One approval for both messages only when asked for (#…?approval=one); two otherwise. */
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
  const [checking, setChecking] = useState(false);
  const refresh = () => {
    invalidate();
    setTick((t) => t + 1);
  };
  if (view.status === "loading" && r.steps.length === 0) return <Loading what="your wallet’s permissions" />;
  if (view.status === "error") return <ReadFailed error={view.error} retry={reload} />;
  const v = view.status === "ready" ? view.value : null;
  const st: SubscribeState | null = v ? subscribeState(v) : null;

  const plan = v?.plan ?? shown;

  async function subscribe(shownState: Extract<SubscribeState, { kind: "ready" }>) {
    // Read the chain once more right before the first popup: if anything the
    // terms depend on changed since they were shown, stop and show the new state.
    r.setError("");
    let fresh: ChainView;
    setChecking(true);
    try {
      invalidate();
      fresh = await loadView(plan, payer);
    } catch {
      r.setError("Unable to read the chain just now. Nothing was sent; try again.");
      return;
    } finally {
      setChecking(false);
    }
    const state = subscribeState(fresh);
    const what = changedSince(v!, shownState, fresh, state);
    if (what || state.kind !== "ready") {
      r.setError(`Something changed on chain since this page was read (${what ?? "your wallet’s permissions"}). Nothing was sent. Check the terms below and try again.`);
      refresh();
      return;
    }
    const gp = fresh.gasPrice;
    const p = fresh.plan;
    const key = fresh.payee!;
    const session = () => buildCreateSession({ creator: payer, collectorKey: key.collectorKey, plan: p, expiresAt: state.end });
    const sub = () => buildSubscribe({ payer, planId: p.id, sessionAddr: key.collectorAddr, expiresAt: state.end });
    const steps = state.resume
      ? [{ label: "Record the terms in Mandate", messages: () => [sub()], gas: gasFor("call", gp) }]
      : oneApproval()
        ? [{ label: "Give the permission and record the terms (one approval)", messages: () => [session(), sub()], gas: gasFor("sessionAndCall", gp) }]
        : [
            { label: "Give the permission (approval 1 of 2)", messages: () => [session()], gas: gasFor("session", gp) },
            { label: "Record the terms in Mandate (approval 2 of 2)", messages: () => [sub()], gas: gasFor("call", gp) },
          ];
    const ok = await r.run(payer, steps);
    if (ok) {
      setDone(true);
      r.setMessage("Subscribed. The creator’s collector takes the first payment on its next run.");
    }
    refresh();
  }

  async function removePermission(s: SessionEntry) {
    const pub = fromBase64(s.pubKey);
    const ok = await r.run(payer, [{ label: "Remove the old permission", messages: () => [buildRevokeSession({ creator: payer, pub33: pub })], gas: gasFor("session", v!.gasPrice) }]);
    if (ok) r.setMessage("The old permission is removed. You can subscribe now.");
    refresh();
  }

  return (
    <div className="subscribe">
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
      {done && st?.kind === "already" && st.permission && (
        <div className="notice notice-ok">
          <Icon name="check" />
          <p>
            You support this plan. The creator’s collector takes the first payment {st.mandate.nextPullAt > (v?.now ?? 0n) ? `from ${dateTime(st.mandate.nextPullAt)}` : "on its next run"}.{" "}
            <a href={`#/mine?a=${payer}`}>See your mandates</a>
          </p>
        </div>
      )}
      {(!done || (st?.kind === "already" && !st.permission)) && st && <SubscribeBody st={st} plan={plan} payer={payer} busy={r.busy || checking} busyLabel={checking ? "Checking the chain…" : "Waiting for Adena…"} onSubscribe={subscribe} onRemove={removePermission} />}
    </div>
  );
}

function SubscribeBody({
  st,
  plan,
  payer,
  busy,
  busyLabel,
  onSubscribe,
  onRemove,
}: {
  st: SubscribeState;
  plan: Plan;
  payer: string;
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
      if (!st.permission)
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
            You support this plan{st.mandate.paidThrough > 0n ? `, paid through ${date(st.mandate.paidThrough)}` : ""}. <a href={`#/mine?a=${payer}`}>See or stop it</a>
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
    case "ready":
      return (
        <div className="confirm">
          <p className="confirm-sentence">
            From this wallet: <strong>at most {gnot(st.cap)} GNOT every {period(plan.period)}</strong>, through Mandate only, until{" "}
            <strong>{date(st.end)}</strong>.
          </p>
          <ul className="confirm-list">
            {st.paidThrough > 0n && <li>You already paid for this plan until {date(st.paidThrough)}: the first new payment waits until then.</li>}
            <li>
              {st.resume ? "Your permission is already on chain: one approval records the terms." : oneApproval() ? "One approval in Adena." : "Two approvals in Adena: the permission, then the terms."}{" "}
              Adena shows the exact network fee before you sign; expect about {gnot(st.fees)} GNOT in all, plus a storage deposit of about {gnot(st.deposit)} GNOT.
            </li>
            <li>The first payment, {gnot(plan.amount)} GNOT, is taken later by the creator’s collector, not now.</li>
          </ul>
          {st.resume && (
            <p className="small muted">
              Your wallet already gave this creator’s collector key the permission, but no mandate is recorded for it: a subscription was started and not
              finished. Finish it, or undo it by removing the permission.
            </p>
          )}
          <div className="confirm-actions">
            <button type="button" className="btn btn-primary" onClick={() => onSubscribe(st)} disabled={busy}>
              {busy ? busyLabel : st.resume ? "Finish subscribing" : `Subscribe for ${gnot(plan.amount)} GNOT every ${period(plan.period)}`}
            </button>
            {st.resume && st.session && (
              <button type="button" className="btn btn-quiet" onClick={() => onRemove(st.session!)} disabled={busy}>
                Undo: remove the permission
              </button>
            )}
          </div>
        </div>
      );
  }
}

// ------------------------------------------------------------------ stop

export function StopControls({ m, all, payer, now, sessions, onChanged }: { m: Mandate; all: Mandate[]; payer: string; now: bigint; sessions: SessionEntry[]; onChanged: () => void }) {
  const w = useWallet();
  const r = useRunner();
  const [confirming, setConfirming] = useState(false);
  const st = stopState(m, all, sessions, now);
  if (st.kind === "nothing") return null;
  const label = st.cancel ? (st.session ? "Stop this mandate" : "Cancel it in Mandate") : "Remove the leftover permission";
  if (w.address !== payer)
    return (
      <p className="small muted">
        To {st.cancel ? "stop" : "tidy up"} this mandate, connect the wallet that gave it. Or run the commands on its{" "}
        <a href={gnowebPage(`payer/${payer}`)} target="_blank" rel="noreferrer noopener" className="ext">
          gnoweb page <Icon name="external" />
        </a>
      </p>
    );
  async function stop() {
    if (st.kind !== "ready") return;
    const gp = await read.gasPrice();
    const revoke = st.session ? () => [buildRevokeSession({ creator: payer, pub33: fromBase64(st.session!.pubKey) }) as Msg] : null;
    const cancel = st.cancel ? () => [buildCancel({ payer, sessionAddr: m.session }) as Msg] : null;
    const steps =
      revoke && cancel && oneApproval()
        ? [{ label: "Remove the permission and cancel (one approval)", messages: () => [...revoke(), ...cancel()], gas: gasFor("sessionAndCall", gp) }]
        : [
            ...(revoke ? [{ label: "Remove the permission: no payment can be taken any more", messages: revoke, gas: gasFor("session", gp) }] : []),
            ...(cancel ? [{ label: "Cancel the mandate in Mandate", messages: cancel, gas: gasFor("call", gp) }] : []),
          ];
    const ok = await r.run(payer, steps);
    if (ok) r.setMessage(st.cancel ? "Stopped. No payment can be taken any more." : "The leftover permission is removed.");
    setConfirming(false);
    onChanged();
  }
  return (
    <div className="stop">
      <div role="status" aria-live="polite" className="visually-hidden">
        {r.message}
      </div>
      <Steps steps={r.steps} />
      {r.error && (
        <div className="notice notice-error" role="alert">
          <Icon name="alert" />
          <p>{r.error} The page now shows what is left to do.</p>
        </div>
      )}
      {!confirming ? (
        <button type="button" className="btn btn-quiet" onClick={() => setConfirming(true)} disabled={r.busy}>
          <Icon name="stop" />
          {label}
        </button>
      ) : (
        <div className="confirm-inline" role="group" aria-label={`${label}?`}>
          <p>
            {st.cancel
              ? `Stop paying ${gnot(m.amount)} GNOT every ${period(m.period)}? ${st.session ? "Your permission is removed first, so no payment can be taken from then on; then the mandate is cancelled." : "Your permission is already gone; this cancels the mandate in Mandate."} Time you already paid for stays yours.`
              : "Remove the permission this ended mandate left behind?"}
          </p>
          <div className="confirm-actions">
            <button type="button" className="btn btn-danger" onClick={() => void stop()} disabled={r.busy}>
              {r.busy ? "Waiting for Adena…" : label}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setConfirming(false)} disabled={r.busy}>
              Keep it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
