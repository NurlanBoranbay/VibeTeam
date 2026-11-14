import { useEffect, useState, type CSSProperties } from "react";
import { downloadCalendar, type Payment, type Plan as PlanData, type Strategy } from "../api";
import { dateLabel, fullDate, money, money0, monthName, pct, rangeLabel } from "../format";
import { useStore } from "../store";
import { CardFace, cardName, FACES, Fold, Meter, PageHead, SplitBar, Stat } from "../ui";

// Periods on every screen are PAYMENT CYCLES: rolling months from the plan's start date, shown
// with the dates they cover. See backend/app/engine.py.

/** What a payment is made of, without relabelling the statement minimum. */
function describe(p: Payment): string {
  if (p.payoff) {
    return p.total < p.statement_minimum
      ? `Pays off the card. Estimated payoff amount, lower than your ${money(p.statement_minimum)} statement minimum because less is owed.`
      : "Pays off the card. Estimated payoff amount.";
  }
  return `${money(p.minimum)} minimum${p.extra > 0 ? ` + ${money(p.extra)} extra` : " only"}`;
}

function Assumptions({ plan }: { plan: PlanData }) {
  return (
    <Fold title="How this is calculated">
      <ul className="muted list small">
        {plan.assumptions.map((a) => (
          <li key={a}>{a}</li>
        ))}
        <li>FinPilot shows a plan. It does not move money.</li>
      </ul>
    </Fold>
  );
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Total balance per month. Pointing at a bar lights it up and shows that month's numbers. */
function BalanceChart({ plan }: { plan: PlanData }) {
  const f = plan.forecast!;
  const [at, setAt] = useState<number | null>(null);
  const labels = f.balance_by_cycle.length <= 14;
  const when = (i: number) => (i === 0 ? "Today" : fullDate(f.cycle_ends[i - 1]));
  return (
    <section className="panel stack">
      <div className="row">
        <h2>Your balance, month by month</h2>
        <a href="#/forecast">Compare strategies →</a>
      </div>
      <p className="chart-read" aria-live="polite">
        {at === null ? (
          <span className="muted">
            {money0(plan.total_debt)} today → $0 in {monthName(f.debt_free_month)}. Point at a bar to see that month.
          </span>
        ) : (
          <>
            <b>{when(at)}</b>
            <span>{money0(f.balance_by_cycle[at])} left</span>
            {at > 0 && <span className="ok">{money0(plan.total_debt - f.balance_by_cycle[at])} paid down</span>}
          </>
        )}
      </p>
      <div className={at === null ? "chart" : "chart hovering"} onMouseLeave={() => setAt(null)}>
        {f.balance_by_cycle.map((v, i) => (
          <button key={i} type="button" className={at === i ? "chart-col on" : "chart-col"} aria-label={`${when(i)}: ${money0(v)} left`} onMouseEnter={() => setAt(i)} onFocus={() => setAt(i)} onClick={() => setAt(i)}>
            <span className={i === 0 ? "chart-bar today" : "chart-bar"} style={{ height: Math.max(3, (v / plan.total_debt) * 200) }} />
            {labels && <span className="small muted">{i === 0 ? "Today" : dateLabel(f.cycle_ends[i - 1])}</span>}
          </button>
        ))}
      </div>
    </section>
  );
}

/** Year rows of twelve months, like a wall calendar, with the plan's milestones marked. */
function MonthCalendar({ plan }: { plan: PlanData }) {
  const f = plan.forecast!;
  const start = plan.cycle.period_start.slice(0, 7);
  const end = f.debt_free_month ?? start;
  const cleared: Record<string, string[]> = {};
  plan.cards.forEach((c) => {
    const ym = f.payoff_month[c.id];
    if (ym) cleared[ym] = [...(cleared[ym] ?? []), c.name];
  });
  const years: number[] = [];
  for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) years.push(y);
  return (
    <section className="panel stack">
      <div className="row">
        <h2>Your payoff calendar</h2>
        <span className="cal-key small muted">
          <i className="k-card" /> Card paid off <i className="k-free" /> Debt-free
        </span>
      </div>
      {years.map((y) => (
        <div key={y} className="cal-year">
          <b>{y}</b>
          <div className="cal-months">
            {MONTH_SHORT.map((name, m) => {
              const ym = `${y}-${String(m + 1).padStart(2, "0")}`;
              const inPlan = ym >= start && ym <= end;
              const free = ym === end;
              const cards = cleared[ym];
              const kind = !inPlan ? "off" : free ? "free" : cards ? "card" : "on";
              return (
                <div key={ym} className={`cal-month ${kind}`}>
                  <span>{name}</span>
                  {inPlan && <small>{free ? "Debt-free" : cards ? `${cards.join(", ")} paid off` : ym === start ? "Start" : ""}</small>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

/**
 * Every due date of the whole plan on real month cards. By default the cards form a carousel: the
 * chosen month is in front, the months before and after sit tilted at its sides, and the arrows (or
 * a click on a side card) roll it. "Flat view" lays three months side by side instead. Cards are
 * keyed by month, so they move to their new place rather than being redrawn.
 * A marked day shows a small pop-up on hover and full details when clicked; clicking a card turns it
 * over to list that month's payments.
 */
function DueCalendar({ plan }: { plan: PlanData }) {
  const [at, setAt] = useState<string | null>(null);
  const [pin, setPin] = useState<string | null>(null); // the clicked day: its pop-up stays open with full details
  const [left, setLeft] = useState<string | null>(null); // the day the pointer has just moved off
  const [center, setCenter] = useState(1); // index of the month in front; 0 is the empty month before the plan
  const [flat, setFlat] = useState(false);
  const [turned, setTurned] = useState<string[]>([]); // month cards showing their back; each one flips on its own
  const flipCard = (key: string) => setTurned((now) => (now.includes(key) ? now.filter((k) => k !== key) : [...now, key]));
  // A pop-up closes shortly after the pointer leaves its day, however far it went: quickly for the
  // small hover one, after a few seconds for a pinned one. Moving back onto the day cancels it.
  useEffect(() => {
    if (!left) return;
    const quick = setTimeout(() => setAt((now) => (now === left ? null : now)), 175);
    const slow = setTimeout(() => setPin(null), 2000);
    return () => {
      clearTimeout(quick);
      clearTimeout(slow);
    };
  }, [left]);
  // A pinned pop-up also closes on a click anywhere outside a marked day.
  useEffect(() => {
    if (!pin) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest(".due-cell")) setPin(null);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [pin]);

  const all = plan.forecast?.due_dates ?? [];
  const due: Record<string, { name: string; face: number; p: (typeof all)[number] }[]> = {};
  all.forEach((p) => {
    due[p.due] = [...(due[p.due] ?? []), { name: cardName(plan.cards, p.card_id), face: Math.max(0, plan.cards.findIndex((c) => c.id === p.card_id)), p }];
  });
  const first = plan.cycles[0].period_start;
  const cycleEnds = plan.forecast?.cycle_ends ?? [];
  const last = [cycleEnds[cycleEnds.length - 1] ?? first, ...Object.keys(due)].sort().pop()!;
  const months: [number, number][] = [];
  for (let y = Number(first.slice(0, 4)), m = Number(first.slice(5, 7)); `${y}-${String(m).padStart(2, "0")}` <= last.slice(0, 7); m === 12 ? ((m = 1), y++) : m++) months.push([y, m]);
  // the month before the plan starts sits at the left of the first month, empty, so the carousel opens balanced
  months.unshift(months[0][1] === 1 ? [months[0][0] - 1, 12] : [months[0][0], months[0][1] - 1]);
  const n = months.length;
  // the empty month is never in front; flat view shows three whole months starting from the plan's first
  // one more card after the last month: the finish line
  const hi = flat ? Math.max(1, n - 1) : n;
  const lo = flat ? Math.min(2, hi) : 1;
  const mid = Math.min(Math.max(center, lo), hi);
  const roll = (to: number) => {
    setCenter(Math.min(hi, Math.max(lo, to)));
    setAt(null);
    setPin(null);
  };
  const name = (i: number) => (i >= n ? "Debt-free" : `${MONTH_SHORT[months[i][1] - 1]} ${months[i][0]}`);
  const placeOf = (d: number) =>
    ({
      transform: flat
        ? `translateX(calc(-50% + ${d * 104}%))`
        : `translateX(calc(-50% + ${d * 72}%)) translateY(${Math.abs(d) * 26}px) rotate(${d * 7}deg) scale(${1 - Math.min(2, Math.abs(d)) * 0.14})`,
      opacity: Math.abs(d) > 1 ? 0 : !flat && d !== 0 ? 0.55 : 1,
      zIndex: 3 - Math.abs(d),
      pointerEvents: Math.abs(d) > 1 ? "none" : undefined,
    }) as CSSProperties;
  const floor = plan.comparison.find((c) => c.strategy === "minimum");
  const mine = plan.comparison.find((c) => c.strategy === plan.strategy);
  const kept = floor && floor.status === "ok" && floor.total_interest !== null && mine && mine.total_interest !== null ? floor.total_interest - mine.total_interest : null;
  return (
    <section className="panel stack">
      <div className="row">
        <h2>Due dates</h2>
        <div className="due-nav">
          <button type="button" className="due-toggle" aria-pressed={flat} onClick={() => { setFlat(!flat); setPin(null); }}>
            {flat ? "Carousel" : "Flat view"}
          </button>
          <button type="button" className="due-arrow" aria-label="Earlier month" disabled={mid <= lo} onClick={() => roll(mid - 1)}>
            ‹
          </button>
          <span className="small muted due-range">{flat ? `${name(Math.max(0, mid - 1))} – ${name(mid + 1)}` : name(mid)}</span>
          <button type="button" className="due-arrow" aria-label="Later month" disabled={mid >= hi} onClick={() => roll(mid + 1)}>
            ›
          </button>
        </div>
      </div>
      <div className={flat ? "due-stage flat" : "due-stage"}>
        {months.map(([y, m], idx) => {
          const d = idx - mid;
          if (Math.abs(d) > 2) return null; // two steps away is kept (invisible) so it can roll in
          const key = `${y}-${String(m).padStart(2, "0")}`;
          const side = !flat && d !== 0;
          const lead = new Date(y, m - 1, 1).getDay();
          const days = new Date(y, m, 0).getDate();
          const list = all.filter((p) => p.due.startsWith(key)).sort((p, q) => p.due.localeCompare(q.due));
          const total = list.reduce((sum, p) => sum + p.total, 0);
          const place = placeOf(d);
          return (
            <div
              key={key}
              className={`due-card ${side ? "side" : "main"} ${turned.includes(key) ? "turned" : ""}`}
              style={place}
              role="button"
              tabIndex={Math.abs(d) > 1 ? -1 : 0}
              aria-label={side ? `Show ${name(idx)}` : `${name(idx)}: ${turned.includes(key) ? "show the calendar" : "show this month’s payments"}`}
              onClick={() => (side ? roll(idx) : (flipCard(key), setPin(null)))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.target === e.currentTarget) side ? roll(idx) : flipCard(key);
              }}
            >
              <div className="due-flip">
                <div className="due-face">
                  <div className="due-month-head">
                    <b>{name(idx)}</b>
                    <span className="due-month-total">{total > 0 ? `Pay ${money(total)}` : "Nothing due"}</span>
                  </div>
                  <div className="due-grid">
                    {["S", "M", "T", "W", "T", "F", "S"].map((w, i) => (
                      <span key={`h${i}`} className="due-head">
                        {w}
                      </span>
                    ))}
                    {Array.from({ length: lead }, (_, i) => (
                      <span key={`e${i}`} />
                    ))}
                    {Array.from({ length: days }, (_, i) => {
                      const iso = `${key}-${String(i + 1).padStart(2, "0")}`;
                      const inPlan = iso >= first && iso <= last;
                      if (!due[iso]) return <span key={iso} className={`due-day ${inPlan ? "" : "off"} ${iso === first ? "today" : ""}`}>{i + 1}</span>;
                      const col = (lead + i) % 7;
                      const full = pin === iso;
                      return (
                        <span key={iso} className="due-cell" onClick={(e) => e.stopPropagation()} onMouseEnter={() => { setAt(iso); setLeft(null); }} onMouseLeave={() => setLeft(iso)}>
                          <button
                            type="button"
                            className={`due-day marked ${at === iso || full ? "on" : ""}`}
                            aria-expanded={full}
                            aria-label={`${fullDate(iso)}: ${due[iso].map((x) => `${x.name} ${money(x.p.total)}`).join(", ")}`}
                            onFocus={() => { setAt(iso); setLeft(null); }}
                            onBlur={() => setLeft(iso)}
                            onClick={() => setPin(full ? null : iso)}
                          >
                            {i + 1}
                          </button>
                          {(at === iso || full) && (
                            <span className={`due-pop ${full ? "full" : "mini"} ${col <= 1 ? "pop-l" : col >= 5 ? "pop-r" : ""}`} role="tooltip">
                              {full && <span className="due-pop-date">{fullDate(iso)}</span>}
                              {due[iso].map((x) => (
                                <span key={x.name} className="due-pop-item">
                                  <span className="due-pop-head">
                                    <i className="mini-card" style={{ background: FACES[x.face % FACES.length].face, borderColor: FACES[x.face % FACES.length].edge }} aria-hidden="true" />
                                    <span>
                                      <b>{x.name}</b>
                                      <span className="due-pop-amount">{money(x.p.total)}</span>
                                    </span>
                                  </span>
                                  {full && (
                                    <dl className="due-pop-facts">
                                      <dt>Minimum</dt>
                                      <dd>{money(x.p.minimum)}</dd>
                                      <dt>Extra</dt>
                                      <dd>{x.p.extra > 0 ? money(x.p.extra) : "—"}</dd>
                                      <dt>Balance after, est.</dt>
                                      <dd>{x.p.end_balance === null ? "—" : money(x.p.end_balance)}</dd>
                                      {x.p.payoff && <dt className="ok">Pays off this card</dt>}
                                    </dl>
                                  )}
                                </span>
                              ))}
                              {!full && <span className="due-pop-tip">Click for details</span>}
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                  {!side && <span className="due-hint">Tap the card for this month’s payments</span>}
                </div>
                <div className="due-face due-back" aria-hidden={!turned.includes(key)}>
                  <div className="due-month-head">
                    <b>{name(idx)}</b>
                    <span className="due-month-total">{total > 0 ? `Pay ${money(total)}` : "Nothing due"}</span>
                  </div>
                  <ul className="due-list">
                    {list.map((p) => {
                      const face = FACES[Math.max(0, plan.cards.findIndex((c) => c.id === p.card_id)) % FACES.length];
                      return (
                        <li key={`${p.due}-${p.card_id}`}>
                          <i className="mini-card" style={{ background: face.face, borderColor: face.edge }} aria-hidden="true" />
                          <span>
                            <b>{cardName(plan.cards, p.card_id)}</b>
                            <span className="small muted">
                              {dateLabel(p.due)}
                              {p.payoff ? " · paid off" : p.end_balance !== null ? ` · ${money0(p.end_balance)} left` : ""}
                            </span>
                          </span>
                          <b>{money(p.total)}</b>
                        </li>
                      );
                    })}
                    {list.length === 0 && <li className="muted">No payments are due this month.</li>}
                  </ul>
                  <span className="due-hint">Tap to see the calendar</span>
                </div>
              </div>
            </div>
          );
        })}
        {Math.abs(n - mid) <= 2 && (
          <div
            key="finish"
            className={`due-card finish ${!flat && n !== mid ? "side" : "main"}`}
            style={placeOf(n - mid)}
            role={!flat && n !== mid ? "button" : undefined}
            tabIndex={!flat && n !== mid && Math.abs(n - mid) <= 1 ? 0 : -1}
            aria-label="Debt-free"
            onClick={() => roll(n)}
            onKeyDown={(e) => {
              if (e.key === "Enter") roll(n);
            }}
          >
            <div className="due-flip">
              <div className="due-face">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M8 12.5l3 3 5-6" />
                </svg>
                <b className="finish-title">You made it!</b>
                <span className="finish-sub">Debt-free in {monthName(plan.forecast?.debt_free_month)}</span>
                <span className="finish-facts">
                  {money0(plan.total_debt)} paid off · {plan.forecast?.months} payments
                  {kept !== null && kept > 0.5 ? ` · ${money0(kept)} interest kept in your pocket` : ""}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function Shortfall({ plan }: { plan: PlanData }) {
  const covered = plan.minimums_total ? (plan.budget / plan.minimums_total) * 100 : 0;
  return (
    <main className="page">
      <PageHead kicker={<span className="pill danger">No payoff plan yet</span>} title={`${money(plan.shortfall)} short of your minimum payments`}>
        Your minimums are {money(plan.minimums_total)} a month and your budget is {money(plan.budget)}. Cover the minimums first to get a payoff plan.
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
        <h2>Credit usage</h2>
        <a href="#/update">See each card →</a>
      </div>
      <ul className="list plain">
        {use.cards.map((u) => (
          <li key={u.card_id}>
            <b>{cardName(plan.cards, u.card_id)}:</b> {pct(u.now_pct)} used now
            {u.after_pct !== null ? ` → ${pct(u.after_pct)} after 3 months${use.after_date ? ` (by ${fullDate(use.after_date)})` : ""}.` : "."}
          </li>
        ))}
        {use.missing.map((name) => (
          <li key={name} className="muted">
            <b>{name}:</b> <a href="#/setup/3">Add your credit limit to see this estimate.</a>
          </li>
        ))}
      </ul>
      <p className="small muted">Lower usage may help your credit score. Results depend on your full credit profile.</p>
    </section>
  );
}

const KIND_PILL: Record<string, string> = { revolving: "pill accent", paid_off: "pill ok-tag", grace: "pill ok-tag", review: "pill warn-tag" };

/**
 * A card is outside the ordinary revolving model, so nothing is forecast for the portfolio. Each card
 * is shown with what is known and what to check; no combined payoff date or savings figure appears.
 */
function Limited({ plan }: { plan: PlanData }) {
  const full = plan.status === "pay_in_full";
  const names = plan.blocked_by;
  return (
    <main className="page">
      <PageHead kicker={<span className={full ? "pill ok-tag" : "pill warn-tag"}>{full ? "No interest forecast needed" : "No payoff forecast yet"}</span>} title={full ? "You pay your cards in full" : "Some cards need a closer look"}>
        {full
          ? "There is no interest to plan around. Here is what to pay and when."
          : names.length > 0
            ? `${names.join(" and ")} can’t be forecast with what we know, so there is no debt-free date or savings figure for now. Nothing is guessed.`
            : "A card you pay in full sits next to one that carries a balance. They are not combined into one forecast, so there is no debt-free date for now."}
      </PageHead>
      <section className="review">
        {plan.card_status.map((x, i) => {
          const card = plan.cards.find((c) => c.id === x.card_id)!;
          return (
            <div key={x.card_id} className="panel review-card status-card">
              <CardFace card={card} index={i} zoom={0.42} />
              <div className="stack tight">
                <div className="row start">
                  <h2>{x.name}</h2>
                  <span className={KIND_PILL[x.kind]}>{x.title}</span>
                </div>
                <p className="muted">{x.message}</p>
                {x.amount !== null && (
                  <p className="big">
                    {x.amount_label}: <b>{money(x.amount)}</b>
                    {x.due ? ` by ${fullDate(x.due)}` : ""}
                  </p>
                )}
                {x.kind === "grace" && x.amount === null && <p className="small muted">Add the statement amount still to pay to see it here. It is not the same as the current balance.</p>}
              </div>
            </div>
          );
        })}
      </section>
      {plan.shortfall > 0 && (
        <p className="note danger">
          Your budget is {money(plan.shortfall)} short of the minimums on the cards that carry a balance. <a href="#/bank">Prepare a call to the issuer</a>
        </p>
      )}
      <div className="actions">
        <a className="btn" href="#/setup/3">
          Review my cards
        </a>
        <span className="small muted">FinPilot forecasts ordinary purchase balances that are already charged interest. Special financing and mixed-rate cards need more detail than it models.</span>
      </div>
      <CreditHealth plan={plan} />
      <Assumptions plan={plan} />
    </main>
  );
}

/** Where the person stands: what the plan saves, how long is left, how much is already gone. */
function ProgressStrip({ plan }: { plan: PlanData }) {
  const { progress } = useStore();
  const f = plan.forecast;
  if (!f) return null;
  const mine = plan.comparison.find((c) => c.strategy === plan.strategy);
  const floor = plan.comparison.find((c) => c.strategy === "minimum");
  const saved = floor && floor.total_interest !== null && floor.status === "ok" && mine && mine.total_interest !== null ? floor.total_interest - mine.total_interest : null;
  const lastDue = f.due_dates.map((d) => d.due).sort().pop();
  const days = lastDue ? Math.round((Date.parse(lastDue) - Date.parse(plan.cycle.period_start)) / 86400000) : f.months * 30;
  const peak = Math.max(progress.peak, plan.total_debt);
  const cleared = peak > 0 ? (1 - plan.total_debt / peak) * 100 : 0;
  const done = plan.cards.filter((c) => c.balance === 0);
  return (
    <section className="progress-strip">
      <div>
        <span className="muted">This plan saves</span>
        <b className="ok">{saved === null ? "A lot" : money0(saved)}</b>
        <span className="small muted">{saved === null ? "Minimums alone never clear this debt" : "in interest vs paying only minimums"}</span>
      </div>
      <div>
        <span className="muted">Debt-free in</span>
        <b>{days} days</b>
        <span className="small muted">{monthName(f.debt_free_month)}</span>
      </div>
      <div>
        <span className="muted">Paid off so far</span>
        <b>{pct(cleared)}</b>
        <Meter value={cleared} />
        <span className="small muted">
          {money0(peak - plan.total_debt)} of {money0(peak)}
          {progress.paid > 0 ? ` · ${progress.paid} payment${progress.paid === 1 ? "" : "s"} marked paid` : ""}
        </span>
      </div>
      {done.length > 0 && (
        <span className="pill ok-tag progress-done">
          {done.map((c) => c.name).join(" and ")} paid off
        </span>
      )}
    </section>
  );
}

/** Small one-off jobs, each with what it is worth. Ticking one is remembered for this visit (and on this device when saving is on). */
function Missions({ plan }: { plan: PlanData }) {
  const { progress, toggleMission } = useStore();
  const top = plan.cards.filter((c) => c.apr !== null && c.balance > 0).sort((a, b) => (b.apr ?? 0) - (a.apr ?? 0))[0];
  const list: { id: string; title: string; worth: string; href: string }[] = [];
  if (top) list.push({ id: `call-${top.id}`, title: `Call the bank about ${top.name}`, worth: `A 5-point lower APR saves about ${money0(top.balance * 0.05)} a year`, href: "#/bank" });
  if (plan.missing_apr.length > 0) list.push({ id: "apr", title: `Add the APR for ${plan.missing_apr.join(" and ")}`, worth: "Unlocks your interest forecast", href: "#/update" });
  list.push({ id: "calendar", title: "Put due dates in your calendar", worth: "A late fee is usually $30 or more", href: "#/schedule" });
  list.push({ id: "whatif", title: "Try $50 more a month", worth: "See how much sooner you are debt-free", href: "#/what-if" });
  if (plan.limit_use.missing.length > 0) list.push({ id: "limits", title: "Add your credit limits", worth: "Shows your credit usage", href: "#/update" });
  const count = list.filter((m) => progress.missions.includes(m.id)).length;
  return (
    <section className="panel stack tight">
      <div className="row">
        <h2>Quick wins</h2>
        <span className="pill">
          {count} of {list.length} done
        </span>
      </div>
      {list.map((m) => {
        const on = progress.missions.includes(m.id);
        return (
          <div key={m.id} className={on ? "mission done" : "mission"}>
            <input type="checkbox" id={`m-${m.id}`} checked={on} onChange={() => toggleMission(m.id)} />
            <label htmlFor={`m-${m.id}`}>
              <b>{m.title}</b>
              <span className="small muted">{m.worth}</span>
            </label>
            <a className="btn ghost small" href={m.href}>
              Go
            </a>
          </div>
        );
      })}
    </section>
  );
}

/** Paid more often than monthly: how much to set aside from each paycheck so the month's payments are covered. */
function Payday({ plan }: { plan: PlanData }) {
  const [per, setPer] = useState(1);
  const total = plan.this_cycle.reduce((sum, p) => sum + p.total, 0);
  return (
    <section className="panel stack tight">
      <div className="row">
        <h2>When do you get paid?</h2>
        <div className="tabs" role="tablist">
          {[
            [1, "Monthly"],
            [2, "Every 2 weeks"],
            [4, "Weekly"],
          ].map(([n, label]) => (
            <button key={n} type="button" role="tab" aria-selected={per === n} className={per === n ? "tab on" : "tab"} onClick={() => setPer(n as number)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="big">
        Set aside <b>{money(Math.ceil((total / per) * 100) / 100)}</b> from each paycheck.
      </p>
      {per > 1 && (
        <ul className="list plain small muted">
          {plan.this_cycle.map((p) => (
            <li key={p.card_id}>
              {cardName(plan.cards, p.card_id)}: {money(Math.ceil((p.total / per) * 100) / 100)} per paycheck, {money(p.total)} due {p.due ? dateLabel(p.due) : "this month"}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Plan() {
  const { plan, inputs } = useStore();
  if (!plan || !inputs) return <main className="page muted">Calculating…</main>;
  if (plan.status === "limited" || plan.status === "pay_in_full") return <Limited plan={plan} />;
  if (plan.status === "shortfall") return <Shortfall plan={plan} />;
  if (plan.status === "no_debt") {
    return (
      <main className="page">
        <PageHead title="No card balances to pay off" image="/img/fp-debt-free-coin.jpg">
          Every card is at $0. If a balance comes back, update the card.
        </PageHead>
      </main>
    );
  }
  // payments of the current cycle, soonest due date first
  const rows = plan.this_cycle
    .map((p) => ({ p, card: plan.cards.find((c) => c.id === p.card_id)! }))
    .sort((a, b) => (a.p.due ?? "9999").localeCompare(b.p.due ?? "9999"));
  const first = rows[0];
  const heroFace = FACES[Math.max(0, plan.cards.findIndex((c) => c.id === first.card.id)) % FACES.length]; // same face as on Balances
  const max = Math.max(...rows.map((r) => r.p.total));
  const target = rows.find((r) => r.p.extra > 0);
  const f = plan.forecast;
  const cycle = rangeLabel(plan.cycle.period_start, plan.cycle.period_end);
  const by = (due: string | null) => (due ? ` by ${dateLabel(due)}` : "");
  const placed = rows.reduce((s, r) => s + r.p.total, 0);
  // An APR is missing, so the card that would save the most interest cannot be named.
  const undecided = plan.unallocated > 0 && plan.missing_apr.length > 0;
  const needApr = plan.missing_apr.length === 1 ? `${plan.missing_apr[0]}’s APR` : `the APR for ${plan.missing_apr.join(" and ")}`;

  return (
    <main className="page">
      <div className="plan-hero">
        <span className="hero-card" style={{ "--face": heroFace.face, "--edge": heroFace.edge, "--glow": heroFace.glow, "--shine-delay": "0s" } as CSSProperties} aria-hidden="true">
          <span className="fan-face">
            <span className="fan-content">
              <span className="fan-top">
                <b>{first.card.name}</b>
                <span>{first.card.apr === null ? "" : `${first.card.apr}% APR`}</span>
              </span>
              <span className="fan-chip" />
              <span className="fan-bottom">
                <span>Balance</span>
                <b>{money(first.card.balance)}</b>
              </span>
            </span>
          </span>
        </span>
        <div className="hero-text">
          <span className="hero-kicker">Next payment · {cycle}</span>
          <h1>
            <span className="nw">
              Pay {money(first.p.total)} to {first.card.name}
            </span>{" "}
            <span className="nw">{by(first.p.due).trim()}</span>
          </h1>
        </div>
      </div>

      {inputs.first_month_budget !== null && inputs.first_month_budget !== undefined && (
        <p className="note">
          This month uses the {money(inputs.first_month_budget)} you said is left for cards. From next month it is {money(plan.budget)}.
        </p>
      )}
      {undecided ? (
        <p className="note warn">
          Your minimum payments total {money(placed)}. You have {money(plan.unallocated)} remaining. Add {needApr} to determine where your extra payment could save the most
          interest. Until then there is no interest forecast or debt-free month. <a href="#/setup/3">Add it now</a>
        </p>
      ) : (
        plan.missing_apr.length > 0 && (
          <p className="note warn">
            {needApr} is missing, so there is no interest forecast or debt-free month yet. The payments below still follow your chosen order. <a href="#/setup/3">Add it now</a>
          </p>
        )
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
            <span className="muted">{describe(p)}</span>
            <dl className="kv">
              <dt>Balance today</dt>
              <dd>{money(card.balance)}</dd>
              <dt>APR</dt>
              <dd>{card.apr === null ? "Not entered" : `${card.apr}%`}</dd>
              <dt>Statement minimum</dt>
              <dd>{money(p.statement_minimum)}</dd>
              {p.interest !== null && p.end_balance !== null && (
                <>
                  <dt>Interest this cycle, est.</dt>
                  <dd>{money(p.interest)}</dd>
                  <dt>Balance after this payment, est.</dt>
                  <dd>{money(p.end_balance)}</dd>
                </>
              )}
            </dl>
            {p.payoff && <span className="small muted">Estimated payoff. Check your issuer’s balance and next statement for any remaining interest or fees.</span>}
            <a className="btn ghost" href="#/update">
              Update balance
            </a>
          </div>
        ))}
      </section>

      {f && (
        <>
          <ProgressStrip plan={plan} />
          <section className="grid4">
            <Stat label="Estimated debt-free month" value={monthName(f.debt_free_month)} note={`${f.months} monthly payments`} />
            <Stat label="Estimated interest" value={money(f.total_interest)} note={`On ${money0(plan.total_debt)} owed today`} />
            <Stat label="Monthly budget" value={money(plan.budget)} note={`${money(plan.minimums_total)} minimums + ${money(plan.above_minimums)} extra`} />
            <a className="panel stat link whatif-cta" href="#/what-if">
              <span>What if I pay more?</span>
              <b>Try another budget</b>
              <span className="small">See your new debt-free date →</span>
            </a>
          </section>

          <BalanceChart plan={plan} />
        </>
      )}

      <div className="grid2">
        {target && (
          <section className="panel stack tight">
            <h2>
              Why {target.card.name} gets the extra {money(target.p.extra)}
            </h2>
            <p className="muted">
              {plan.strategy === "snowball" ? "It has the smallest balance, so it is gone soonest." : "It has the highest APR, so each dollar there saves the most interest."}
              {target.card.apr !== null && plan.strategy === "avalanche" ? ` $100 left on it costs about ${money0(target.card.apr)} a year.` : ""}
            </p>
            {f?.payoff_month[target.card.id] && (
              <p className="muted">
                Paid off in {monthName(f.payoff_month[target.card.id])}. Then its payment moves to the next card.
              </p>
            )}
          </section>
        )}
        <CreditHealth plan={plan} />
      </div>
      <Missions plan={plan} />
      <Assumptions plan={plan} />
    </main>
  );
}

export function Schedule() {
  const { plan, inputs } = useStore();
  const [error, setError] = useState("");
  if (!plan || !inputs) return <main className="page muted">Calculating…</main>;
  if (plan.status !== "ok") {
    return (
      <main className="page">
        <PageHead title="Schedule">No schedule yet. The plan page shows what is missing.</PageHead>
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
        <PageHead title={rows.length === 1 ? "Your next month" : `Your next ${rows.length} months`}>
          {rows.reduce((s, m) => s + m.payments.length, 0)} payments · {money0(paid)} in total · balance {money0(plan.total_debt)} → {money0(last.total_balance)}
        </PageHead>
        <button type="button" className="btn ghost" onClick={() => downloadCalendar(inputs).catch(() => setError("We couldn’t create the calendar file. Please try again."))}>
          Add due dates to calendar
        </button>
      </div>
      {error && <p className="note danger">{error}</p>}
      <DueCalendar plan={plan} />
      <Payday plan={plan} />
      <p className="muted">
        By {fullDate(last.period_end)} you owe {money0(plan.total_debt - last.total_balance)} less. About {money0(interest)} of the {money0(paid)} is interest. Balance changed?{" "}
        <a href="#/update">Update it →</a>
      </p>
      <Fold title="How months are counted">
        <p className="small muted">A month here runs from today’s date to the same date next month, not from the 1st. Each card is paid once in it, on its due date.</p>
      </Fold>
    </main>
  );
}

const STRATEGY_NAME: Record<string, string> = { avalanche: "Highest APR first", snowball: "Smallest balance first", minimum: "Keep paying today’s minimums" };

const STRATEGY_WHY: Record<string, string> = {
  avalanche: "Extra money goes to the highest APR first.",
  snowball: "Extra money goes to the smallest balance first.",
  minimum: "Today’s minimum amounts, held constant as an approximation. Your issuer sets the real ones.",
};

export function Forecast() {
  const { plan, inputs, setInputs } = useStore();
  const [picked, setPicked] = useState<string | null>(null);
  if (!plan || !inputs) return <main className="page muted">Calculating…</main>;
  if (plan.status !== "ok" || !plan.forecast) {
    return (
      <main className="page">
        <PageHead title="Compare strategies">No forecast yet. The plan page shows what is missing.</PageHead>
        <a className="btn" href="#/plan">
          Go to the plan
        </a>
      </main>
    );
  }
  // Ranked by estimated interest, lowest first; a strategy that never clears the debt comes last.
  const cost = (c: (typeof plan.comparison)[number]) => (c.status === "ok" && c.total_interest !== null ? c.total_interest : Infinity);
  const ranked = [...plan.comparison].sort((a, b) => cost(a) - cost(b) || (a.months ?? 9999) - (b.months ?? 9999));
  const worst = Math.max(...ranked.map((c) => (cost(c) === Infinity ? 0 : cost(c))));
  const sel = ranked.find((c) => c.strategy === (picked ?? plan.strategy)) ?? ranked[0];
  const selRank = ranked.indexOf(sel) + 1;
  return (
    <main className="page">
      <PageHead title="Which strategy wins">Ranked by the interest you pay. Tap one to see it.</PageHead>
      <section className="podium" aria-label="Strategies ranked by estimated interest">
        {ranked.map((c, i) => {
          const saved = cost(c) === Infinity ? 0 : worst - cost(c);
          return (
            <button key={c.strategy} type="button" className={`podium-item p${i + 1} ${sel.strategy === c.strategy ? "on" : ""}`} aria-pressed={sel.strategy === c.strategy} onClick={() => setPicked(c.strategy)}>
              <span className="podium-tags">
                {i === 0 && <span className="pill ok-tag">Lowest interest</span>}
                {c.strategy === plan.strategy && <span className="pill accent">Your plan</span>}
              </span>
              <b className="podium-name">{STRATEGY_NAME[c.strategy]}</b>
              <span className="podium-cost">{c.total_interest === null || c.status !== "ok" ? "Never clears" : money(c.total_interest)}</span>
              <span className="small muted">{c.status === "ok" ? `interest · debt-free ${monthName(c.debt_free_month)}` : "at this payment"}</span>
              {saved > 0.005 && <span className="small ok">Saves {money0(saved)}</span>}
              <span className="podium-step">{i + 1}</span>
            </button>
          );
        })}
      </section>

      <section className="panel stack tight">
        <div className="row">
          <h2>
            #{selRank} · {STRATEGY_NAME[sel.strategy]}
          </h2>
          {sel.strategy !== "minimum" && sel.strategy !== plan.strategy && (
            <button type="button" className="btn" onClick={() => setInputs({ ...inputs, strategy: sel.strategy as Strategy })}>
              Use this strategy
            </button>
          )}
        </div>
        <p className="muted">{STRATEGY_WHY[sel.strategy]}</p>
        <div className="grid4">
          <Stat label="You pay each month" value={money(sel.payment_basis)} note={sel.strategy === "minimum" ? "Minimums only" : "Your budget"} />
          <Stat label="Debt-free" value={sel.status === "ok" ? monthName(sel.debt_free_month) : "Never"} note={sel.months ? `${sel.months} payments` : ""} />
          <Stat label="Interest, estimated" value={sel.total_interest === null ? "—" : money(sel.total_interest)} />
          <Stat label="First card paid off" value={sel.first_cleared ? cardName(plan.cards, sel.first_cleared.card_id) : "—"} note={sel.first_cleared ? monthName(sel.first_cleared.month) : ""} />
        </div>
      </section>

      <MonthCalendar plan={plan} />
    </main>
  );
}
