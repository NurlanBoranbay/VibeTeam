import { useState } from "react";
import { downloadCalendar, type Plan as PlanData, type Strategy } from "../api";
import { cycles, dateLabel, fullDate, money, money0, monthName, pct, rangeLabel } from "../format";
import { useStore } from "../store";
import { cardName, Meter, PageHead, SplitBar, Stat } from "../ui";

// Periods on every screen are PAYMENT CYCLES: rolling months from the plan's start date, shown
// with the dates they cover. See backend/app/engine.py.

function Assumptions({ plan }: { plan: PlanData }) {
  return (
    <section className="panel stack tight">
      <h2>What this estimate assumes</h2>
      <ul className="muted list">
        {plan.assumptions.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
      <p className="small muted">FinPilot shows a plan. It does not move money or confirm payments with your bank.</p>
    </section>
  );
}

function Shortfall({ plan }: { plan: PlanData }) {
  const covered = plan.minimums_total ? (plan.budget / plan.minimums_total) * 100 : 0;
  return (
    <main className="page">
      <PageHead kicker={<span className="pill danger">No payoff plan yet</span>} title={`${money(plan.shortfall)} short of your minimum payments`}>
        Your cards need {money(plan.minimums_total)} per payment cycle in minimums and your budget is {money(plan.budget)}. FinPilot will not show a payoff schedule
        or a debt-free month until the minimums are covered.
      </PageHead>
      <section className="panel stack tight">
        <Meter value={covered} tone="danger" />
        <div className="grid3">
          <div className="stat">
            <span className="muted">Monthly budget</span>
            <b>{money(plan.budget)}</b>
          </div>
          <div className="stat">
            <span className="muted">Minimums due</span>
            <b>{money(plan.minimums_total)}</b>
          </div>
          <div className="stat">
            <span className="muted">Missing</span>
            <b className="danger">{money(plan.shortfall)}</b>
          </div>
        </div>
      </section>
      <section className="cols3">
        <div className="col">
          <span className="muted">First</span>
          <h2>Check the numbers</h2>
          <p className="muted">Is each minimum the amount on the latest statement? Is the budget really all that is left after rent, food and other necessary costs? Do not take money from those to close the gap.</p>
          <a className="btn ghost" href="#/setup/3">
            Review cards and budget
          </a>
        </div>
        <div className="col">
          <span className="muted">Then</span>
          <h2>Ask each bank what help exists</h2>
          <p className="muted">Call before the due date. Ask about a hardship program, a lower minimum for a few months, a later due date and whether fees can be waived.</p>
          <a className="btn" href="#/bank">
            Prepare the call
          </a>
        </div>
        <div className="col">
          <span className="muted">After that</span>
          <h2>Enter confirmed terms</h2>
          <p className="muted">When a bank confirms a new minimum or rate, update the card. Once the minimums fit inside your budget, the plan is built as usual.</p>
          <a className="btn ghost" href="#/update">
            Update a card
          </a>
        </div>
      </section>
    </main>
  );
}

/** Compact credit-limit summary on the plan, from the same forecast as everything else. */
function CreditHealth({ plan }: { plan: PlanData }) {
  const use = plan.limit_use;
  if (use.cards.length === 0 && use.missing.length === 0) return null;
  return (
    <section className="panel stack tight">
      <div className="row">
        <h2>Your plan and your credit health</h2>
        <a href="#/credit">See the detail →</a>
      </div>
      <ul className="list plain">
        {use.cards.map((u) => (
          <li key={u.card_id}>
            <b>{cardName(plan.cards, u.card_id)}:</b> {pct(u.now_pct)} used now
            {u.after_pct !== null ? ` → ${pct(u.after_pct)} after 3 payment cycles.` : "."}
          </li>
        ))}
        {use.missing.map((name) => (
          <li key={name} className="muted">
            <b>{name}:</b> <a href="#/setup/3">Add your credit limit to see this estimate.</a>
          </li>
        ))}
      </ul>
      <p className="small muted">Lower credit utilization may help your credit score. Actual changes depend on your full credit profile and when lenders report updates.</p>
    </section>
  );
}

export function Plan() {
  const { plan, inputs } = useStore();
  if (!plan || !inputs) return <main className="page muted">Calculating…</main>;
  if (plan.status === "shortfall") return <Shortfall plan={plan} />;
  if (plan.status === "no_debt") {
    return (
      <main className="page">
        <PageHead title="No card balances to pay off" image="/img/fp-debt-free-coin.jpg">
          Every card you entered has a zero balance. If a balance comes back, update the card and the plan returns.
        </PageHead>
      </main>
    );
  }
  // payments of the current cycle, soonest due date first
  const rows = plan.this_cycle
    .map((p) => ({ p, card: plan.cards.find((c) => c.id === p.card_id)! }))
    .sort((a, b) => (a.p.due ?? "9999").localeCompare(b.p.due ?? "9999"));
  const first = rows[0];
  const max = Math.max(...rows.map((r) => r.p.total));
  const target = rows.find((r) => r.p.extra > 0);
  const f = plan.forecast;
  const cycle = rangeLabel(plan.cycle.period_start, plan.cycle.period_end);
  const by = (due: string | null) => (due ? ` by ${dateLabel(due)}` : "");

  return (
    <main className="page">
      <div className="plan-hero">
        <span className="hero-kicker">Next payment · this payment cycle covers {cycle}</span>
        <h1>
          Pay {money(first.p.total)} to {first.card.name}
          {by(first.p.due)}
        </h1>
        <p>
          {rows.length > 1 ? `Then ${rows.slice(1).map((r) => `${money(r.p.total)} to ${r.card.name}${by(r.p.due)}`).join(" and ")}. ` : ""}
          Together that is {money(rows.reduce((s, r) => s + r.p.total, 0))} for this payment cycle.
        </p>
      </div>

      {plan.missing.length > 0 && (
        <p className="note warn">
          {plan.missing.join(". ")}. The payment split below still works. Add the APR to see interest and a debt-free month.{" "}
          <a href="#/setup/3">Add it now</a>
        </p>
      )}

      <section className="cols3">
        {rows.map(({ p, card }) => (
          <div key={card.id} className="col">
            <div className="row start">
              <h2>{card.name}</h2>
              {p.extra > 0 && <span className="pill extra">Gets the extra</span>}
            </div>
            <span className="big">
              <b>{money(p.total)}</b>
              {by(p.due)}
            </span>
            <SplitBar payment={p} max={max} />
            <span className="muted">
              {money(p.minimum)} minimum{p.extra > 0 ? ` + ${money(p.extra)} extra` : " only"}
            </span>
            <dl className="kv">
              <dt>Balance today</dt>
              <dd>{money(card.balance)}</dd>
              <dt>APR</dt>
              <dd>{card.apr === null ? "Not entered" : `${card.apr}%`}</dd>
              {plan.cycles[0] && (
                <>
                  <dt>Balance after this payment, est.</dt>
                  <dd>{money(plan.cycles[0].balances[card.id] ?? 0)}</dd>
                </>
              )}
            </dl>
            <a className="btn ghost" href="#/update">
              Mark as paid
            </a>
          </div>
        ))}
      </section>

      {f && (
        <>
          <section className="grid4">
            <Stat label="Estimated debt-free month" value={monthName(f.debt_free_month)} note={`${f.months} monthly payments`} />
            <Stat label="Estimated interest" value={money(f.total_interest)} note={`On ${money0(plan.total_debt)} owed today`} />
            <Stat label="Monthly budget" value={money(plan.budget)} note={`${money(plan.minimums_total)} minimums + ${money(plan.above_minimums)} extra`} />
            <a className="panel stat link" href="#/what-if">
              <span className="muted">Would more each month help?</span>
              <b>Try a what-if</b>
              <span className="small">Preview another monthly budget →</span>
            </a>
          </section>

          <section className="panel stack">
            <div className="row">
              <h2>Estimated balance after each payment cycle</h2>
              <a href="#/forecast">Compare strategies →</a>
            </div>
            <div className="chart" role="img" aria-label={`Total balance falls from ${money0(plan.total_debt)} today to $0 after ${cycles(f.months)}, in ${monthName(f.debt_free_month)}`}>
              {f.balance_by_cycle.map((v, i) => (
                <div key={i} className="chart-col">
                  {f.balance_by_cycle.length <= 14 && <span className="small">{money0(v)}</span>}
                  <span className={i === 0 ? "chart-bar today" : "chart-bar"} style={{ height: Math.max(3, (v / plan.total_debt) * 200) }} />
                  {f.balance_by_cycle.length <= 14 && <span className="small muted">{i === 0 ? "Today" : dateLabel(f.cycle_ends[i - 1])}</span>}
                </div>
              ))}
            </div>
            <span className="small muted">Each bar is the estimated total at the end of a payment cycle, on the date shown.</span>
          </section>
        </>
      )}

      <div className="grid2">
        {target && (
          <section className="panel stack tight">
            <h2>
              Why {target.card.name} gets the extra {money(target.p.extra)}
            </h2>
            <p className="muted">
              Every card gets its minimum first. What is left goes to{" "}
              {plan.strategy === "snowball" ? "the smallest balance, so one card disappears sooner and its payment is freed up" : "the highest APR, because each dollar there costs the most"}.
              {target.card.apr !== null && plan.strategy === "avalanche" ? ` At ${target.card.apr}%, $100 left on ${target.card.name} costs about ${money0(target.card.apr)} a year.` : ""}
            </p>
            {f?.payoff_month[target.card.id] && (
              <p className="muted">
                When {target.card.name} is paid off in {monthName(f.payoff_month[target.card.id])}, its payment moves to the next card.
              </p>
            )}
          </section>
        )}
        <CreditHealth plan={plan} />
      </div>
      <Assumptions plan={plan} />
    </main>
  );
}

export function Schedule() {
  const { plan, inputs } = useStore();
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  if (!plan || !inputs) return <main className="page muted">Calculating…</main>;
  if (plan.status !== "ok") {
    return (
      <main className="page">
        <PageHead title="Next 3 payment cycles">There is no schedule yet. The plan page explains what is missing.</PageHead>
        <a className="btn" href="#/plan">
          Go to the plan
        </a>
      </main>
    );
  }
  const rows = plan.cycles;
  const paid = rows.reduce((s, m) => s + m.payments.reduce((x, p) => x + p.total, 0), 0);
  const last = rows[rows.length - 1];
  const interest = rows.reduce((s, m) => s + m.interest, 0);
  return (
    <main className="page">
      <div className="row end">
        <PageHead title={`Next ${rows.length} payment cycles`}>
          {rows.reduce((s, m) => s + m.payments.length, 0)} payments, {money0(paid)} in total, from {dateLabel(rows[0].period_start)} to {fullDate(last.period_end)}. Your estimated
          balance goes from {money0(plan.total_debt)} to {money0(last.total_balance)}.
        </PageHead>
        <button type="button" className="btn ghost" onClick={() => downloadCalendar(inputs).catch(() => setError("We couldn’t create the calendar file. Please try again."))}>
          Add due dates to calendar
        </button>
      </div>
      {error && <p className="note danger">{error}</p>}
      <p className="muted">A payment cycle is one month counted from today, not a calendar month. Each card is paid once per cycle, on its due date.</p>
      <section className="cols3">
        {rows.map((m) => (
          <div key={m.index} className="col">
            <span className="muted">Payment cycle {m.index}</span>
            <h2>{rangeLabel(m.period_start, m.period_end)}</h2>
            <span className="big">
              <b>{money(m.payments.reduce((s, p) => s + p.total, 0))}</b> across {m.payments.length} card{m.payments.length === 1 ? "" : "s"}
            </span>
            {m.payments.map((p) => {
              const key = `${m.index}-${p.card_id}`;
              return (
                <label key={key} className={`todo ${done[key] ? "done" : ""}`}>
                  <input type="checkbox" checked={!!done[key]} onChange={(e) => setDone({ ...done, [key]: e.target.checked })} />
                  <span className="grow">
                    <b>
                      {p.due ? `${dateLabel(p.due)} · ` : ""}
                      {cardName(plan.cards, p.card_id)}
                    </b>
                    <span className="small muted">
                      {money(p.minimum)} minimum{p.extra > 0 ? ` + ${money(p.extra)} extra` : " only"}
                    </span>
                    <span className="small muted">Balance after, est. {money(m.balances[p.card_id] ?? 0)}</span>
                  </span>
                  <b>{money(p.total)}</b>
                </label>
              );
            })}
            <div className="row">
              <span className="muted">Total owed on {dateLabel(m.period_end)}</span>
              <b>{money(m.total_balance)}</b>
            </div>
          </div>
        ))}
      </section>
      <div className="grid2">
        <section className="panel stack tight">
          <h2>After {cycles(rows.length)}</h2>
          <p className="muted">
            By {fullDate(last.period_end)}: {money0(plan.total_debt - last.total_balance)} less debt. About {money0(interest)} of the {money0(paid)} goes to interest.
          </p>
        </section>
        <section className="panel stack tight">
          <h2>Keep it accurate</h2>
          <p className="muted">Ticking a box here moves no money. When a statement arrives, enter the real balance and the schedule is recalculated.</p>
          <a href="#/update">Update balances →</a>
        </section>
      </div>
    </main>
  );
}

const STRATEGY_NAME: Record<string, string> = { avalanche: "Highest APR first", snowball: "Smallest balance first", minimum: "Minimums only" };

export function Forecast() {
  const { plan, inputs, setInputs } = useStore();
  if (!plan || !inputs) return <main className="page muted">Calculating…</main>;
  if (plan.status !== "ok" || !plan.forecast) {
    return (
      <main className="page">
        <PageHead title="Forecast">There is no forecast yet. The plan page explains what is missing.</PageHead>
        <a className="btn" href="#/plan">
          Go to the plan
        </a>
      </main>
    );
  }
  const f = plan.forecast;
  const mine = plan.comparison.find((c) => c.strategy === plan.strategy)!;
  return (
    <main className="page">
      <PageHead title="Forecast">The same {money(plan.budget)} per payment cycle, placed three ways. All figures are estimates under the same assumptions.</PageHead>
      <section className="cols3">
        {plan.comparison.map((c) => {
          const diff = c.total_interest !== null && mine.total_interest !== null ? c.total_interest - mine.total_interest : null;
          return (
            <div key={c.strategy} className="col">
              <div className="row start">
                <h2>{STRATEGY_NAME[c.strategy]}</h2>
                {c.strategy === plan.strategy && <span className="pill accent">Your plan</span>}
              </div>
              <span className="big">
                <b>{c.status === "ok" ? monthName(c.debt_free_month) : "Does not clear"}</b> {c.months ? `· ${c.months} monthly payments` : ""}
              </span>
              <span className="muted">
                {c.strategy === "minimum" ? `Paying ${money(plan.minimums_total)} per cycle and nothing extra. Shown for reference.` : c.strategy === "avalanche" ? "Extra goes to the highest APR until that card is cleared." : "Extra goes to the smallest balance until that card is cleared."}
              </span>
              <dl className="kv">
                <dt>Estimated interest</dt>
                <dd>
                  <b>{c.total_interest === null ? "—" : money(c.total_interest)}</b>
                </dd>
                <dt>Against your plan</dt>
                <dd className={diff && diff > 0.005 ? "warn" : diff && diff < -0.005 ? "ok" : "muted"}>
                  {diff === null ? "—" : Math.abs(diff) < 0.005 ? "Baseline" : `${diff > 0 ? "+" : "−"}${money(Math.abs(diff))} interest`}
                </dd>
                <dt>First card cleared</dt>
                <dd>{c.first_cleared ? `${cardName(plan.cards, c.first_cleared.card_id)} · ${monthName(c.first_cleared.month)}` : "—"}</dd>
              </dl>
              {c.strategy !== "minimum" && c.strategy !== plan.strategy && (
                <button type="button" className="btn ghost" onClick={() => setInputs({ ...inputs, strategy: c.strategy as Strategy })}>
                  Use this strategy
                </button>
              )}
            </div>
          );
        })}
      </section>
      <section className="panel stack">
        <h2>When each card is cleared on your plan</h2>
        {plan.cards
          .filter((c) => f.payoff_cycle[c.id])
          .map((c) => (
            <div key={c.id} className="track">
              <b>{c.name}</b>
              <Meter value={(f.payoff_cycle[c.id] / f.months) * 100} />
              <span>
                {monthName(f.payoff_month[c.id])} · cycle {f.payoff_cycle[c.id]}
              </span>
            </div>
          ))}
        <span className="small muted">
          Scale: payment cycle 1 to {f.months}. The month shown is when that card’s last payment is due.
        </span>
      </section>
      <section className="panel stack tight">
        <h2>When ranking by APR is not enough</h2>
        <p className="muted">A promo rate that ends soon, a deferred-interest offer or a fee can change the best order. This version ranks by the APR you entered and does not model promo periods yet.</p>
      </section>
    </main>
  );
}

export function CreditUse() {
  const { plan } = useStore();
  if (!plan) return <main className="page muted">Calculating…</main>;
  const use = plan.limit_use;
  const after = use.after_date ? `After 3 payment cycles (by ${fullDate(use.after_date)}), estimated` : "After 3 payment cycles, estimated";
  return (
    <main className="page">
      <PageHead title="Credit limit use">How much of each credit limit is in use, and how your payoff plan changes it. These figures come from the same forecast as the plan.</PageHead>
      <section className="panel stack">
        <div className="use head-row small muted">
          <span>Card</span>
          <span>Today</span>
          <span>{after}</span>
        </div>
        {use.cards.map((u) => (
          <div key={u.card_id} className="use">
            <span>
              <b>{cardName(plan.cards, u.card_id)}</b>
              <span className="small muted">{money0(u.limit)} limit</span>
            </span>
            <span className="use-cell">
              <Meter value={u.now_pct} />
              {pct(u.now_pct)} · {money0(u.balance)}
            </span>
            <span className="use-cell">
              {u.after_pct === null ? (
                <span className="muted">No forecast yet</span>
              ) : (
                <>
                  <Meter value={u.after_pct} />
                  {pct(u.after_pct)} · {money0(u.after_balance ?? 0)}
                </>
              )}
            </span>
          </div>
        ))}
        {use.missing.map((name) => (
          <div key={name} className="use">
            <span>
              <b>{name}</b>
              <span className="small muted">No credit limit entered</span>
            </span>
            <a href="#/setup/3">Add your credit limit to see this estimate.</a>
            <span />
          </div>
        ))}
        {use.complete && (
          <div className="use total">
            <span>
              <b>Across the cards you added</b>
              <span className="small muted">Total balances ÷ total limits ({money0(use.total_limit ?? 0)})</span>
            </span>
            <span className="use-cell">
              <Meter value={use.now_pct ?? 0} />
              {pct(use.now_pct)}
            </span>
            <span className="use-cell">
              {use.after_pct === null ? (
                <span className="muted">No forecast yet</span>
              ) : (
                <>
                  <Meter value={use.after_pct} />
                  {pct(use.after_pct)}
                </>
              )}
            </span>
          </div>
        )}
        {!use.complete && use.cards.length > 0 && <p className="small muted">A combined figure appears once every card has a credit limit. Missing limits do not affect your payoff plan.</p>}
        {use.cards.length === 0 && <p className="muted">No card has a credit limit entered yet. Your payoff plan works without them.</p>}
      </section>
      <p className="muted">Lower credit utilization may help your credit score. Actual changes depend on your full credit profile and when lenders report updates.</p>
      <section className="cols3">
        <div className="col">
          <h2>Payment due date</h2>
          <p className="muted">The last day to pay at least the minimum without a late fee. The plan is built around this date.</p>
        </div>
        <div className="col">
          <h2>Statement closing date</h2>
          <p className="muted">The day the bank totals the cycle and prints the statement balance. It is not the due date.</p>
        </div>
        <div className="col">
          <h2>Reporting date</h2>
          <p className="muted">When the bank sends a balance to the credit bureaus. Often near the closing date, but each bank decides. FinPilot does not know it.</p>
        </div>
      </section>
    </main>
  );
}
