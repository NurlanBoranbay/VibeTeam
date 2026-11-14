import { useEffect, useState, type CSSProperties } from "react";
import { getCallScript, runScenario, type CallScript, type Card, type Plan, type ScenarioParams } from "../api";
import { dateLabel, fullDate, money, money0, monthName, pct } from "../format";
import { useStore } from "../store";
import { cardName, FACES, Fold, go, Meter, NumberField, PageHead, SplitBar, Stat } from "../ui";

/** Runs a scenario on the backend, debounced. `pending` is true until the result for the current params is in. */
function useScenario(params: ScenarioParams | null) {
  const { inputs } = useStore();
  const [result, setResult] = useState<{ baseline: Plan; scenario: Plan } | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify(params);
  useEffect(() => {
    if (!inputs || !params) {
      setResult(null);
      setPending(false);
      return;
    }
    let stale = false;
    setPending(true);
    setFailed(false);
    const timer = setTimeout(() => {
      runScenario(inputs, params)
        .then((r) => {
          if (stale) return;
          setResult(r);
          setPending(false);
        })
        .catch(() => {
          if (stale) return;
          setFailed(true);
          setPending(false);
        });
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs, key, attempt]);
  return { result, pending, failed, retry: () => setAttempt((n) => n + 1) };
}

function Difference({ base, alt }: { base: Plan; alt: Plan }) {
  if (alt.status === "shortfall") {
    return (
      <div className="note danger stack tight">
        <h2>{money(alt.shortfall)} short of the minimum payments</h2>
        <span>Minimum payments need {money(alt.minimums_total)} per payment cycle. No payoff plan or debt-free month is shown below that amount.</span>
      </div>
    );
  }
  if (!alt.forecast || !base.forecast) return <p className="note warn">There is no forecast for this preview. The Plan page shows what is missing.</p>;
  const dm = alt.forecast.months - base.forecast.months;
  const di = alt.forecast.total_interest - base.forecast.total_interest;
  const target = alt.this_cycle.find((p) => p.extra > 0);
  return (
    <div className="grid3">
      <Stat
        label="Estimated debt-free month"
        value={monthName(alt.forecast.debt_free_month)}
        note={`${alt.forecast.months} monthly payments · ${dm === 0 ? "same as your current plan" : `${Math.abs(dm)} ${dm < 0 ? "fewer" : "more"}`}`}
        tone={dm < 0 ? "ok" : dm > 0 ? "warn" : undefined}
      />
      <Stat
        label="Estimated interest"
        value={money(alt.forecast.total_interest)}
        note={Math.abs(di) < 0.005 ? "Same as your current plan" : `${money(Math.abs(di))} ${di < 0 ? "less" : "more"} than your current plan`}
        tone={di < -0.005 ? "ok" : di > 0.005 ? "warn" : undefined}
      />
      <Stat label="Extra goes first to" value={target ? cardName(alt.cards, target.card_id) : "—"} note={alt.strategy === "avalanche" ? "The highest APR" : "The smallest balance"} />
    </div>
  );
}

/** Two balance paths on one graph: the current plan, and the previewed one. */
function PathChart({ base, alt, changed }: { base: Plan; alt: Plan; changed: boolean }) {
  const bf = base.forecast!;
  const af = alt.forecast!;
  const W = 640;
  const H = 260;
  const L = 56;
  const R = 16;
  const T = 16;
  const B = 34;
  const span = Math.max(bf.months, af.months, 1);
  const top = Math.max(base.total_debt, alt.total_debt, 1);
  const x = (i: number) => L + (i / span) * (W - L - R);
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const line = (vals: number[]) => vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = (vals: number[]) => `${line(vals)} L${x(vals.length - 1).toFixed(1)} ${y(0)} L${x(0)} ${y(0)} Z`;
  const dm = bf.months - af.months;
  const di = bf.total_interest - af.total_interest;
  const short = (ym: string | null) => (ym ? `${monthName(ym).slice(0, 3)} ${ym.slice(0, 4)}` : "");
  return (
    <section className="panel stack tight">
      <div className="row">
        <h2>{changed ? "Your debt, two ways" : "Your debt on the current plan"}</h2>
        <span className="path-key small">
          <i className="k-now" /> Now
          {changed && (
            <>
              <i className="k-new" /> Preview
            </>
          )}
        </span>
      </div>
      <svg className="path" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Balance over time. Current plan: debt-free ${monthName(bf.debt_free_month)}.${changed ? ` Preview: debt-free ${monthName(af.debt_free_month)}.` : ""}`}>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(top * t)} y2={y(top * t)} className="path-grid" />
            <text x={L - 8} y={y(top * t) + 4} textAnchor="end" className="path-tick">
              {money0(top * t)}
            </text>
          </g>
        ))}
        <path d={area(bf.balance_by_cycle)} className="path-area now" />
        <path d={line(bf.balance_by_cycle)} className="path-line now" />
        {changed && <path d={area(af.balance_by_cycle)} className="path-area new" />}
        {changed && <path d={line(af.balance_by_cycle)} className="path-line new" />}
        <circle cx={x(bf.months)} cy={y(0)} r="5" className="path-dot now" />
        {changed && <circle cx={x(af.months)} cy={y(0)} r="6" className="path-dot new" />}
        <text x={L} y={H - 10} className="path-tick">
          Today
        </text>
        <text x={x(bf.months)} y={H - 10} textAnchor="end" className="path-tick">
          {short(bf.debt_free_month)}
        </text>
        {changed && Math.abs(x(bf.months) - x(af.months)) > 70 && (
          <text x={x(af.months)} y={H - 10} textAnchor="middle" className="path-tick new">
            {short(af.debt_free_month)}
          </text>
        )}
      </svg>
      {changed ? (
        <p className="path-sum">
          <span>
            Debt-free <b>{monthName(af.debt_free_month)}</b>
          </span>
          <span className={dm > 0 ? "ok" : dm < 0 ? "warn" : "muted"}>{dm === 0 ? "same month" : `${Math.abs(dm)} month${Math.abs(dm) === 1 ? "" : "s"} ${dm > 0 ? "sooner" : "later"}`}</span>
          <span className={di > 0.005 ? "ok" : di < -0.005 ? "warn" : "muted"}>{Math.abs(di) < 0.005 ? "same interest" : `${money(Math.abs(di))} ${di > 0 ? "less" : "more"} interest`}</span>
        </p>
      ) : (
        <p className="path-sum">
          <span>
            Debt-free <b>{monthName(bf.debt_free_month)}</b>
          </span>
          <span className="muted">{money(bf.total_interest)} interest</span>
          <span className="muted">Move the slider to compare</span>
        </p>
      )}
    </section>
  );
}

function Payments({ plan, title }: { plan: Plan; title: string }) {
  const max = Math.max(1, ...plan.this_cycle.map((p) => p.total));
  return (
    <section className="panel stack">
      <h2>{title}</h2>
      {plan.this_cycle.map((p) => (
        <div key={p.card_id} className="track">
          <b>{cardName(plan.cards, p.card_id)}</b>
          <SplitBar payment={p} max={max} />
          <span>{money(p.total)}</span>
        </div>
      ))}
    </section>
  );
}

const ICON = {
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  down: "M12 4v14M6 12l6 6 6-6",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  bag: "M6 8h12l1 12H5zM9 8V6a3 3 0 0 1 6 0v2",
  phone: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  lock: "M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3",
  ban: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8",
  save: "M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5",
};
function Ico({ d, size }: { d: string; size?: number }) {
  return (
    <svg className="ico" width={size ?? 20} height={size ?? 20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/**
 * One month that is different: extra money to place, or less to pay. Nothing is saved; it shows
 * where to send this month's money and what it does to the plan.
 */
function ThisMonth() {
  const { inputs, plan } = useStore();
  const [kind, setKind] = useState<"extra" | "less">("extra");
  const [amount, setAmount] = useState<number | null>(null);
  const [choice, setChoice] = useState("pay");
  const min = plan?.minimums_total ?? 0;
  const base = inputs?.budget ?? 0;
  const below = kind === "less" && amount !== null && amount < min;
  const notLess = kind === "less" && amount !== null && amount >= base;
  const valid = amount !== null && amount > 0 && !below && !notLess;
  const { result, pending, failed, retry } = useScenario(valid ? (kind === "extra" ? { one_time: amount! } : { low_month_index: 1, low_month_budget: amount! }) : null);
  if (!inputs || !plan) return null;
  const fresh = valid && result && !pending && !failed ? result : null;
  const bf = fresh?.baseline.forecast;
  const sf = fresh?.scenario.forecast;
  const sooner = bf && sf ? bf.months - sf.months : 0;
  const saved = bf && sf ? bf.total_interest - sf.total_interest : 0;
  const target = fresh?.scenario.this_cycle.find((p) => p.extra > 0);
  const top = plan.cards.filter((c) => c.apr !== null && c.balance > 0).sort((a, b) => (b.apr ?? 0) - (a.apr ?? 0))[0];
  const months = (n: number) => `${n} month${n === 1 ? "" : "s"}`;
  return (
    <div className="stack">
      <div className="picks" role="radiogroup" aria-label="What changed this month">
        <button type="button" role="radio" aria-checked={kind === "extra"} className={kind === "extra" ? "pick on" : "pick"} onClick={() => { setKind("extra"); setAmount(null); }}>
          <Ico d={ICON.plus} size={26} />
          <b>I have extra money</b>
          <span className="small muted">A bonus, a refund, a gift</span>
        </button>
        <button type="button" role="radio" aria-checked={kind === "less"} className={kind === "less" ? "pick on" : "pick"} onClick={() => { setKind("less"); setAmount(null); }}>
          <Ico d={ICON.minus} size={26} />
          <b>I can pay less</b>
          <span className="small muted">A surprise bill, a slow month</span>
        </button>
      </div>
      <div style={{ maxWidth: 340 }}>
        {kind === "extra" ? (
          <NumberField id="tm-extra" label="How much extra? ($)" value={amount} onChange={setAmount} step="10" placeholder="300" />
        ) : (
          <NumberField id="tm-less" label="What can you pay this month? ($)" value={amount} onChange={setAmount} step="10" placeholder={String(Math.max(min, base - 100))} hint={`Usually ${money(base)}. Your minimums are ${money(min)}.`} />
        )}
      </div>

      {below && (
        <div className="note danger stack tight">
          <b>That is {money(min - (amount ?? 0))} below your minimum payments.</b>
          <span>Paying less than the minimum usually means a late fee and can hurt your credit history. Call the bank before the due date; many have a hardship option.</span>
          <a className="btn ghost small" href="#/bank">
            Prepare the call
          </a>
        </div>
      )}
      {notLess && <p className="muted">That is not less than your usual {money(base)}.</p>}
      {valid && failed && (
        <div className="note danger stack tight">
          <span>We couldn’t calculate this. Please try again.</span>
          <button type="button" className="btn ghost small" onClick={retry}>
            Try again
          </button>
        </div>
      )}
      {valid && !fresh && !failed && <p className="muted">Calculating…</p>}

      {fresh && kind === "extra" && (
        <>
          <div className="opts" role="radiogroup" aria-label="What to do with the extra money">
            <button type="button" role="radio" aria-checked={choice === "pay"} className={choice === "pay" ? "opt on best" : "opt best"} onClick={() => setChoice("pay")}>
              <Ico d={ICON.down} size={24} />
              <b>Pay down debt</b>
              <span className="opt-big">{sooner > 0 ? `${months(sooner)} sooner` : "Same debt-free month"}</span>
              <span className="small ok">{saved > 0.005 ? `Saves ${money(saved)} interest` : "No interest saved"}</span>
              {target && <span className="small muted">Goes to {cardName(plan.cards, target.card_id)}</span>}
            </button>
            <button type="button" role="radio" aria-checked={choice === "save"} className={choice === "save" ? "opt on" : "opt"} onClick={() => setChoice("save")}>
              <Ico d={ICON.shield} size={24} />
              <b>Keep as a cushion</b>
              <span className="opt-big">{money(amount!)} set aside</span>
              <span className="small muted">{top ? `A surprise bill won’t land on a card at ${top.apr}%.` : "A surprise bill won’t land on a card."}</span>
            </button>
            <button type="button" role="radio" aria-checked={choice === "spend"} className={choice === "spend" ? "opt on" : "opt"} onClick={() => setChoice("spend")}>
              <Ico d={ICON.bag} size={24} />
              <b>Spend it</b>
              <span className="opt-big">Plan stays the same</span>
              <span className="small muted">You just don’t speed up. No judgment.</span>
            </button>
          </div>
          {choice === "pay" ? (
            <>
              <Payments plan={fresh.scenario} title="Send this month" />
              <p className="small muted">
                After you pay, <a href="#/update">update the card’s balance</a> so the plan stays right.
              </p>
            </>
          ) : (
            <p className="muted">Nothing to change. Your plan and this month’s payments stay as they are.</p>
          )}
        </>
      )}

      {fresh && kind === "less" && (
        <>
          <Difference base={fresh.baseline} alt={fresh.scenario} />
          <Payments plan={fresh.scenario} title="Pay this month" />
          <p className="small muted">Every minimum is still covered. From next month the plan goes back to {money(base)}.</p>
        </>
      )}
    </div>
  );
}

/** A purchase put on a card: what it really costs in interest and how much later the debt is gone. */
function ShouldBuy() {
  const { inputs, plan } = useStore();
  const [amount, setAmount] = useState<number | null>(null);
  const [cardId, setCardId] = useState<string | null>(null);
  const cards = plan?.cards ?? [];
  const card = cards.find((c) => c.id === cardId) ?? cards[0];
  const valid = amount !== null && amount > 0 && !!card;
  const { result, pending, failed, retry } = useScenario(valid ? { balance_add: { [card.id]: amount! } } : null);
  if (!inputs || !plan || !card) return null;
  const fresh = valid && result && !pending && !failed ? result : null;
  const bf = fresh?.baseline.forecast;
  const sf = fresh?.scenario.forecast;
  const lastDue = (f: NonNullable<Plan["forecast"]>) => f.due_dates.map((d) => d.due).sort().pop();
  const cost = bf && sf ? sf.total_interest - bf.total_interest : 0;
  const a = bf ? lastDue(bf) : undefined;
  const b = sf ? lastDue(sf) : undefined;
  const days = bf && sf ? (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 86400000) : (sf.months - bf.months) * 30) : 0;
  return (
    <div className="stack">
      <div className="fields" style={{ maxWidth: 560 }}>
        <NumberField id="buy-amount" label="Price of the purchase ($)" value={amount} onChange={setAmount} step="10" placeholder="400" />
        <div className="field">
          <label htmlFor="buy-card">Put it on</label>
          <select id="buy-card" value={card.id} onChange={(e) => setCardId(e.target.value)}>
            {cards.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.apr === null ? "" : ` · ${c.apr}%`}
              </option>
            ))}
          </select>
        </div>
      </div>
      {valid && failed && (
        <div className="note danger stack tight">
          <span>We couldn’t calculate this. Please try again.</span>
          <button type="button" className="btn ghost small" onClick={retry}>
            Try again
          </button>
        </div>
      )}
      {valid && !fresh && !failed && <p className="muted">Calculating…</p>}
      {fresh && (!bf || !sf) && <p className="note warn">Add every card’s APR to see what a purchase costs.</p>}
      {fresh && bf && sf && (
        <>
          <p className="buy-line">
            A {money(amount!)} purchase on {card.name} really costs <b>{money(amount! + cost)}</b>.
          </p>
          <div className="grid3">
            <Stat label="Extra interest" value={money(cost)} note="On top of the price" tone={cost > 0.005 ? "warn" : undefined} />
            <Stat label="Debt-free" value={days > 0 ? `${days} days later` : "Same day"} note={monthName(sf.debt_free_month)} tone={days > 0 ? "warn" : undefined} />
            <Stat label="If you skip it" value={monthName(bf.debt_free_month)} note="Your plan stays as it is" tone="ok" />
          </div>
          <p className="small muted">Assumes you keep paying {money(inputs.budget)} a month. Nothing is changed in your plan.</p>
        </>
      )}
    </div>
  );
}

/** Preview another monthly budget against the current plan, then apply it. Only the budget can be changed here. */
export function WhatIf() {
  const { inputs, plan, setInputs } = useStore();
  const base = inputs?.budget ?? 0;
  const [budget, setBudget] = useState(base);
  const [tab, setTab] = useState("monthly");
  const { result, pending, failed, retry } = useScenario(inputs ? { scenario_budget: budget } : null);
  if (!inputs || !plan) return <main className="page muted">Calculating…</main>;
  if (plan.status === "limited" || plan.status === "pay_in_full") {
    return (
      <main className="page">
        <PageHead title="What if I pay more?">What-if needs a full forecast, and one of your cards can’t be forecast yet.</PageHead>
        <a className="btn" href="#/plan">
          See what is missing
        </a>
      </main>
    );
  }
  const changed = budget !== base;
  const fresh = result && !pending && !failed && result.scenario.budget === budget ? result : null;
  const low = Math.max(10, Math.floor(plan.minimums_total / 10) * 10 - 50);
  const high = Math.max(1000, base * 2);
  return (
    <main className="page">
      <PageHead title="What if I pay more?" image="/img/fp-icon-arrows-cycle.jpg">
        Try another amount, or a month with extra or less money.
      </PageHead>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "monthly"} className={tab === "monthly" ? "tab on" : "tab"} onClick={() => setTab("monthly")}>
          Every month
        </button>
        <button type="button" role="tab" aria-selected={tab === "once"} className={tab === "once" ? "tab on" : "tab"} onClick={() => setTab("once")}>
          Just this month
        </button>
        <button type="button" role="tab" aria-selected={tab === "buy"} className={tab === "buy" ? "tab on" : "tab"} onClick={() => setTab("buy")}>
          Should I buy it?
        </button>
      </div>
      {tab === "once" ? (
        <ThisMonth />
      ) : tab === "buy" ? (
        <ShouldBuy />
      ) : (
      <div className="split wide-right">
        <section className="panel stack">
          <span className="pill">Your current plan · {money(base)} a month</span>
          <div className="slider">
            <div className="row">
              <label htmlFor="wi-budget">I can pay each month</label>
              <b className="big">{money(budget)}</b>
            </div>
            <div className="wi-range">
              <input
                id="wi-budget"
                type="range"
                min={low}
                max={high}
                step={10}
                value={budget}
                style={{ "--fill": `${((budget - low) / (high - low)) * 100}%` } as CSSProperties}
                onChange={(e) => setBudget(Number(e.target.value))}
              />
              <span className="wi-now" style={{ left: `${((base - low) / (high - low)) * 100}%` }}>
                now
              </span>
            </div>
            <div className="wi-ends small muted">
              <span>{money(low)}</span>
              <span>{money(high)}</span>
            </div>
            <span className="small muted">
              Now {money(base)}. Minimums take {money(plan.minimums_total)}.
            </span>
          </div>
          <div className={changed && fresh && fresh.scenario.status !== "shortfall" ? "apply ready" : "apply"}>
            <b className="apply-head">{changed ? `Keep ${money(budget)} a month?` : "Move the slider to try another amount"}</b>
            <button
              type="button"
              className="btn apply-btn"
              disabled={!changed || !fresh || fresh.scenario.status === "shortfall"}
              onClick={() => {
                setInputs({ ...inputs, budget, first_month_budget: null });
                go("plan");
              }}
            >
              {changed ? `Make ${money(budget)} my monthly budget` : "Make this my monthly budget"}
            </button>
            <span className="small muted">Updates your whole plan. You can change it back any time.</span>
            {changed && (
              <button type="button" className="link small" onClick={() => setBudget(base)}>
                Back to {money(base)}
              </button>
            )}
          </div>
        </section>

        <section className="stack" aria-live="polite" aria-busy={pending}>
          <span className={changed ? "pill accent" : "pill"}>{changed ? `Preview · ${money(budget)} a month` : "Your current plan"}</span>
          {failed ? (
            <div className="note danger stack tight">
              <span>We couldn’t calculate this preview. Please try again.</span>
              <button type="button" className="btn ghost small" onClick={retry}>
                Try again
              </button>
            </div>
          ) : !fresh ? (
            <p className="muted">Recalculating…</p>
          ) : (
            <>
              {fresh.baseline.forecast && fresh.scenario.forecast ? <PathChart base={fresh.baseline} alt={fresh.scenario} changed={changed} /> : <Difference base={fresh.baseline} alt={fresh.scenario} />}
              {fresh.scenario.status !== "shortfall" && <Payments plan={fresh.scenario} title="This month’s payments" />}
            </>
          )}
          <Fold title="How this is calculated">
            <p className="small muted">
              {plan.missing_apr.length > 0 && plan.strategy === "avalanche"
                ? `Minimums are paid first. Add the APR for ${plan.missing_apr.join(" and ")} to decide where the rest goes.`
                : `Minimums are paid first. Everything above them goes to ${plan.strategy === "avalanche" ? "the highest APR" : "the smallest balance"}. Plain arithmetic, no AI, same assumptions as your plan.`}
            </p>
          </Fold>
        </section>
      </div>
      )}
    </main>
  );
}

export function BankCall() {
  const { inputs, plan, setInputs } = useStore();
  const withApr = (plan?.cards ?? []).filter((c) => c.apr !== null && c.balance > 0).sort((a, b) => (b.apr ?? 0) - (a.apr ?? 0));
  const [cardId, setCardId] = useState<string | null>(null);
  const [script, setScript] = useState<CallScript | null>(null);
  const [scriptError, setScriptError] = useState("");
  const [scriptTry, setScriptTry] = useState(0);
  const [newApr, setNewApr] = useState<number | null>(null);
  const card: Card | undefined = withApr.find((c) => c.id === cardId) ?? withApr[0];
  const planned = plan?.this_cycle.find((p) => p.card_id === card?.id)?.total ?? card?.minimum ?? 0;

  useEffect(() => {
    if (!card || planned <= 0) return;
    let stale = false;
    setScript(null);
    getCallScript(card, planned)
      .then((s) => {
        if (!stale) {
          setScript(s);
          setScriptError("");
        }
      })
      .catch(() => {
        if (!stale) setScriptError("We couldn’t prepare the script. Please try again.");
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id, card?.apr, card?.balance, planned, scriptTry]);

  const offerValid = card && newApr !== null && newApr >= 0 && newApr < (card.apr ?? 0);
  const { result, pending: offerPending } = useScenario(offerValid && card ? { apr_overrides: { [card.id]: newApr! } } : null);

  if (!inputs || !plan) return <main className="page muted">Calculating…</main>;
  if (!card) {
    return (
      <main className="page">
        <PageHead title="Ask for a lower APR">Add the APR of at least one card with a balance to prepare a call.</PageHead>
        <a className="btn" href="#/setup/3">
          Add an APR
        </a>
      </main>
    );
  }
  return (
    <main className="page">
      <PageHead title="Ask for a lower APR" image="/img/fp-icon-phone.jpg">
        A 10-minute call. If the bank says yes, enter the new rate and your plan updates.
      </PageHead>
      <div className="split">
        <section className="panel stack">
          <div className="row">
            <h2 className="with-ico">
              <Ico d={ICON.phone} /> What to say
            </h2>
            <div className="actions">
              {withApr.map((c) => (
                <button key={c.id} type="button" className={`btn ghost small ${c.id === card.id ? "on" : ""}`} aria-pressed={c.id === card.id} onClick={() => setCardId(c.id)}>
                  {c.name} · {c.apr}%
                </button>
              ))}
            </div>
          </div>
          {scriptError && (
            <div className="note danger stack tight">
              <span>{scriptError}</span>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  setScriptError("");
                  setScriptTry((n) => n + 1);
                }}
              >
                Try again
              </button>
            </div>
          )}
          <p className="tip">
            <Ico d={ICON.phone} size={18} /> Call the number on the back of your card. It is the only one sure to be right.
          </p>
          {!script && !scriptError && <p className="muted">Preparing the script…</p>}
          {script?.lines.map((l) => (
            <div key={l.step} className="line">
              <span className="small muted line-step">{l.label}</span>
              <p>{l.say}</p>
            </div>
          ))}
          {script && (
            <div className="actions">
              <button type="button" className="btn ghost" onClick={() => navigator.clipboard?.writeText(script.lines.map((l) => l.say).join("\n\n")).catch(() => undefined)}>
                <Ico d={ICON.copy} size={18} /> Copy script
              </button>
              <span className="small muted">{script.source === "ai" ? "Worded by AI. The figures come from your plan and were checked." : "Standard wording with your plan's figures."}</span>
            </div>
          )}
        </section>
        <aside className="stack">
          <section className="panel stack tight">
            <h2>Questions to ask back</h2>
            {(script?.questions ?? []).map((q) => (
              <label key={q} className="check">
                <input type="checkbox" />
                <span>{q}</span>
              </label>
            ))}
          </section>
          <p className="small muted">{script?.disclaimer ?? "The bank decides. A lower rate and any saving are not guaranteed."}</p>
        </aside>
      </div>

      <section className="panel stack">
        <h2>What did the bank offer?</h2>
        <p className="muted">Enter only a rate the bank has confirmed for {card.name}.</p>
        <div style={{ maxWidth: 260 }}>
          <NumberField id="offer-apr" label={`New APR (%), today ${card.apr}%`} value={newApr} onChange={setNewApr} max={100} placeholder="21.9" />
        </div>
        {newApr !== null && !offerValid && <p className="note warn">Enter a rate below the current {card.apr}%.</p>}
        {offerValid && offerPending && <p className="muted">Recalculating…</p>}
        {offerValid && !offerPending && result && result.scenario.forecast && result.baseline.forecast && (
          <>
            <Difference base={result.baseline} alt={result.scenario} />
            <div className="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Payments this cycle</th>
                    <th className="r">At {card.apr}%</th>
                    <th className="r">At {newApr}%</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.cards.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <b>{c.name}</b>
                      </td>
                      <td className="r muted">{money(result.baseline.this_cycle.find((p) => p.card_id === c.id)?.total ?? 0)}</td>
                      <td className="r">
                        <b>{money(result.scenario.this_cycle.find((p) => p.card_id === c.id)?.total ?? 0)}</b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setInputs({ ...inputs, cards: inputs.cards.map((c) => (c.id === card.id ? { ...c, apr: newApr } : c)) });
                  setNewApr(null);
                  go("plan");
                }}
              >
                Apply to my plan
              </button>
              <span className="small muted">The saving is an estimate against your current plan under the same assumptions.</span>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

const FAN_HEAD = 400; // height of the heading area the fan sits behind
const FAN_ROW = 320; // vertical space one drawn card takes below it
const CARD_W = 190; // the card never changes size: portrait in the fan, turned a quarter when drawn
const CARD_H = 300;

/**
 * Cards sit in a fan behind the heading, like a hand of playing cards. Each is a real two-sided
 * card: tapping one moves it to a row below while it turns a quarter and flips over, showing a back
 * that is printed landscape. The card never changes shape and its text never moves.
 */
export function UpdateBalances() {
  const { inputs, plan, setInputs, progress, markPaid } = useStore();
  const [draft, setDraft] = useState<Card[]>(inputs?.cards ?? []);
  const [drawn, setDrawn] = useState<string[]>([]); // card ids, in the order they were tapped
  const [moved, setMoved] = useState<string[]>([]); // cards that have been tapped at least once: only these animate
  const [editing, setEditing] = useState<string[]>([]); // drawn cards whose fields are open
  // money still available for cards this month: asked for, never assumed to be the whole budget again
  const [left, setLeft] = useState<number | null>(inputs?.first_month_budget ?? null);
  if (!inputs || !plan) return <main className="page muted">Calculating…</main>;

  const patch = (id: string, change: Partial<Card>) => setDraft(draft.map((c) => (c.id === id ? { ...c, ...change } : c)));
  // functional updates: two quick taps on different cards must both count
  const toggle = (id: string) => {
    setDrawn((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));
    setMoved((now) => (now.includes(id) ? now : [...now, id]));
  };
  const original = (id: string) => inputs.cards.find((c) => c.id === id);
  const changed = draft.filter((c) => JSON.stringify(c) !== JSON.stringify(original(c.id))).length;
  const mid = (draft.length - 1) / 2;
  const use = plan.limit_use;
  const flip = (id: string) => setEditing((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));

  return (
    <main className="page">
      <section className="fan" aria-label="Your cards" style={{ height: FAN_HEAD + Math.max(drawn.length * FAN_ROW, 300) }}>
        <div className="fan-head">
          <h1>Your cards</h1>
          <p className="lede">Tap a card to see everything about it. Tap Edit to change it.</p>
        </div>

        {drawn.length === 0 && (
          <div className="panel stack tight fan-summary">
            <h2>
              {draft.length} card{draft.length === 1 ? "" : "s"}, {money(draft.reduce((sum, c) => sum + c.balance, 0))} owed
            </h2>
            <dl className="kv">
              <dt>Minimums this month</dt>
              <dd>{money(plan.minimums_total)}</dd>
              <dt>Planned this month</dt>
              <dd>{money(plan.this_cycle.reduce((sum, p) => sum + p.total, 0))}</dd>
              {use.complete && (
                <>
                  <dt>Credit usage, all cards</dt>
                  <dd>
                    {pct(use.now_pct)}
                    {use.after_pct !== null ? ` → ${pct(use.after_pct)} in 3 months` : ""}
                  </dd>
                </>
              )}
              {progress.paid > 0 && (
                <>
                  <dt>Payments marked paid</dt>
                  <dd>{progress.paid}</dd>
                </>
              )}
              <dt>Cards changed</dt>
              <dd>
                {changed} of {draft.length}
              </dd>
            </dl>
            <span className="small muted">Tap any card above to open it here.</span>
          </div>
        )}

        {draft.flatMap((c, i) => {
          const slot = drawn.indexOf(c.id);
          const isDrawn = slot >= 0;
          const look = FACES[i % FACES.length];
          const planned = plan.this_cycle.find((p) => p.card_id === c.id);
          const estimate = plan.cycles[0]?.balances[c.id];
          const before = original(c.id);
          const diff = estimate !== undefined && before && c.balance !== before.balance ? c.balance - estimate : null;
          // The element is always CARD_W x CARD_H. Drawn, it is a quarter turn round and flipped over, so
          // it shows its landscape back as a CARD_H x CARD_W card whose top-left corner sits at (0, row).
          const row = FAN_HEAD + Math.max(slot, 0) * FAN_ROW;
          const place = {
            "--x": isDrawn ? `${(CARD_H - CARD_W) / 2}px` : `calc(70% + ${(i - mid) * 112 - 95}px)`,
            "--y": isDrawn ? `${row - (CARD_H - CARD_W) / 2}px` : `${34 + Math.abs(i - mid) * 26}px`,
            "--r": isDrawn ? "-90deg" : `${(i - mid) * 13}deg`,
            "--flip": isDrawn ? "180deg" : "0deg",
            "--face": look.face,
            "--edge": look.edge,
            "--glow": look.glow,
            "--shine-delay": `${i * -4.33}s`,
            zIndex: isDrawn ? 10 : i + 1,
          } as CSSProperties;
          const apr = c.apr === null ? "APR not entered" : `${c.apr}% APR`;
          const card = (
            <button
              key={c.id}
              type="button"
              className={isDrawn ? "fan-card drawn toss" : moved.includes(c.id) ? "fan-card back" : "fan-card"}
              style={place}
              aria-pressed={isDrawn}
              aria-label={isDrawn ? `Put ${c.name} back in the fan` : `Open ${c.name}`}
              onClick={() => toggle(c.id)}
            >
              <span className="fan-face">
                <span className="fan-content">
                  <span className="fan-top">
                    <b>{c.name}</b>
                    <span>{apr}</span>
                  </span>
                  <span className="fan-chip" aria-hidden="true" />
                  <span className="fan-bottom">
                    <span>Balance</span>
                    <b>{money(c.balance)}</b>
                    <span>{c.due_day ? `Due day ${c.due_day}` : "No due day"}</span>
                  </span>
                </span>
              </span>
              <span className="fan-face rear" aria-hidden={!isDrawn}>
                <span className="fan-content">
                  <span className="fan-top">
                    <b>{c.name}</b>
                    <span>{apr}</span>
                  </span>
                  <span className="fan-bottom">
                    <span>Current balance</span>
                    <b>{money(c.balance)}</b>
                    <span>
                      Minimum {money(c.minimum)}
                      {c.due_day ? ` · due day ${c.due_day}` : ""}
                    </span>
                  </span>
                </span>
              </span>
            </button>
          );
          if (!isDrawn) return [card];
          const u = use.cards.find((x) => x.card_id === c.id);
          const open = editing.includes(c.id);
          return [
            card,
            <div key={`${c.id}-info`} className="fan-info stack tight" style={{ "--dy": `${FAN_HEAD + slot * FAN_ROW}px` } as CSSProperties}>
              <div className="row">
                <h2>{c.name}</h2>
                <button type="button" className={open ? "edit-btn on" : "edit-btn"} aria-expanded={open} onClick={() => flip(c.id)}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d={open ? "M5 12.5l4.5 4.5L19 7.5" : "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"} />
                  </svg>
                  {open ? "Done" : "Edit"}
                </button>
              </div>
              {open ? (
                <div key="edit" className="fields fan-body">
                  <div className="field">
                    <label htmlFor={`${c.id}-uname`}>Card name</label>
                    <input id={`${c.id}-uname`} maxLength={40} value={c.name} placeholder="Chase" onChange={(e) => patch(c.id, { name: e.target.value })} />
                  </div>
                  <NumberField
                    id={`${c.id}-ubal`}
                    label="Current balance ($)"
                    value={c.balance}
                    onChange={(v) => patch(c.id, { balance: v ?? 0 })}
                    hint={diff === null ? undefined : Math.abs(diff) < 0.005 ? "Matches the estimate" : `${money(Math.abs(diff))} ${diff > 0 ? "above" : "below"} the estimate`}
                  />
                  <NumberField id={`${c.id}-uapr`} label="APR (%)" value={c.apr} onChange={(v) => patch(c.id, { apr: v })} max={100} />
                  <NumberField id={`${c.id}-umin`} label="Minimum due ($)" value={c.minimum} onChange={(v) => patch(c.id, { minimum: v ?? 0 })} />
                  <NumberField id={`${c.id}-udue`} label="Due day" value={c.due_day} onChange={(v) => patch(c.id, { due_day: v })} step="1" max={31} />
                  <NumberField id={`${c.id}-ulim`} label="Credit limit ($)" value={c.limit} onChange={(v) => patch(c.id, { limit: v })} />
                </div>
              ) : (
                <div key="view" className="fan-body stack tight">
                  <dl className="facts">
                    <div>
                      <dt>Balance</dt>
                      <dd>{money(c.balance)}</dd>
                    </div>
                    <div>
                      <dt>APR</dt>
                      <dd>{c.apr === null ? "Not entered" : `${c.apr}%`}</dd>
                    </div>
                    <div>
                      <dt>Minimum</dt>
                      <dd>{money(c.minimum)}</dd>
                    </div>
                    <div>
                      <dt>Due day</dt>
                      <dd>{c.due_day ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Pay this month</dt>
                      <dd>{planned ? `${money(planned.total)}${planned.due ? ` by ${dateLabel(planned.due)}` : ""}` : "Nothing"}</dd>
                    </div>
                    <div>
                      <dt>Balance after, est.</dt>
                      <dd>{estimate !== undefined ? money(estimate) : "—"}</dd>
                    </div>
                    <div>
                      <dt>Credit limit</dt>
                      <dd>{c.limit === null ? "Not entered" : money0(c.limit)}</dd>
                    </div>
                    <div>
                      <dt>Paid off</dt>
                      <dd>{plan.forecast?.payoff_month[c.id] ? monthName(plan.forecast.payoff_month[c.id]) : "—"}</dd>
                    </div>
                  </dl>
                  {planned && estimate !== undefined && c.balance !== estimate && (
                    <button type="button" className="btn ghost small paid-btn" onClick={() => { patch(c.id, { balance: estimate, min_paid: true }); setLeft(Math.max(0, (left ?? inputs.budget) - planned.total)); markPaid(); }}>
                      I paid {money(planned.total)} · set balance to {money(estimate)}
                    </button>
                  )}
                  {u ? (
                    <div className="usage">
                      <span className="small muted">Credit usage</span>
                      <Meter value={u.now_pct} />
                      <span className="small">
                        <b>{pct(u.now_pct)}</b> now
                        {u.after_pct !== null ? ` → ${pct(u.after_pct)}${use.after_date ? ` by ${fullDate(use.after_date)}` : " in 3 months"}` : ""}
                      </span>
                    </div>
                  ) : (
                    <span className="small muted">
                      Add a credit limit to see credit usage.{" "}
                      <button type="button" className="link" onClick={() => flip(c.id)}>
                        Add it
                      </button>
                    </span>
                  )}
                </div>
              )}
            </div>,
          ];
        })}
      </section>

      <div style={{ maxWidth: 380 }}>
        <NumberField
          id="left-month"
          label="Left to pay toward cards this month ($)"
          value={left}
          onChange={setLeft}
          step="10"
          placeholder={String(inputs.budget)}
          help="An updated balance already includes what you paid. If part of this month’s budget is spent, enter what is left so it is not counted twice. Leave empty if nothing has been paid yet."
        />
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={changed === 0 && left === (inputs.first_month_budget ?? null)}
          onClick={() => {
            setInputs({ ...inputs, cards: draft, first_month_budget: left });
            go("plan");
          }}
        >
          Recalculate my plan
        </button>
        <span className="small muted">
          {changed} of {draft.length} cards changed. Each balance is a fresh snapshot: earlier payments are not subtracted again. Use the balance in your banking app, or <a href="#/import">read it from a statement photo</a>. Lower credit usage may help your credit score; results depend on your full credit profile.
        </span>
      </div>
    </main>
  );
}

export function YourData() {
  const { inputs, isDemo, saveOnDevice, setSaveOnDevice, deleteAll, loadDemo } = useStore();
  const [confirming, setConfirming] = useState(false);
  return (
    <main className="page">
      <PageHead title="Your data">No account. Nothing is sent to a bank or a credit bureau.</PageHead>
      <section className="grid3">
        <div className="panel stack tight data-tile">
          <span className="data-ico">
            <Ico d={ICON.list} size={24} />
          </span>
          <h2>What you enter</h2>
          <ul className="muted list">
            <li>Card nicknames</li>
            <li>Balances, APRs, minimums</li>
            <li>Due days and limits</li>
            <li>Monthly budget</li>
          </ul>
        </div>
        <div className="panel stack tight data-tile">
          <span className="data-ico">
            <Ico d={ICON.lock} size={24} />
          </span>
          <h2>Where it goes</h2>
          <ul className="muted list">
            <li>To our server, only to calculate</li>
            <li>Never stored there</li>
            <li>Never shared or sold</li>
          </ul>
        </div>
        <div className="panel stack tight data-tile">
          <span className="data-ico">
            <Ico d={ICON.ban} size={24} />
          </span>
          <h2>What we never ask</h2>
          <ul className="muted list">
            <li>Name, email, sign-up</li>
            <li>Social Security number</li>
            <li>Card numbers</li>
            <li>Bank login</li>
          </ul>
        </div>
      </section>
      <div className="grid2">
        <section className="panel stack tight">
          <label className="check">
            <input type="checkbox" checked={saveOnDevice} disabled={isDemo} onChange={(e) => setSaveOnDevice(e.target.checked)} />
            <span>
              <b className="with-ico">
                <Ico d={ICON.save} size={18} /> Save my plan on this device
              </b>
              <span className="small muted">Off by default. When off, your numbers are gone when you close the tab.</span>
            </span>
          </label>
          {isDemo && <p className="small muted">The demo example is never saved.</p>}
          <p className="note warn">On a shared computer, leave this off.</p>
        </section>
        <section className="panel stack tight">
          <h2 className="with-ico">
            <Ico d={ICON.trash} /> Delete everything
          </h2>
          <p className="muted">Removes your cards and budget from this browser. It cannot be undone.</p>
          <div className="actions">
            {!confirming ? (
              <button type="button" className="btn danger" disabled={!inputs} onClick={() => setConfirming(true)}>
                Delete my data
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => {
                    deleteAll();
                    setConfirming(false);
                    go("");
                  }}
                >
                  Yes, delete everything
                </button>
                <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>
                  Keep it
                </button>
              </>
            )}
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                loadDemo();
                go("plan");
              }}
            >
              Load the demo example
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
