import { useEffect, useState, type CSSProperties } from "react";
import { getCallScript, paidToward, runScenario, type CallScript, type Card, type Plan, type ScenarioParams } from "../api";
import { dateLabel, fullDate, money, money0, monthName, pct } from "../format";
import { useStore } from "../store";
import { FlowBar } from "./PlanPages";
import { cardName, CardColorPicker, DateField, faceStyle, Fold, go, Meter, NumberField, PageHead, prettyDate, SplitBar, Stat, useFaces } from "../ui";

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
        <span>Minimum payments need {money(alt.minimums_total)} per month. No payoff plan or debt-free month is shown below that amount.</span>
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
function PathChart({ base, alt, changed, floor }: { base: Plan; alt: Plan; changed: boolean; floor: Plan | null }) {
  const bf = base.forecast!;
  const af = alt.forecast!;
  const W = 640;
  const H = 260;
  const L = 56;
  const R = 16;
  const T = 16;
  const B = 54;
  const span = Math.max(bf.months, af.months, 1);
  // the minimums path usually runs for years: it is drawn only as far as the graph goes
  const least = floor?.forecast ? floor.forecast.balance_by_cycle.slice(0, span + 1) : null;
  const top = Math.max(base.total_debt, alt.total_debt, 1);
  const x = (i: number) => L + (i / span) * (W - L - R);
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const line = (vals: number[]) => vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = (vals: number[]) => `${line(vals)} L${x(vals.length - 1).toFixed(1)} ${y(0)} L${x(0)} ${y(0)} Z`;
  const dm = bf.months - af.months;
  const di = bf.total_interest - af.total_interest;
  const anchor = (px: number) => (px > W - 90 ? "end" : px < L + 50 ? "start" : "middle");
  const short = (ym: string | null) => (ym ? `${monthName(ym).slice(0, 3)} ${ym.slice(0, 4)}` : "");
  return (
    <section className="panel stack tight">
      <div className="row">
        <h2>{changed ? "Your debt, two ways" : "Your debt on the current plan"}</h2>
        <span className="path-key small">
          <i className="k-now" /> {money(base.budget)}
          {changed && (
            <>
              <i className="k-new" /> {money(alt.budget)}
            </>
          )}
          {least && floor && (
            <>
              <i className="k-min" /> {money(floor.budget)} minimum
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
        {least && <path d={line(least)} className="path-line min" />}
        <path d={area(bf.balance_by_cycle)} className="path-area now" />
        <path d={line(bf.balance_by_cycle)} className="path-line now" />
        {changed && <path d={area(af.balance_by_cycle)} className="path-area new" />}
        {changed && <path d={line(af.balance_by_cycle)} className="path-line new" />}
        <circle cx={x(bf.months)} cy={y(0)} r="5" className="path-dot now" />
        {changed && <circle cx={x(af.months)} cy={y(0)} r="6" className="path-dot new" />}
        {/* two rows of month labels: the current plan above, the preview below, each kept inside the graph */}
        {x(bf.months) > L + 130 && (
          <text x={L} y={H - 28} className="path-tick">
            Today
          </text>
        )}
        <text x={x(bf.months)} y={H - 28} textAnchor={anchor(x(bf.months))} className="path-tick now">
          {short(bf.debt_free_month)}
        </text>
        {changed && (
          <text x={x(af.months)} y={H - 8} textAnchor={anchor(x(af.months))} className="path-tick new">
            {short(af.debt_free_month)}
          </text>
        )}
      </svg>
      {changed ? (
        <p className="path-sum">
          <span>
            Last payment <b>{monthName(af.debt_free_month)}</b>
          </span>
          <span className={dm > 0 ? "ok" : dm < 0 ? "warn" : "muted"}>{dm === 0 ? "same month" : `${Math.abs(dm)} month${Math.abs(dm) === 1 ? "" : "s"} ${dm > 0 ? "sooner" : "later"}`}</span>
          <span className={di > 0.005 ? "ok" : di < -0.005 ? "warn" : "muted"}>{Math.abs(di) < 0.005 ? "same interest" : `${money(Math.abs(di))} ${di > 0 ? "less" : "more"} interest`}</span>
        </p>
      ) : (
        <p className="path-sum">
          <span>
            Last payment <b>{monthName(bf.debt_free_month)}</b>
          </span>
          <span className="muted">{money(bf.total_interest)} interest</span>
          {floor?.forecast && <span className="warn">At {money(floor.budget)} a month: {monthName(floor.forecast.debt_free_month)}</span>}
        </p>
      )}
    </section>
  );
}

/** This month's payments as the same one-bar picture the Plan uses: a slice per card, the extra in green. */
function Payments({ plan, title }: { plan: Plan; title: string }) {
  const [hot, setHot] = useState<string | null>(null);
  const rows = plan.this_cycle.map((p) => ({ p, card: plan.cards.find((c) => c.id === p.card_id)! }));
  return <FlowBar plan={plan} rows={rows} hot={hot} setHot={setHot} title={title} detail />;
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
 * One month that is different: extra money to place, or less to pay. The person asks for a
 * preview, sees what each card gets and what it does to the plan, then applies it to this month only.
 * The monthly budget from the next month on is not changed.
 */
function ThisMonth() {
  const { inputs, plan, update } = useStore();
  const [kind, setKind] = useState<"extra" | "less">("extra");
  const [amount, setAmount] = useState<number | null>(null);
  const [asked, setAsked] = useState<number | null>(null); // the amount the current preview is for
  const [choice, setChoice] = useState("pay");
  const min = plan?.minimums_total ?? 0;
  const base = inputs?.budget ?? 0;
  const below = kind === "less" && asked !== null && asked < min;
  const notLess = kind === "less" && asked !== null && asked >= base;
  const valid = asked !== null && asked > 0 && !below && !notLess;
  const { result, pending, failed, retry } = useScenario(valid ? (kind === "extra" ? { one_time: asked! } : { low_month_index: 1, low_month_budget: asked! }) : null);
  if (!inputs || !plan) return null;
  const outdated = asked !== null && amount !== asked;
  const fresh = valid && !outdated && result && !pending && !failed ? result : null;
  const bf = fresh?.baseline.forecast;
  const sf = fresh?.scenario.forecast;
  const sooner = bf && sf ? bf.months - sf.months : 0;
  const saved = bf && sf ? bf.total_interest - sf.total_interest : 0;
  const target = fresh?.scenario.this_cycle.find((p) => p.extra > 0);
  const cleared = fresh ? fresh.scenario.this_cycle.filter((p) => p.payoff) : [];
  const top = plan.cards.filter((c) => c.apr !== null && c.balance > 0).sort((a, b) => (b.apr ?? 0) - (a.apr ?? 0))[0];
  const total = fresh ? fresh.scenario.this_cycle.reduce((sum, p) => sum + p.total, 0) : 0;
  const nearest = [...plan.this_cycle].filter((p) => p.due).sort((a, b) => a.due!.localeCompare(b.due!))[0];
  const months = (n: number) => `${n} month${n === 1 ? "" : "s"}`;
  const pick = (k: "extra" | "less") => {
    setKind(k);
    setAmount(null);
    setAsked(null);
  };
  const apply = () => {
    if (!fresh || asked === null) return;
    update(
      { ...inputs, first_month_budget: kind === "extra" ? base + asked : asked },
      { text: `This month: ${money(total)} in total instead of ${money(base)}. From the next month it is ${money(base)} again.`, href: "#/schedule", label: "See the schedule" },
    );
    go("plan");
  };
  return (
    <div className="stack">
      <div className="picks" role="radiogroup" aria-label="What changed this month">
        <button type="button" role="radio" aria-checked={kind === "extra"} className={kind === "extra" ? "pick on" : "pick"} onClick={() => pick("extra")}>
          <Ico d={ICON.plus} size={26} />
          <b>I have extra money</b>
          <span className="small muted">A bonus, a refund, a gift</span>
        </button>
        <button type="button" role="radio" aria-checked={kind === "less"} className={kind === "less" ? "pick on" : "pick"} onClick={() => pick("less")}>
          <Ico d={ICON.minus} size={26} />
          <b>I can pay less</b>
          <span className="small muted">A surprise bill, a slow month</span>
        </button>
      </div>
      <div className="preview-row">
        {kind === "extra" ? (
          <NumberField id="tm-extra" label="How much extra this month? ($)" value={amount} onChange={setAmount} step="10" placeholder="300" />
        ) : (
          <NumberField id="tm-less" label="What can you pay this month? ($)" value={amount} onChange={setAmount} step="10" placeholder={String(Math.max(min, base - 100))} hint={`Usually ${money(base)}. Your minimums are ${money(min)}.`} />
        )}
        <button type="button" className="btn" disabled={amount === null || amount <= 0} onClick={() => setAsked(amount)}>
          Preview this month
        </button>
      </div>
      {asked === null && <p className="muted">Enter an amount and press Preview this month. Nothing changes until you apply it.</p>}
      {outdated && <p className="muted">The amount changed. Press Preview this month again.</p>}

      {!outdated && below && (
        <div className="note danger stack tight">
          <b>
            {money(asked ?? 0)} is {money(min - (asked ?? 0))} short of your minimum payments ({money(min)}).
          </b>
          <span>
            {nearest ? `Your nearest due date is ${dateLabel(nearest.due!)} (${cardName(plan.cards, nearest.card_id)}). ` : ""}
            Paying less than a minimum usually means a late fee and can hurt your credit history, so this can’t be applied as a plan. Call the issuer before the due date; many have a
            hardship option.
          </span>
          <a className="btn ghost small" href="#/bank">
            Prepare the call
          </a>
        </div>
      )}
      {!outdated && notLess && <p className="muted">That is not less than your usual {money(base)}.</p>}
      {!outdated && valid && failed && (
        <div className="note danger stack tight">
          <span>We couldn’t calculate this. Please try again.</span>
          <button type="button" className="btn ghost small" onClick={retry}>
            Try again
          </button>
        </div>
      )}
      {!outdated && valid && !fresh && !failed && <p className="muted">Calculating the preview…</p>}

      {fresh && (
        <section className="panel stack">
          <div className="row">
            <h2>Preview · this month only</h2>
            <span className="pill">Not applied yet</span>
          </div>
          {kind === "extra" && (
            <div className="opts" role="radiogroup" aria-label="What to do with the extra money">
              <button type="button" role="radio" aria-checked={choice === "pay"} className={choice === "pay" ? "opt on best" : "opt best"} onClick={() => setChoice("pay")}>
                <Ico d={ICON.down} size={24} />
                <b>Pay down debt</b>
                <span className="opt-big">{sooner > 0 ? `${months(sooner)} sooner` : "Same last-payment month"}</span>
                <span className="small ok">{saved > 0.005 ? `Saves ${money(saved)} interest` : "No interest saved"}</span>
                {target && <span className="small muted">Goes first to {cardName(plan.cards, target.card_id)}</span>}
              </button>
              <button type="button" role="radio" aria-checked={choice === "save"} className={choice === "save" ? "opt on" : "opt"} onClick={() => setChoice("save")}>
                <Ico d={ICON.shield} size={24} />
                <b>Keep as a cushion</b>
                <span className="opt-big">{money(asked!)} set aside</span>
                <span className="small muted">{top ? `A surprise bill won’t land on a card at ${top.apr}%.` : "A surprise bill won’t land on a card."}</span>
              </button>
              <button type="button" role="radio" aria-checked={choice === "spend"} className={choice === "spend" ? "opt on" : "opt"} onClick={() => setChoice("spend")}>
                <Ico d={ICON.bag} size={24} />
                <b>Spend it</b>
                <span className="opt-big">Plan stays the same</span>
                <span className="small muted">You just don’t speed up. No judgment.</span>
              </button>
            </div>
          )}
          {kind === "less" || choice === "pay" ? (
            <>
              {kind === "less" && <Difference base={fresh.baseline} alt={fresh.scenario} />}
              <Payments plan={fresh.scenario} title={`Pay this month: ${money(total)} in total`} />
              {cleared.map((p) => (
                <p key={p.card_id} className="muted">
                  {cardName(plan.cards, p.card_id)} is paid off by this payment (estimated). What is left of the money goes to the next card in the list above.
                </p>
              ))}
              <div className="actions">
                <button type="button" className="btn apply-btn more preview-apply" onClick={apply}>
                  Apply to this month
                </button>
                <span className="small muted">
                  Updates the Plan and the Schedule for this month only. From the next month you are back to {money(base)} a month.
                </span>
              </div>
            </>
          ) : (
            <p className="muted">Nothing to apply. Your plan and this month’s payments stay as they are.</p>
          )}
        </section>
      )}
    </div>
  );
}

// The budget that was just applied from What-if. The page is remounted when the plan's inputs change,
// so the confirmation is handed over here instead of living in component state.
let justApplied: number | null = null;

/** Preview another monthly budget against the current plan, then apply it. Only the budget can be changed here. */
export function WhatIf() {
  const { inputs, plan, update } = useStore();
  const base = inputs?.budget ?? 0;
  const [budget, setBudget] = useState(base);
  const [tab, setTab] = useState(() => (window.location.hash.includes("/once") ? "once" : "monthly"));
  const [applied, setApplied] = useState<number | null>(() => (justApplied === base ? justApplied : null));
  useEffect(() => {
    justApplied = null;
    if (applied === null) return;
    const timer = setTimeout(() => setApplied(null), 5000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { result, pending, failed, retry } = useScenario(inputs ? { scenario_budget: budget } : null);
  // what paying only the minimums looks like: the floor every other path is compared with
  const floor = useScenario(inputs && plan ? { scenario_budget: plan.minimums_total } : null).result?.scenario ?? null;
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
  // the slider never goes below the minimum payments: paying less than that is not a plan
  const low = Math.max(10, Math.ceil(plan.minimums_total / 10) * 10);
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
      </div>
      {tab === "once" ? (
        <ThisMonth />
      ) : (
      <div className="split wide-right">
        <section className="panel stack">
          <div className="slider">
            <div className="row">
              <label htmlFor="wi-budget">I can pay each month</label>
              <span className="wi-amount">
                <b className="big">{money(budget)}</b>
                {/* always in the row, only hidden when there is nothing to undo, so the amount never moves */}
                <button type="button" className={changed ? "wi-reset" : "wi-reset off"} disabled={!changed} aria-label={`Back to ${money(base)}`} title={`Back to ${money(base)}`} onClick={() => setBudget(base)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 12a9 9 0 1 0 3-6.7" />
                    <path d="M3 4v5h5" />
                  </svg>
                </button>
              </span>
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
              Now {money(base)}. You can’t go below your minimums, {money(plan.minimums_total)}.
            </span>
          </div>
          <button
            type="button"
            className={!changed ? "btn apply-btn keep" : budget > base ? "btn apply-btn more" : "btn apply-btn less"}
            disabled={changed && (!fresh || fresh.scenario.status === "shortfall")}
            onClick={() => {
              if (!changed) return; // keeping the current budget changes nothing
              // applied in place: the page stays here and every screen recalculates from the new budget
              justApplied = budget;
              update({ ...inputs, budget, first_month_budget: null }, { text: `Monthly budget is now ${money(budget)} (was ${money(base)}). Plan, schedule and comparison are recalculated.`, href: "#/plan", label: "See the plan" });
            }}
          >
            {!changed ? (applied !== null ? `Your budget is now ${money(applied)} a month` : `Keep ${money(base)} a month`) : `Make ${money(budget)} my monthly budget`}
          </button>
        </section>

        <section className="stack" aria-live="polite" aria-busy={pending}>
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
              {fresh.baseline.forecast && fresh.scenario.forecast ? <PathChart base={fresh.baseline} alt={fresh.scenario} changed={changed} floor={floor} /> : <Difference base={fresh.baseline} alt={fresh.scenario} />}
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

const CALL_GOALS = [
  { id: "apr", label: "Lower APR", title: "Ask for a lower APR", lede: "A lower rate on what you already owe is the one result that changes your plan." },
  { id: "promo", label: "Promo rate (6–12 mo)", title: "Ask for a temporary promo rate", lede: "If a permanent cut isn’t possible, a lower rate for 6 to 12 months still helps while you pay down." },
  { id: "fee", label: "Waive a fee", title: "Ask to waive a fee", lede: "A late or annual fee is often removed once if you ask. It is usually $35 to $95 back." },
  { id: "hardship", label: "Hardship plan", title: "Ask about a hardship plan", lede: "For when the minimums no longer fit your budget. Issuers have programs they don’t advertise." },
];

/** What to say for the goals that have no figures to invent: fixed wording with the plan's own numbers. */
function goalScript(goal: string, card: Card, planned: number, budget: number, minimums: number): { lines: { step: string; label: string; say: string }[]; questions: string[] } {
  const open = { step: "open", label: "Open", say: "Hi, I’m calling about my credit card account. Could you help me, or transfer me to someone who can?" };
  const close = { step: "close", label: "Close", say: "Can you confirm that in writing or give me a reference number for this call?" };
  if (goal === "promo") {
    return {
      lines: [
        open,
        { step: "ask", label: "Ask", say: `My purchase APR is ${card.apr}%. If a permanent reduction isn’t possible, could you offer a promotional rate for the next 6 to 12 months?` },
        { step: "case", label: "Your case", say: `I pay ${money(planned)} a month on this card and I’m working to clear the balance of about ${money(card.balance)}.` },
        { step: "pushback", label: "If they hesitate", say: "Is there any temporary rate available on my account right now? What would I need to do to qualify?" },
        close,
      ],
      questions: ["What is the promotional rate?", "When does it start and end?", "Does it cover my existing balance or only new purchases?", "What rate applies when it ends?", "Is there a fee to enrol?"],
    };
  }
  if (goal === "fee") {
    return {
      lines: [
        open,
        { step: "ask", label: "Ask", say: "I see a fee on my latest statement. I’d like to ask if it can be waived." },
        { step: "case", label: "Your case", say: `I’m paying this card down on a plan, ${money(planned)} a month, and I intend to keep the account in good standing.` },
        { step: "pushback", label: "If they hesitate", say: "Could you waive it this once as a courtesy? If not the whole fee, could part of it be removed?" },
        close,
      ],
      questions: ["Which fee is it, and how much?", "Will the credit show on my next statement?", "Does it reduce my minimum payment?", "How can I avoid this fee in future?"],
    };
  }
  return {
    lines: [
      open,
      { step: "ask", label: "Ask", say: "I’m having trouble keeping up with my payments and I’d like to know what hardship options you have." },
      { step: "case", label: "Your case", say: `My minimum payments across my cards are ${money(minimums)} a month and I can afford about ${money(budget)}. I want to keep paying rather than miss a payment.` },
      { step: "pushback", label: "If they hesitate", say: "Is there a program with a lower rate or a lower minimum for a few months? Who can I speak to about it?" },
      close,
    ],
    questions: ["What would my new minimum and rate be?", "How long does the program last?", "Will the card be closed or frozen?", "How is it reported to the credit bureaus?", "Are fees waived while I’m on it?"],
  };
}

/** A reminder file for the person's own calendar. Made in the browser; nothing is sent anywhere. */
function downloadReminder(title: string, dateIso: string) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//FinPilot//EN", "BEGIN:VEVENT", `UID:${Date.now()}@finpilot`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${dateIso.replace(/-/g, "")}`, `SUMMARY:${title}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  link.download = "finpilot-call-reminder.ics";
  link.click();
  URL.revokeObjectURL(link.href);
}

export function BankCall() {
  const { inputs, plan, update, progress, logCall } = useStore();
  const withApr = (plan?.cards ?? []).filter((c) => c.apr !== null && c.balance > 0).sort((a, b) => (b.apr ?? 0) - (a.apr ?? 0));
  const [cardId, setCardId] = useState<string | null>(null);
  const [goal, setGoal] = useState("apr");
  const [script, setScript] = useState<CallScript | null>(null);
  const [scriptError, setScriptError] = useState("");
  const [scriptTry, setScriptTry] = useState(0);
  const [newApr, setNewApr] = useState<number | null>(null);
  const [terms, setTerms] = useState(""); // what the bank's offer covers
  const [outcome, setOutcome] = useState(""); // "", "yes" or "no" for the call just made
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
        <PageHead title="Call your bank">Add the APR of at least one card with a balance to prepare a call.</PageHead>
        <a className="btn" href="#/setup/3">
          Add an APR
        </a>
      </main>
    );
  }
  const g = CALL_GOALS.find((x) => x.id === goal)!;
  const fixed = goal === "apr" ? null : goalScript(goal, card, planned, plan.budget, plan.minimums_total);
  const lines = fixed ? fixed.lines : script?.lines ?? [];
  const questions = fixed ? fixed.questions : script?.questions ?? [];
  const today = todayIso();
  const again = new Date();
  again.setMonth(again.getMonth() + 3);
  const againIso = `${again.getFullYear()}-${String(again.getMonth() + 1).padStart(2, "0")}-${String(again.getDate()).padStart(2, "0")}`;
  const note = (result_: "yes" | "no") => {
    logCall({ card: card.name, goal: g.label, result: result_, date: today });
    setOutcome(result_);
  };
  const pickGoal = (id: string) => {
    setGoal(id);
    setOutcome("");
  };
  return (
    <main className="page">
      <PageHead title={g.title} image="/img/fp-icon-phone.jpg">
        {g.lede}
      </PageHead>
      <div className="goal-tabs" role="tablist" aria-label="What the call is for">
        {CALL_GOALS.map((x) => (
          <button key={x.id} type="button" role="tab" aria-selected={goal === x.id} className={goal === x.id ? "goal-tab on" : "goal-tab"} onClick={() => pickGoal(x.id)}>
            {x.label}
          </button>
        ))}
      </div>
      <div className="split">
        <section className="panel stack">
          <div className="row">
            <h2 className="with-ico">
              <Ico d={ICON.phone} /> What to say
            </h2>
            <div className="actions">
              {withApr.map((c) => (
                <button key={c.id} type="button" className={`btn ghost small ${c.id === card.id ? "on" : ""}`} aria-pressed={c.id === card.id} onClick={() => { setCardId(c.id); setOutcome(""); }}>
                  {c.name} · {c.apr}%
                </button>
              ))}
            </div>
          </div>
          <p className="tip">
            <Ico d={ICON.phone} size={18} /> Call the number on the back of your card. It is the only one sure to be right.
          </p>
          {goal === "apr" && scriptError && (
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
          {goal === "apr" && !script && !scriptError && <p className="muted">Preparing the script…</p>}
          <ol className="say-list">
            {lines.map((l, i) => (
              <li key={l.step} className="say">
                <span className="say-n">{i + 1}</span>
                <div>
                  <span className="say-label">{l.label}</span>
                  <p>{l.say}</p>
                </div>
              </li>
            ))}
          </ol>
          {lines.length > 0 && (
            <div className="actions">
              <button type="button" className="btn ghost" onClick={() => navigator.clipboard?.writeText(lines.map((l) => l.say).join("\n\n")).catch(() => undefined)}>
                <Ico d={ICON.copy} size={18} /> Copy script
              </button>
              <span className="small muted">{!fixed && script?.source === "ai" ? "Worded by AI. The figures come from your plan and were checked." : "Standard wording with your plan’s figures."}</span>
            </div>
          )}
        </section>
        <aside className="stack">
          <section className="panel stack tight">
            <h2>Questions to ask back</h2>
            {questions.map((q) => (
              <label key={q} className="check">
                <input type="checkbox" />
                <span>{q}</span>
              </label>
            ))}
          </section>
          <p className="small muted">The bank decides. A better rate, a waived fee and any saving are not guaranteed.</p>
        </aside>
      </div>

      <section className="panel stack">
        <h2>How did the call go?</h2>
        <div className="outcomes">
          <button type="button" className={outcome === "yes" ? "outcome yes on" : "outcome yes"} aria-pressed={outcome === "yes"} onClick={() => note("yes")}>
            <Ico d="M5 12.5l4.5 4.5L19 7.5" size={26} />
            <b>Bank said yes</b>
            <span className="small">Enter what they confirmed</span>
          </button>
          <button type="button" className={outcome === "no" ? "outcome no on" : "outcome no"} aria-pressed={outcome === "no"} onClick={() => note("no")}>
            <Ico d="M6 6l12 12M18 6L6 18" size={26} />
            <b>Bank said no</b>
            <span className="small">Note it and set a reminder</span>
          </button>
        </div>

        {outcome === "no" && (
          <div className="note stack tight">
            <b>
              Noted: {card.name} · {g.label} · {prettyDate(today)}.
            </b>
            <span>A no today is not final. Issuers often reconsider after a few months of on-time payments, so it is worth asking again around {prettyDate(againIso)}.</span>
            <div className="actions">
              <button type="button" className="btn" onClick={() => downloadReminder(`Call the bank again about ${card.name}: ${g.label}`, againIso)}>
                Add a reminder for {prettyDate(againIso)}
              </button>
              {goal === "apr" && (
                <button type="button" className="btn ghost" onClick={() => pickGoal("promo")}>
                  Try a promo rate instead
                </button>
              )}
              {goal !== "hardship" && plan.shortfall > 0 && (
                <button type="button" className="btn ghost" onClick={() => pickGoal("hardship")}>
                  Ask about a hardship plan
                </button>
              )}
            </div>
          </div>
        )}

        {outcome === "yes" && goal === "promo" && (
          <p className="note warn">
            A temporary rate is not applied to your plan: it would end and the forecast would be wrong. Write down the rate, the start and end dates and what it covers. If it applies to your
            existing balance now, you can enter it under Lower APR and change it back when it ends.
          </p>
        )}
        {outcome === "yes" && goal === "fee" && (
          <p className="note">
            Once the credit shows in your banking app, <a href={`#/update/${card.id}`}>update {card.name}’s balance</a>. Don’t subtract it yourself before it posts.
          </p>
        )}
        {outcome === "yes" && goal === "hardship" && (
          <p className="note">
            Enter the new minimum and rate the bank confirmed on <a href={`#/update/${card.id}`}>{card.name}</a>. If the terms are temporary or the card is frozen, the forecast may not fit;
            check it against what the bank told you.
          </p>
        )}

        {outcome === "yes" && goal === "apr" && (
          <>
        <p className="muted">Enter only a rate the bank has confirmed for {card.name}.</p>
        <div style={{ maxWidth: 260 }}>
          <NumberField id="offer-apr" label={`New APR (%), today ${card.apr}%`} value={newApr} onChange={setNewApr} max={100} placeholder="21.9" />
        </div>
        {newApr !== null && !offerValid && <p className="note warn">Enter a rate below the current {card.apr}%.</p>}
        {offerValid && offerPending && <p className="muted">Recalculating…</p>}
        {offerValid && !offerPending && result && result.scenario.forecast && result.baseline.forecast && (
          <>
            <Difference base={result.baseline} alt={result.scenario} />
            <fieldset className="treat">
              <legend>What did the bank confirm?</legend>
              <label className={terms === "now" ? "treat-opt on" : "treat-opt"}>
                <input type="radio" name="apr-terms" checked={terms === "now"} onChange={() => setTerms("now")} />
                <span>The new rate is confirmed, already in effect, and applies to my existing balance.</span>
              </label>
              <label className={terms === "limited" ? "treat-opt on" : "treat-opt"}>
                <input type="radio" name="apr-terms" checked={terms === "limited"} onChange={() => setTerms("limited")} />
                <span>It is temporary, starts later, or only covers new purchases.</span>
              </label>
            </fieldset>
            {terms === "limited" && (
              <p className="note warn">
                Not applied to your plan. A rate that is temporary, starts later or only covers new purchases does not change the interest on what you owe today in this model. Write down
                the rate, when it starts, how long it lasts and what it covers.
              </p>
            )}
            <div className="actions">
              <button
                type="button"
                className="btn"
                disabled={terms !== "now"}
                onClick={() => {
                  update(
                    { ...inputs, cards: inputs.cards.map((c) => (c.id === card.id ? { ...c, apr: newApr } : c)) },
                    { text: `${card.name}’s APR is now ${newApr}% (was ${card.apr}%). The plan and forecast are recalculated.`, href: "#/plan", label: "See the plan" },
                  );
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
          </>
        )}
      </section>

      {progress.calls.length > 0 && (
        <section className="panel stack tight">
          <h2>Your calls</h2>
          {progress.calls.map((c, i) => (
            <div key={i} className="call-row">
              <span className={c.result === "yes" ? "pill ok-tag" : "pill warn-tag"}>{c.result === "yes" ? "Yes" : "No"}</span>
              <b>{c.card}</b>
              <span>{c.goal}</span>
              <span className="muted">{prettyDate(c.date)}</span>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

const FAN_HEAD = 400; // height of the heading area the fan sits behind
const FAN_ROW = 500; // vertical space one drawn card takes below it
const CARD_W = 190; // the card never changes size: portrait in the fan, turned a quarter when drawn
const CARD_H = 300;

// Which cards were open on Balances. The page is rebuilt when the plan's inputs change, so this
// carries the open cards across a recorded payment.
let keepOpen: string[] | null = null;
// The payment just marked as paid, carried across the same rebuild so the page can show it landing.
let justPaid: { card: string; payment: string; amount: number } | null = null;
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** What is wrong with a card's fields, by field. Nothing is applied while this is not empty. */
function cardErrors(c: Card): Record<string, string> {
  const e: Record<string, string> = {};
  if (!c.name.trim()) e.name = "Give the card a name.";
  if (!(c.balance >= 0)) e.balance = "The balance can’t be below $0.";
  if (c.apr !== null && (c.apr < 0 || c.apr > 100)) e.apr = "Enter an APR between 0 and 100.";
  if (!(c.minimum >= 0)) e.minimum = "The minimum can’t be below $0.";
  if (c.limit !== null && !(c.limit > 0)) e.limit = "Enter a limit above $0, or leave it empty.";
  return e;
}

/** Record a payment that was made: the real amount and the real date, kept apart from any estimate. */
function RecordPayment({ card, suggested, onRecord }: { card: Card; suggested: number; onRecord: (amount: number, date: string) => void }) {
  const { inputs } = useStore();
  const [amount, setAmount] = useState<number | null>(suggested > 0 ? suggested : null);
  const [date, setDate] = useState(todayIso());
  const [again, setAgain] = useState(false);
  const same = (inputs?.payments ?? []).some((p) => p.card_id === card.id && p.amount === amount && p.date === date);
  const bad = amount === null || amount <= 0 ? "" : amount > card.balance ? `That is more than the ${money(card.balance)} balance.` : date > todayIso() ? "Use the date the payment was made." : "";
  return (
    <div className="record stack tight">
      <b>Mark as paid</b>
      <div className="record-row">
        <NumberField id={`${card.id}-pay`} label="Amount paid ($)" value={amount} onChange={(v) => { setAmount(v); setAgain(false); }} error={bad || undefined} />
        <DateField id={`${card.id}-paydate`} label="Date paid" value={date} max={todayIso()} onChange={(v) => { setDate(v ?? todayIso()); setAgain(false); }} />
        <button
          type="button"
          className="btn"
          disabled={amount === null || amount <= 0 || !!bad || !date}
          onClick={() => {
            if (same && !again) return setAgain(true); // the same payment twice is almost always a mistake
            onRecord(amount!, date);
          }}
        >
          {same && again ? "Yes, mark it again" : "Mark as paid"}
        </button>
      </div>
      {same && again && <span className="small warn">You already marked {money(amount!)} as paid on {dateLabel(date)} for this card. Mark it again only if you paid twice.</span>}
    </div>
  );
}

/** A purchase made on the card: added to the previous balance once. */
function AddPurchase({ card, onAdd }: { card: Card; onAdd: (amount: number) => void }) {
  const [amount, setAmount] = useState<number | null>(null);
  const [added, setAdded] = useState<number | null>(null);
  return (
    <div className="record stack tight">
      <b>Bought something on this card?</b>
      <div className="record-row">
        <NumberField id={`${card.id}-buy`} label="Purchase amount ($)" value={amount} onChange={setAmount} />
        <button
          type="button"
          className="btn ghost"
          disabled={amount === null || amount <= 0}
          onClick={() => {
            onAdd(amount!);
            setAdded(amount);
            setAmount(null);
          }}
        >
          Add to balance
        </button>
      </div>
      <span className="small muted">
        {added !== null ? `Added ${money(added)}. Don’t also retype the balance for this purchase.` : "Use this, or type the new balance from your banking app above. Not both for the same purchase."}
      </span>
    </div>
  );
}

/**
 * Cards sit in a fan behind the heading, like a hand of playing cards. Each is a real two-sided
 * card: tapping one moves it to a row below while it turns a quarter and flips over, showing a back
 * that is printed landscape. The card never changes shape and its text never moves.
 */
export function UpdateBalances() {
  const { inputs, plan, update, progress, markPaid } = useStore();
  const [draft, setDraft] = useState<Card[]>(inputs?.cards ?? []);
  const faceOf = useFaces(draft);
  // a card named in the address (#/update/card-a) opens straight away, ready to edit
  const asked = window.location.hash.split("/")[2];
  const [drawn, setDrawn] = useState<string[]>(() => (asked && inputs?.cards.some((c) => c.id === asked) ? [asked] : keepOpen ?? [])); // card ids, in the order they were tapped
  const [moved, setMoved] = useState<string[]>([]); // cards that have been tapped at least once: only these animate
  const [editing, setEditing] = useState<string[]>(() => (asked && !keepOpen && inputs?.cards.some((c) => c.id === asked) ? [asked] : [])); // drawn cards whose fields are open
  const [quiet, setQuiet] = useState<string[]>(() => keepOpen ?? []); // open cards restored after a change: shown in place, not animated in
  const [restored] = useState(() => keepOpen !== null);
  const [fresh] = useState(() => justPaid);
  useEffect(() => {
    keepOpen = null;
    justPaid = null;
  }, []);
  if (!inputs || !plan) return <main className="page muted">Calculating…</main>;

  const patch = (id: string, change: Partial<Card>) => setDraft(draft.map((c) => (c.id === id ? { ...c, ...change } : c)));
  // functional updates: two quick taps on different cards must both count
  const toggle = (id: string) => {
    setDrawn((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));
    setMoved((now) => (now.includes(id) ? now : [...now, id]));
    setQuiet((now) => now.filter((x) => x !== id));
  };
  const original = (id: string) => inputs.cards.find((c) => c.id === id);
  const changed = draft.filter((c) => JSON.stringify(c) !== JSON.stringify(original(c.id))).length;
  const mid = (draft.length - 1) / 2;
  const errors = Object.fromEntries(draft.map((c) => [c.id, cardErrors(c)]));
  const invalid = draft.filter((c) => Object.keys(errors[c.id]).length > 0);
  const payments = inputs.payments ?? [];
  const record = (card: Card, amount: number, date: string) => {
    keepOpen = drawn;
    markPaid();
    const balance = Math.max(0, Math.round((card.balance - amount) * 100) / 100);
    const id = Math.random().toString(36).slice(2, 9);
    justPaid = { card: card.id, payment: id, amount };
    update(
      {
        ...inputs,
        cards: inputs.cards.map((c) => (c.id === card.id ? { ...c, balance } : c)),
        payments: [...payments, { id, card_id: card.id, amount, date }],
      },
      { text: `${money(amount)} marked as paid on ${card.name}, ${dateLabel(date)}. The plan now shows only what is still to pay this month.`, href: "#/plan", label: "See the plan" },
    );
  };
  const undo = (id: string) => {
    const p = payments.find((x) => x.id === id);
    if (!p) return;
    keepOpen = drawn;
    update(
      { ...inputs, cards: inputs.cards.map((c) => (c.id === p.card_id ? { ...c, balance: Math.round((c.balance + p.amount) * 100) / 100 } : c)), payments: payments.filter((x) => x.id !== id) },
      { text: `The ${money(p.amount)} payment was removed and added back to the balance.`, href: "#/plan", label: "See the plan" },
    );
  };
  const use = plan.limit_use;
  const flip = (id: string) => setEditing((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));

  const history = [...payments].sort((p, q) => q.date.localeCompare(p.date));
  return (
    <main className={restored ? "page no-anim" : "page"}>
      <section className="fan" aria-label="Your cards" style={{ height: FAN_HEAD + Math.max(drawn.length * FAN_ROW, 300) }}>
        <div className="fan-head">
          <h1>Your cards</h1>
          <p className="lede">Tap a card to record a payment, update its balance or change its details.</p>
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
            ...faceStyle(faceOf(c.id, i)),
            "--shine-delay": `${i * -4.33}s`,
            zIndex: isDrawn ? 10 : i + 1,
          } as CSSProperties;
          const apr = c.apr === null ? "APR not entered" : `${c.apr}% APR`;
          const card = (
            <button
              key={c.id}
              type="button"
              className={(isDrawn ? (quiet.includes(c.id) ? "fan-card drawn" : "fan-card drawn toss") : moved.includes(c.id) ? "fan-card back" : "fan-card") + (fresh?.card === c.id ? " paid-now" : "")}
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
                  {fresh?.card === c.id && (
                    <span className="paid-stamp">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M5 12.5l4.5 4.5L19 7.5" />
                      </svg>
                      Paid {money(fresh.amount)}
                    </span>
                  )}
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
            <div key={`${c.id}-info`} className={quiet.includes(c.id) ? "fan-info stack tight still" : "fan-info stack tight"} style={{ "--dy": `${FAN_HEAD + slot * FAN_ROW}px` } as CSSProperties}>
              <div className="row">
                <h2>{c.name}</h2>
                <CardColorPicker card={c} cards={draft} compact />
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
                    {errors[c.id].name && <span className="small danger">{errors[c.id].name}</span>}
                  </div>
                  <NumberField
                    id={`${c.id}-ubal`}
                    label="Current balance ($)"
                    value={c.balance}
                    onChange={(v) => patch(c.id, { balance: v ?? 0 })}
                    error={errors[c.id].balance}
                    hint="From your banking app. It already includes payments you made."
                  />
                  <NumberField id={`${c.id}-uapr`} label="APR (%)" value={c.apr} onChange={(v) => patch(c.id, { apr: v })} max={100} error={errors[c.id].apr} />
                  <NumberField id={`${c.id}-umin`} label="Minimum still due ($)" value={c.minimum} onChange={(v) => patch(c.id, { minimum: v ?? 0 })} error={errors[c.id].minimum} />
                  <DateField id={`${c.id}-udue`} label="Next payment due date" value={c.next_due ?? null} clearable onChange={(v) => patch(c.id, { next_due: v, due_day: v ? Number(v.slice(8, 10)) : c.due_day })} />
                  <NumberField id={`${c.id}-ulim`} label="Credit limit ($)" value={c.limit} onChange={(v) => patch(c.id, { limit: v })} error={errors[c.id].limit} />
                  <div className="record-wide">
                    <AddPurchase card={c} onAdd={(amount) => patch(c.id, { balance: Math.round((c.balance + amount) * 100) / 100 })} />
                  </div>
                </div>
              ) : (
                <div key="view" className="fan-body stack tight">
                  <dl className="facts">
                    <div>
                      <dt>Balance</dt>
                      <dd className={fresh?.card === c.id ? "just-changed" : undefined}>{money(c.balance)}</dd>
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
                      <dt>Next due date</dt>
                      <dd>{planned?.due ? dateLabel(planned.due) : c.next_due ? dateLabel(c.next_due) : c.due_day ? `Day ${c.due_day}` : "—"}</dd>
                    </div>
                    <div>
                      <dt>Still to pay this month</dt>
                      <dd>{planned ? `${money(planned.total)}${planned.due ? ` by ${dateLabel(planned.due)}` : ""}` : "Nothing"}</dd>
                    </div>
                    <div>
                      <dt>Balance after it, est.</dt>
                      <dd>{planned && estimate !== undefined ? money(estimate) : "—"}</dd>
                    </div>
                    <div>
                      <dt>Credit limit</dt>
                      <dd>{c.limit === null ? "Not entered" : money0(c.limit)}</dd>
                    </div>
                    <div>
                      <dt>Last payment</dt>
                      <dd>{plan.forecast?.payoff_month[c.id] ? monthName(plan.forecast.payoff_month[c.id]) : "—"}</dd>
                    </div>
                  </dl>
                  {payments.filter((p) => p.card_id === c.id).length > 0 && (
                    <ul className="paid-list small">
                      {payments
                        .filter((p) => p.card_id === c.id)
                        .map((p) => (
                          <li key={p.id} className={fresh?.payment === p.id ? "just-paid" : undefined}>
                            <span className="ok">
                              {money(p.amount)} paid on {dateLabel(p.date)}
                            </span>
                            <button type="button" className="link" onClick={() => undo(p.id)}>
                              Remove
                            </button>
                          </li>
                        ))}
                      <li className="muted">
                        Counted toward this card’s upcoming due date: {money(paidToward(c, payments))}. The balance above already has these payments taken off; replace it with the figure from
                        your banking app when it updates.
                      </li>
                    </ul>
                  )}
                  <RecordPayment card={c} suggested={fresh?.card === c.id ? 0 : (planned?.total ?? 0)} onRecord={(amount, date) => record(c, amount, date)} />
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

      <section className="panel stack tight">
        <div className="row">
          <h2>Payment history</h2>
          <span className="pill">{history.length} marked as paid</span>
        </div>
        {history.length === 0 && <p className="muted">Nothing marked as paid yet. Open a card above and use Mark as paid.</p>}
        {history.map((p) => (
          <div key={p.id} className="call-row">
            <span className="muted">{prettyDate(p.date)}</span>
            <b>{cardName(inputs.cards, p.card_id)}</b>
            <span className="ok">{money(p.amount)}</span>
            <button type="button" className="link small" onClick={() => undo(p.id)}>
              Remove
            </button>
          </div>
        ))}
        <p className="small muted">
          This list is kept in your account if you have one. Without an account it lives in this browser, and only if you turn on saving in <a href="#/data">Your data</a>. FinPilot does not see your bank’s
          transactions.
        </p>
      </section>
      {invalid.length > 0 && (
        <p className="note danger" role="alert">
          Fix the fields marked in red on {invalid.map((c) => c.name || "a card").join(" and ")} before recalculating. Nothing has been changed.
        </p>
      )}
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={changed === 0 || invalid.length > 0}
          onClick={() => {
            update({ ...inputs, cards: draft }, { text: `${changed} card${changed === 1 ? "" : "s"} updated. The plan is recalculated from the new figures.`, href: "#/plan", label: "See the plan" });
            go("plan");
          }}
        >
          Recalculate my plan
        </button>
        <a className="btn ghost" href="#/import">
          Update from a new statement
        </a>
        <span className="small muted">
          {changed} of {draft.length} cards changed. Each balance is a fresh snapshot: payments already in it are not subtracted again.
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
      <PageHead title="Your data">You choose where your plan is kept. Nothing is sent to a bank or a credit bureau.</PageHead>
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
            <li>To our server, to calculate your plan</li>
            <li>With an account: saved on our server, so it follows you to other devices</li>
            <li>Without one: only in this browser, and only if you turn saving on</li>
            <li>Statements and assistant chats are read by AI models on our own server. A hard question to the assistant may be sent, without your name or email, to an outside AI service (DeepSeek)</li>
            <li>Never sold or used for ads</li>
          </ul>
        </div>
        <div className="panel stack tight data-tile">
          <span className="data-ico">
            <Ico d={ICON.ban} size={24} />
          </span>
          <h2>What we never ask</h2>
          <ul className="muted list">
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
              <span className="small muted">Off by default. When on, your cards, budget and recorded payments stay in this browser only. When off, they are gone when you close the tab.</span>
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
