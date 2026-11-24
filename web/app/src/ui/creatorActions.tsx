// The creator's side: publish a plan (Offer) and publish or replace the
// collector key (SetCollectorKey) with Adena, and the guide to running the
// collector. Same discipline as subscribing (actions.tsx): explicit gas,
// wait for the block, the account and network checked before every popup, a
// fresh read right before it, and every step confirmed by reading the chain.
// The page never asks for, makes or handles a private key, password or seed.

import { useId, useState, type FormEvent } from "react";
import { config, rules } from "../config";
import type { Payee } from "../lib/amino";
import { buildOffer, buildSetCollectorKey, checkCollectorKey, collectorCommand, depositFor, MEASURED_GAS, type KeyCheck, type PeriodUnit } from "../lib/creator";
import { gnot, period, plural, shortAddr } from "../lib/format";
import { usePending } from "../lib/pending";
import { invalidate, read } from "../lib/rpc";
import { gasFor } from "../lib/tx";
import { RunnerStatus, useRunner, WalletGate } from "./actions";
import { capOf, feeEstimate, keyState, readPlanForm, type PlanForm } from "./creatorView";
import { useAsync } from "./hooks";
import { CapMeter, Icon, Loading, ReadFailed } from "./parts";

interface CreatorView {
  payee: Payee | null;
  keyIsAccount: boolean;
  gasPrice: { gas: bigint; amount: bigint };
  plans: number;
}

async function loadCreatorView(creator: string): Promise<CreatorView> {
  const [payee, gasPrice] = await Promise.all([read.payee(creator), read.gasPrice()]);
  const keyIsAccount = payee?.collectorAddr ? await read.accountExists(payee.collectorAddr) : false;
  return { payee, keyIsAccount, gasPrice, plans: payee?.plans ?? 0 };
}

// ------------------------------------------------------------------ publish page

export function Publish() {
  return (
    <>
      <div className="page-head">
        <h1>Publish as a creator</h1>
        <p className="lede">
          Two things make you a creator here: a collector key, which supporters give their permission to, and a plan with its price and period. Both are
          signed with your own wallet in Adena.
        </p>
      </div>
      <WalletGate doing="publishing">{(address) => <CreatorConsole creator={address} />}</WalletGate>
      <p className="small muted other-ways">
        Running the collector, which takes each payment when it is due: <a href="#/collector">the collector guide</a>.
      </p>
    </>
  );
}

function CreatorConsole({ creator }: { creator: string }) {
  const pending = usePending(creator);
  const [tick, setTick] = useState(0);
  const [s, reload] = useAsync(() => loadCreatorView(creator), [creator, tick, pending ? 1 : 0]);
  const refresh = () => {
    invalidate();
    setTick((t) => t + 1);
  };
  if (s.status === "loading") return <Loading what="your creator record" />;
  if (s.status === "error") return <ReadFailed error={s.error} retry={reload} />;
  const v = s.value;
  return (
    <div className="publish-grid">
      <KeyPanel creator={creator} view={v} busyElsewhere={pending !== null} onChanged={refresh} />
      <PlanPanel creator={creator} view={v} busyElsewhere={pending !== null} onChanged={refresh} />
      <p className="small">
        <a href={`#/creator/${creator}`}>Your creator page</a> shows your plans, payments and key as the chain has them.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ collector key

function KeyPanel({ creator, view, busyElsewhere, onChanged }: { creator: string; view: CreatorView; busyElsewhere: boolean; onChanged: () => void }) {
  const id = useId();
  const r = useRunner();
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<KeyCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [done, setDone] = useState(false);
  const state = keyState(view.payee, view.keyIsAccount);
  const replacing = !!view.payee?.collectorKey;

  async function check(e: FormEvent) {
    e.preventDefault();
    setChecking(true);
    setDone(false);
    try {
      invalidate();
      const c = await checkCollectorKey(text, creator, (a) => read.accountExists(a));
      setChecked(c);
      if (!c.ok) document.getElementById(`${id}-key`)?.focus();
    } catch {
      setChecked({ ok: false, reason: "Unable to read the chain just now, so the key could not be checked. Try again.", address: null });
    } finally {
      setChecking(false);
    }
  }

  async function publish(c: Extract<KeyCheck, { ok: true }>) {
    const out = await r.run(creator, async () => {
      // read again right before the popup: the key's address and the creator's record
      const again = await checkCollectorKey(c.gpub, creator, (a) => read.accountExists(a));
      if (!again.ok) return again.reason;
      const payee = await read.payee(creator);
      if (payee?.collectorKey === c.gpub) return "This key is already your published collector key.";
      const gp = await read.gasPrice();
      return [
        {
          label: replacing ? "Replace the collector key" : "Publish the collector key",
          messages: () => [buildSetCollectorKey({ payee: creator, gpub: c.gpub })],
          gas: gasFor("call", gp),
          check: { kind: "collector-key", key: creator, gpub: c.gpub },
        },
      ];
    });
    if (out === "done") {
      setDone(true);
      setText("");
      setChecked(null);
      r.setMessage("The collector key is published.");
    }
    onChanged();
  }

  const deposit = depositFor("key", { hasRecord: !!view.payee, hasKey: replacing });
  const fee = feeEstimate(MEASURED_GAS.setKey, view.gasPrice);
  const busy = r.busy || busyElsewhere;
  return (
    <section className="card publish-card" aria-labelledby={`${id}-title`}>
      <div className="collector-head">
        <h2 id={`${id}-title`}>Collector key</h2>
        <span className={`pill pill-${state.tone}`}>{state.label}</span>
      </div>
      {view.payee?.collectorKey && (
        <div className="collector-well">
          <span className="console-kicker">Published collector address</span>
          <p className="mono small break">{view.payee.collectorAddr}</p>
        </div>
      )}
      <p className={state.kind === "blocked" ? "notice notice-warn" : "small muted"}>
        {state.kind === "blocked" && <Icon name="alert" />}
        <span>{state.note}</span>
      </p>

      <ul className="publish-rules">
        <li>
          <strong>A separate key, made only for collecting.</strong> Make it with gnokey on the machine that runs the collector; this page only needs its
          public key (gpub1…). Never paste a private key, a password or a seed phrase anywhere.
        </li>
        <li>
          <strong>Never send coins to it.</strong> Once its address holds any coin it is an account, and the chain refuses every new permission for it.
          Supporters pay the collector’s network fees from their own allowance.
        </li>
        {replacing && (
          <li>
            <strong>Replacing it keeps existing supporters on the old key.</strong> Their permission names the old key, so keep running a collector with
            it until their mandates end, and run a second collector with the new key. New supporters give their permission to the new key.
          </li>
        )}
      </ul>

      <RunnerStatus r={r} />
      {done && (
        <p className="notice notice-ok">
          <Icon name="check" />
          <span>
            Published: the chain now lists this key for your plans. <a href="#/collector">Set up the collector</a>.
          </span>
        </p>
      )}

      <form className="publish-form" onSubmit={check} noValidate>
        <label htmlFor={`${id}-key`}>{replacing ? "New collector public key" : "Collector public key"}</label>
        <p className="field-hint" id={`${id}-hint`}>
          From <code className="mono">gnokey list -home ~/mandate-collector</code>: the value after “pub:”, starting with gpub1.
        </p>
        <textarea
          id={`${id}-key`}
          name="collector-key"
          className="input mono key-input"
          rows={3}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setChecked(null);
          }}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-invalid={checked !== null && !checked.ok}
          aria-describedby={`${id}-hint${checked && !checked.ok ? ` ${id}-err` : ""}`}
        />
        {checked && !checked.ok && (
          <p id={`${id}-err`} className="field-error" role="alert">
            {checked.reason}
            {checked.address && (
              <>
                {" "}
                Its address: <span className="mono break">{checked.address}</span>.
              </>
            )}
          </p>
        )}
        <div className="confirm-actions">
          <button type="submit" className="btn btn-quiet" disabled={checking || busy}>
            {checking ? "Checking the chain…" : "Check this key"}
          </button>
        </div>
      </form>

      {checked?.ok && (
        <div className="confirm publish-confirm">
          <p className="confirm-sentence">
            {replacing ? "Replace your collector key with the key at " : "Publish the key at "}
            <strong className="mono break">{checked.address}</strong>.
          </p>
          <ul className="confirm-list">
            <li>It is a secp256k1 key, not your wallet’s own key, and its address has never received coins.</li>
            <li>
              One approval in Adena. Network fee about {gnot(fee)} GNOT; storage deposit about {gnot(deposit)} GNOT.
            </li>
          </ul>
          <div className="confirm-actions">
            <button type="button" className="btn btn-primary" onClick={() => void publish(checked)} disabled={busy}>
              {r.busy ? "Working…" : busyElsewhere ? "Waiting for the step above…" : replacing ? "Replace collector key" : "Publish collector key"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ plan

const UNITS: { value: PeriodUnit; label: string }[] = [
  { value: "days", label: "days" },
  { value: "hours", label: "hours" },
  { value: "minutes", label: "minutes" },
];

function PlanPanel({ creator, view, busyElsewhere, onChanged }: { creator: string; view: CreatorView; busyElsewhere: boolean; onChanged: () => void }) {
  const id = useId();
  const r = useRunner();
  const [form, setForm] = useState<PlanForm>({ title: "", price: "", count: "30", unit: "days" });
  const [tried, setTried] = useState(false);
  const [published, setPublished] = useState<string | null>(null);
  const read_ = readPlanForm(form);
  const set = (patch: Partial<PlanForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setPublished(null);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    const o = read_.offer;
    if (!o) {
      const first = read_.errors.title ? "title" : read_.errors.price ? "price" : "count";
      document.getElementById(`${id}-${first}`)?.focus();
      return;
    }
    const out = await r.run(creator, async () => {
      // read again right before the popup: the chain's time (the check looks for a plan published after it) and gas price
      const [now, gp] = await Promise.all([read.chainTime(), read.gasPrice()]);
      const msg = buildOffer({ payee: creator, ...o });
      return [
        {
          label: "Publish the plan",
          messages: () => [msg],
          gas: gasFor("call", gp),
          check: { kind: "plan", key: creator, title: o.title, amount: o.amount.toString(), period: o.period.toString(), after: (now - 5n).toString() },
        },
      ];
    });
    if (out === "done") {
      setPublished(o.title);
      setTried(false);
      setForm({ title: "", price: "", count: "30", unit: "days" });
      r.setMessage("The plan is published.");
    }
    onChanged();
  }

  const deposit = depositFor("offer", { hasRecord: !!view.payee, hasKey: !!view.payee?.collectorKey });
  const fee = feeEstimate(MEASURED_GAS.offer, view.gasPrice);
  const busy = r.busy || busyElsewhere;
  const err = (k: "title" | "price" | "period") => (tried ? read_.errors[k] : undefined);
  return (
    <section className="card publish-card" aria-labelledby={`${id}-title-h`}>
      <div className="collector-head">
        <h2 id={`${id}-title-h`}>Publish a plan</h2>
        <span className="console-kicker mono">{plural(view.plans, "plan")} published</span>
      </div>
      {!view.payee?.collectorKey && (
        <p className="notice notice-warn">
          <Icon name="alert" />
          <span>You can publish a plan now, but nobody can subscribe to it until your collector key is published.</span>
        </p>
      )}
      <RunnerStatus r={r} />
      {published && (
        <p className="notice notice-ok">
          <Icon name="check" />
          <span>
            “{published}” is published. <a href={`#/creator/${creator}`}>See it on your creator page</a>.
          </span>
        </p>
      )}

      <form className="publish-form plan-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={`${id}-title`}>Title</label>
          <p className="field-hint" id={`${id}-title-hint`}>
            One line, up to {rules.maxTitleLen} characters, shown as plain text. <span className="mono">{read_.chars}/{rules.maxTitleLen}</span>
          </p>
          <input
            id={`${id}-title`}
            name="title"
            className="input"
            value={form.title}
            onChange={(e) => set({ title: e.target.value })}
            autoComplete="off"
            aria-invalid={!!err("title")}
            aria-describedby={`${id}-title-hint${err("title") ? ` ${id}-title-err` : ""}`}
          />
          {err("title") && (
            <p id={`${id}-title-err`} className="field-error">
              {err("title")}
            </p>
          )}
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor={`${id}-price`}>Price per period, in GNOT</label>
            <p className="field-hint" id={`${id}-price-hint`}>
              At least 0.1 GNOT.
            </p>
            <input
              id={`${id}-price`}
              name="price"
              className="input mono"
              inputMode="decimal"
              value={form.price}
              onChange={(e) => set({ price: e.target.value })}
              autoComplete="off"
              aria-invalid={!!err("price")}
              aria-describedby={`${id}-price-hint${err("price") ? ` ${id}-price-err` : ""}`}
            />
            {err("price") && (
              <p id={`${id}-price-err`} className="field-error">
                {err("price")}
              </p>
            )}
          </div>
          <fieldset className="field" aria-describedby={`${id}-period-hint${err("period") ? ` ${id}-period-err` : ""}`}>
            <legend>Period</legend>
            <p className="field-hint" id={`${id}-period-hint`}>
              From 1 minute to 30 days. Periods under a day are marked as test plans.
            </p>
            <div className="period-row">
              <label htmlFor={`${id}-count`} className="visually-hidden">
                Number of
              </label>
              <input
                id={`${id}-count`}
                name="period-count"
                className="input mono"
                inputMode="numeric"
                value={form.count}
                onChange={(e) => set({ count: e.target.value })}
                autoComplete="off"
                aria-invalid={!!err("period")}
              />
              <label htmlFor={`${id}-unit`} className="visually-hidden">
                Unit
              </label>
              <select id={`${id}-unit`} name="period-unit" className="input" value={form.unit} onChange={(e) => set({ unit: e.target.value as PeriodUnit })}>
                {UNITS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
            </div>
            {err("period") && (
              <p id={`${id}-period-err`} className="field-error">
                {err("period")}
              </p>
            )}
          </fieldset>
        </div>

        <div className="plan-preview" aria-labelledby={`${id}-preview`}>
          <span className="console-kicker" id={`${id}-preview`}>
            Preview · as supporters will see it
          </span>
          <p className="plan-preview-title">{form.title.trim() ? form.title : <span className="muted">Your title</span>}</p>
          {read_.amount !== null && read_.period !== null ? (
            <>
              <p className="plan-preview-price mono">
                {gnot(read_.amount)} GNOT every {period(read_.period)}
              </p>
              <CapMeter amount={read_.amount} feeAllowance={rules.feeAllowanceUgnot} periodSec={read_.period} />
              <p className="small muted">
                Each supporter allows at most {gnot(capOf(read_.amount))} GNOT every {period(read_.period)}: your price plus a{" "}
                {gnot(rules.feeAllowanceUgnot)} GNOT allowance for the collector’s network fee.
              </p>
            </>
          ) : (
            <p className="small muted">Enter a valid price and period to see the cap.</p>
          )}
        </div>

        <ul className="costs">
          <li>
            <span>Cannot be changed</span>
            <span>Once published, a plan’s title, price and period stay as they are. New terms mean a new plan.</span>
          </li>
          <li>
            <span>Storage deposit</span>
            <span>about {gnot(deposit)} GNOT, from your wallet</span>
          </li>
          <li>
            <span>Network fee</span>
            <span>about {gnot(fee)} GNOT; Adena shows the exact fee before you sign</span>
          </li>
        </ul>
        <div className="confirm-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {r.busy ? "Working…" : busyElsewhere ? "Waiting for the step above…" : "Publish plan"}
          </button>
        </div>
      </form>
    </section>
  );
}

// ------------------------------------------------------------------ collector guide

export function CollectorGuide({ address }: { address: string }) {
  const payee = /^g1[02-9ac-hj-np-z]{38}$/.test(address) ? address : "<your address>";
  const home = "~/mandate-collector";
  const cmd = collectorCommand({ payee, home, keyName: "collector" });
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <article className="guide">
      <div className="page-head">
        <h1>Running the collector</h1>
        <p className="lede">
          The collector is a small script that takes each payment when it is due. It runs on your own machine, signs with your collector key and never
          needs your wallet’s key. Supporters’ permissions allow only that key, only through Mandate, only up to their cap.
        </p>
      </div>

      <ol className="guide-steps">
        <li className="card">
          <h2>Make the collector key</h2>
          <p>On the machine that will run the collector, with gnokey v1.8.0:</p>
          <pre className="code-block mono">
            <code>{`gnokey add -home ${home} collector\ngnokey list -home ${home}`}</code>
          </pre>
          <p className="small muted">
            Keep the key’s password and recovery phrase on that machine; Mandate never asks for them. Never send coins to this key: once its address holds
            any coin, the chain refuses every new permission for it.
          </p>
        </li>
        <li className="card">
          <h2>Publish its public key</h2>
          <p>
            Copy the value after “pub:” (it starts with gpub1) and publish it on <a href="#/publish">the Publish page</a>, signed with your wallet.
          </p>
        </li>
        <li className="card">
          <h2>Run it</h2>
          <p>
            From a copy of the{" "}
            <a href={config.sourceUrl} target="_blank" rel="noreferrer noopener" className="ext">
              Mandate source <Icon name="external" />
            </a>
            , with gnokey, python3 and flock installed:
          </p>
          <pre className="code-block mono" aria-label="The collector command">
            <code>{cmd}</code>
          </pre>
          <div className="confirm-actions">
            <button type="button" className="btn btn-quiet" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy the command"}
            </button>
            <span role="status" className="visually-hidden">
              {copied ? "The command is copied." : ""}
            </span>
          </div>
          {payee === "<your address>" && (
            <p className="small muted">Connect your wallet or open this guide from your creator page to have your address filled in.</p>
          )}
          <p>It asks for the key’s password once per run. To run it on a schedule, every 10 minutes for example, with cron:</p>
          <pre className="code-block mono">
            <code>{`*/10 * * * * cd ~/mandate && ${cmd} -insecure-password-stdin < ~/.mandate-collector-pass >> ~/mandate-collector.log 2>&1`}</code>
          </pre>
          <p className="small muted">
            Cron has no terminal, so the script reads the password from a file: make it readable by you alone (<code className="mono">chmod 600</code>).
            Run it at least once per period of your shortest plan.
          </p>
        </li>
        <li className="card">
          <h2>What it says</h2>
          <dl className="guide-msgs">
            <dt className="mono">collector key collector (g1…) for payee …</dt>
            <dd>Which key and which creator this run serves.</dd>
            <dt className="mono">N plans, M active mandates for this key (… not due)</dt>
            <dd>What it found; only due mandates are paid in this run.</dd>
            <dt className="mono">Pull fee: …ugnot for … gas</dt>
            <dd>The network fee each payment pays, from the supporter’s fee allowance.</dd>
            <dt className="mono">skipping mandate N (g1…): no session for this key</dt>
            <dd>The supporter removed the permission, or never gave one: no payment can be taken. Nothing to do.</dd>
            <dt className="mono">done: N pulled or tried, …</dt>
            <dd>The run’s summary. Exit status 0 means every due payment was taken or skipped for a reason on the supporter’s side.</dd>
          </dl>
        </li>
        <li className="card">
          <h2>When the key is blocked</h2>
          <p>
            If a run warns that the collector key’s address is an account, it received coins and the chain refuses every new permission for it: nobody
            new can subscribe.
          </p>
          <ol className="guide-fix">
            <li>Make a new key with gnokey and publish it on the Publish page.</li>
            <li>Keep running this collector for the existing mandates; they still work.</li>
            <li>Run a second collector with the new key.</li>
            <li>Never send coins to a collector key.</li>
          </ol>
        </li>
      </ol>
      <p className="small muted">
        Realm <span className="mono break">{config.realmPath}</span> on the {config.networkName} ({config.chainId}).{" "}
        {payee !== "<your address>" && <>Filled in for {shortAddr(payee)}.</>}
      </p>
    </article>
  );
}
