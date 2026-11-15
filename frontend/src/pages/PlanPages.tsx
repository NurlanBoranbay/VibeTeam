import { useEffect, useState, type CSSProperties } from "react";
import { downloadCalendar, type Payment, type Plan as PlanData, type Strategy } from "../api";
import { dateLabel, fullDate, money, money0, monthName, pct, rangeLabel } from "../format";
import { useStore } from "../store";
import { CardFace, cardName, FACES, Fold, Meter, PageHead, PayLegend, SplitBar, Stat, useFaces } from "../ui";

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
function BalanceChart({ plan, canCompare }: { plan: PlanData; canCompare?: boolean }) {
  const f = plan.forecast!;
  const [at, setAt] = useState<number | null>(null);
  const last = f.balance_by_cycle.length - 1;
  const labels = f.balance_by_cycle.length <= 16;
  const when = (i: number) => (i === 0 ? "Today" : i === last ? `After the last payment (payment ${i})` : `After payment ${i} of ${last}`);
  return (
    <section className="panel stack">
      <div className="row">
        <h2>Your balance after each monthly payment</h2>
        {canCompare && (
          <button type="button" className="link small" onClick={() => document.getElementById("order")?.scrollIntoView({ behavior: "smooth", block: "center" })}>
            Compare the two orders ↑
          </button>
        )}
      </div>
      <p className="chart-read" aria-live="polite">
        {at === null ? (
          <span className="muted">
            {money0(plan.total_debt)} today → $0 after payment {last}, due in {monthName(f.debt_free_month)}. Tap a bar to see that payment.
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
            <span className={i === 0 ? "chart-bar today" : i === last ? "chart-bar done" : "chart-bar"} style={{ height: Math.max(3, (v / plan.total_debt) * 200) }} />
            {labels && <span className="small muted">{i === 0 ? "Today" : i === last ? "Paid off" : i}</span>}
          </button>
        ))}
      </div>
      <span className="small muted">
        Bars are numbered payments, not exact dates. The last payment is due in {monthName(f.debt_free_month)}; the balance reaches $0 once it is made.
      </span>
    </section>
  );
}

/** Year rows of twelve months, like a wall calendar, with the plan's milestones marked. */
/**
 * Every due date of the whole plan on real month cards. By default the cards form a carousel: the
 * chosen month is in front, the months before and after sit tilted at its sides, and the arrows (or
 * a click on a side card) roll it. "Flat view" lays three months side by side instead. Cards are
 * keyed by month, so they move to their new place rather than being redrawn.
 * A marked day shows a small pop-up on hover and full details when clicked; clicking a card turns it
 * over to list that month's payments.
 */
function DueCalendar({ plan }: { plan: PlanData }) {
  const faceOf = useFaces(plan.cards);
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
    due[p.due] = [...(due[p.due] ?? []), { name: cardName(plan.cards, p.card_id), face: faceOf(p.card_id), p }];
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
                            className={`due-day marked ${due[iso].some((x) => x.p.payoff) ? "payoff" : ""} ${at === iso || full ? "on" : ""}`}
                            aria-expanded={full}
                            aria-label={`${fullDate(iso)}: ${due[iso].map((x) => `${x.name} ${money(x.p.total)}${x.p.payoff ? ", pays it off" : ""}`).join(", ")}`}
                            onFocus={() => { setAt(iso); setLeft(null); }}
                            onBlur={() => setLeft(iso)}
                            onClick={() => setPin(full ? null : iso)}
                          >
                            {i + 1}
                            <small>{money0(due[iso].reduce((sum, x) => sum + x.p.total, 0))}</small>
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
                                  {x.p.payoff && (
                                    <span className="due-pop-payoff">
                                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path d="M5 12.5l4.5 4.5L19 7.5" />
                                      </svg>
                                      {x.name} is paid off with this payment
                                    </span>
                                  )}
                                  {full && (
                                    <dl className="due-pop-facts">
                                      <dt>Minimum</dt>
                                      <dd>{money(x.p.minimum)}</dd>
                                      <dt>Extra</dt>
                                      <dd>{x.p.extra > 0 ? money(x.p.extra) : "—"}</dd>
                                      <dt>Balance after, est.</dt>
                                      <dd>{x.p.end_balance === null ? "—" : money(x.p.end_balance)}</dd>
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
                  {!side && <span className="due-hint">↻ Tap the card to list this month’s payments</span>}
                </div>
                <div className="due-face due-back" aria-hidden={!turned.includes(key)}>
                  <div className="due-month-head">
                    <b>{name(idx)}</b>
                    <span className="due-month-total">{total > 0 ? `Pay ${money(total)}` : "Nothing due"}</span>
                  </div>
                  <ul className="due-list">
                    {list.map((p) => {
                      const face = FACES[faceOf(p.card_id)];
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

/**
 * Where this month's money goes, as one bar: each card's slice is as wide as its share. One tone
 * only; the lighter part of a slice is the minimum, the solid part is the extra.
 */
export function FlowBar({ plan, rows, hot, setHot, title, detail }: { plan: PlanData; rows: { p: Payment; card: PlanData["cards"][number] }[]; hot: string | null; setHot: (id: string | null) => void; title?: string; detail?: boolean }) {
  const faceOf = useFaces(plan.cards);
  const total = rows.reduce((sum, r) => sum + r.p.total, 0);
  if (total <= 0) return null;
  return (
    <section className="panel stack tight flow">
      <div className="row">
        <h2>{title ?? `Where your ${money(total)} goes this month`}</h2>
        <span className="flow-key small muted">
          <i className="solid" /> extra
        </span>
      </div>
      {/* one column per card: its slice of the bar with its label underneath, so they always line up,
          and a very small payment still gets a readable column */}
      <div className={detail ? "flow-cols detail" : "flow-cols"} role="img" aria-label={rows.map((r) => `${r.card.name} ${money(r.p.total)}`).join(", ")} onMouseLeave={() => setHot(null)}>
        {rows.map(({ p, card }) => {
          const face = FACES[faceOf(card.id)];
          const share = (p.total / total) * 100;
          return (
            <div key={card.id} className={`flow-col ${hot === card.id ? "hot" : hot ? "dim" : ""}`} style={{ flexGrow: p.total }} onMouseEnter={() => setHot(card.id)}>
              <span className="flow-seg" style={{ background: face.face, borderColor: face.edge }}>
                <i className="soft" style={{ flexGrow: p.minimum }} />
                {p.extra > 0 && <i className="solid" style={{ flexGrow: p.extra }} />}
              </span>
              <span className="flow-label">
                <i className="mini-card" style={{ background: face.face, borderColor: face.edge }} aria-hidden="true" />
                <span>
                  <b>{money(p.total)}</b>
                  <span className="small muted">{share > 0 && share < 1 ? "<1%" : `${Math.round(share)}%`}</span>
                  {detail && <span className="small muted">{p.extra > 0 ? `${money(p.minimum)} min + ${money(p.extra)} extra` : p.payoff ? "pays it off" : "minimum only"}</span>}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const ORDER_BLURB: Record<string, string> = {
  avalanche: "Extra money goes to the card with the highest APR. Usually the least interest overall.",
  snowball: "Extra money goes to the smallest balance. A card is gone sooner, which keeps you going.",
};

/**
 * The payoff order, as two big choices side by side. Both are already worked out in the plan, so a
 * pick shows straight away; the rest of the page follows when the recalculation lands.
 */
function OrderChooser({ plan }: { plan: PlanData }) {
  const { inputs, update } = useStore();
  const [chosen, setChosen] = useState(plan.strategy);
  useEffect(() => setChosen(plan.strategy), [plan.strategy]);
  const cost = (c: (typeof plan.comparison)[number]) => (c.status === "ok" && c.total_interest !== null ? c.total_interest : Infinity);
  const orders = plan.comparison.filter((c) => c.strategy !== "minimum").sort((a, b) => cost(a) - cost(b) || (a.months ?? 9999) - (b.months ?? 9999));
  if (orders.length < 2 || !inputs) return null;
  const pick = (strategy: string) => {
    if (strategy === chosen) return;
    setChosen(strategy as Strategy);
    update({ ...inputs, strategy: strategy as Strategy });
  };
  return (
    <section className="panel stack order-panel" id="order">
      <div className="order-head">
        <h2>Which card gets the extra first?</h2>
        <p className="muted">Pick the order. Your minimums stay the same either way; only where the extra goes changes.</p>
      </div>
      <div className="order-opts" role="radiogroup" aria-label="Payoff order">
        {orders.map((c, i) => {
          const on = c.strategy === chosen;
          const extraCost = cost(c) - cost(orders[0]);
          return (
            <button key={c.strategy} type="button" role="radio" aria-checked={on} className={on ? "order-opt on" : "order-opt"} onClick={() => pick(c.strategy)}>
              <span className="order-opt-top">
                <i className="order-radio" aria-hidden="true" />
                <b>{STRATEGY_NAME[c.strategy]}</b>
                {i === 0 && <span className="pill ok-tag">Lowest interest</span>}
              </span>
              <span className="order-opt-why">{ORDER_BLURB[c.strategy]}</span>
              <span className="order-opt-num">
                <b>{c.status === "ok" && c.total_interest !== null ? money(c.total_interest) : "Never clears"}</b>
                <span>{c.status === "ok" ? "interest, estimated" : "at this budget"}</span>
                {i > 0 && Number.isFinite(extraCost) && extraCost > 0.005 && <span className="order-more">{money(extraCost)} more</span>}
              </span>
              <span className="order-opt-facts">
                <span>
                  Last payment <b>{c.status === "ok" ? monthName(c.debt_free_month) : "—"}</b>
                </span>
                <span>
                  First card done <b>{c.first_cleared ? monthName(c.first_cleared.month) : "—"}</b>
                </span>
              </span>
              <span className="order-opt-state">{on ? "✓ Your plan" : "Use this order"}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Why the extra money goes to this card: the cards compared as bars, then three short facts. */
function WhyBox({ plan, cardId, extra }: { plan: PlanData; cardId: string; extra: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const snow = plan.strategy === "snowball";
  const owing = plan.cards.filter((c) => c.balance > 0);
  const card = plan.cards.find((c) => c.id === cardId)!;
  const value = (c: (typeof owing)[number]) => (snow ? c.balance : c.apr ?? 0);
  const top = Math.max(...owing.map(value), 1);
  // who is next in line once this card is cleared
  const next = owing.filter((c) => c.id !== cardId).sort((a, b) => (snow ? a.balance - b.balance : (b.apr ?? 0) - (a.apr ?? 0)))[0];
  const done = plan.forecast?.payoff_month[cardId];
  const faq = [
    { id: "after", q: `What happens when ${card.name} is paid off?`, a: next ? `Its whole payment moves to ${next.name}, on top of that card’s minimum. Nothing is freed up for spending unless you change the budget.` : "It is your last card, so you are done." },
    { id: "other", q: "Would another order be better?", a: snow ? "Paying the highest APR first usually costs less interest. Smallest balance first clears a card sooner. Both are worked out for your cards above." : "Smallest balance first clears a card sooner but usually costs more interest. Both are worked out for your cards above." },
  ];
  return (
    <section className="panel stack tight why">
      <div className="why-head">
        <span className="why-mark" aria-hidden="true">
          ?
        </span>
        <h2>
          Why does {card.name} get the extra {money(extra)}?
        </h2>
      </div>
      <div className="why-bars" role="img" aria-label={owing.map((c) => `${c.name} ${snow ? money0(c.balance) : `${c.apr}%`}`).join(", ")}>
        {owing.map((c) => (
          <div key={c.id} className={c.id === cardId ? "why-bar on" : "why-bar"}>
            <span>{c.name}</span>
            <i style={{ width: `${Math.max(6, (value(c) / top) * 100)}%` }} />
            <b>{snow ? money0(c.balance) : c.apr === null ? "?" : `${c.apr}%`}</b>
          </div>
        ))}
      </div>
      <div className="why-facts">
        <span>
          <b>{snow ? "Smallest balance" : "Highest APR"}</b>
          {snow ? "Gone soonest" : "Each dollar here saves the most"}
        </span>
        {!snow && card.apr !== null && (
          <span>
            <b>≈ {money0(card.apr)} a year</b>
            What $100 left on it costs
          </span>
        )}
        {done && (
          <span>
            <b>{monthName(done)}</b>
            Its last payment, estimated
          </span>
        )}
      </div>
      {faq.map((f) => (
        <div key={f.id} className="why-q">
          <button type="button" aria-expanded={open === f.id} onClick={() => setOpen(open === f.id ? null : f.id)}>
            <span>{f.q}</span>
            <i aria-hidden="true">{open === f.id ? "–" : "+"}</i>
          </button>
          {open === f.id && <p className="muted">{f.a}</p>}
        </div>
      ))}
    </section>
  );
}

/** Compact credit-limit summary on the plan, from the same forecast as everything else. */
function CreditHealth({ plan }: { plan: PlanData }) {
  const use = plan.limit_use;
  const [later, setLater] = useState(false);
  if (use.cards.length === 0 && use.missing.length === 0) return null;
  const canProject = use.cards.some((u) => u.after_pct !== null);
  const show = later && canProject;
  return (
    <section className="panel stack tight usage-box">
      <div className="row">
        <h2>Credit usage</h2>
        {canProject && (
          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={!show} className={!show ? "tab on" : "tab"} onClick={() => setLater(false)}>
              Now
            </button>
            <button type="button" role="tab" aria-selected={show} className={show ? "tab on" : "tab"} onClick={() => setLater(true)}>
              In 3 months
            </button>
          </div>
        )}
      </div>
      {use.cards.map((u) => {
        const v = show && u.after_pct !== null ? u.after_pct : u.now_pct;
        return (
          <a key={u.card_id} className="usage-row" href={`#/update/${u.card_id}`}>
            <span>{cardName(plan.cards, u.card_id)}</span>
            <span className="usage-track">
              <i style={{ width: `${Math.min(100, Math.max(1, v))}%` }} />
            </span>
            <b>{pct(v)}</b>
          </a>
        );
      })}
      {use.complete && use.now_pct !== null && (
        <div className="usage-row total">
          <span>All cards</span>
          <span className="usage-track">
            <i style={{ width: `${Math.min(100, Math.max(1, show && use.after_pct !== null ? use.after_pct : use.now_pct))}%` }} />
          </span>
          <b>{pct(show && use.after_pct !== null ? use.after_pct : use.now_pct)}</b>
        </div>
      )}
      {use.missing.length > 0 && (
        <a className="small" href="#/update">
          Add a credit limit for {use.missing.join(" and ")} →
        </a>
      )}
      <p className="small muted">How much of each limit is in use. Lower usage may help your credit score; results depend on your full credit profile.</p>
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
        <span className="muted">Paying {money(plan.budget)} a month saves</span>
        <b className="ok">{saved === null ? "A lot" : money0(saved)}</b>
        <span className="small muted">
          {saved === null ? "Minimums alone never clear this debt" : `in interest, compared with paying ${money(plan.minimums_total)} a month instead of ${money(plan.budget)}`}
        </span>
      </div>
      <div>
        <span className="muted">Payments left</span>
        <b>{f.months}</b>
        <span className="small muted">Last one due in {monthName(f.debt_free_month)}, estimated</span>
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
  const list: { id: string; title: string; worth: string; href: string; go: string }[] = [];
  if (top) list.push({ id: `call-${top.id}`, title: `Call the bank about ${top.name}`, worth: `A 5-point lower APR saves about ${money0(top.balance * 0.05)} a year`, href: "#/bank", go: "Prepare the call" });
  if (plan.missing_apr.length > 0) list.push({ id: "apr", title: `Add the APR for ${plan.missing_apr.join(" and ")}`, worth: "Unlocks your interest forecast", href: "#/update", go: "Add the APR" });
  list.push({ id: "calendar", title: "Put due dates in your calendar", worth: "A late fee is usually $30 or more", href: "#/schedule", go: "Open the schedule" });
  list.push({ id: "whatif", title: "Try $50 more a month", worth: "See how much sooner you are debt-free", href: "#/what-if", go: "Open What if" });
  if (plan.limit_use.missing.length > 0) list.push({ id: "limits", title: "Add your credit limits", worth: "Shows your credit usage", href: "#/update", go: "Add limits" });
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
              {m.go}
            </a>
          </div>
        );
      })}
    </section>
  );
}

/** An example of setting money aside from each paycheck. Paydays are not collected, so this only divides the month's total. */
function Payday({ plan }: { plan: PlanData }) {
  const [per, setPer] = useState(1);
  const total = plan.this_cycle.reduce((sum, p) => sum + p.total, 0);
  if (total <= 0) return null;
  return (
    <section className="panel stack tight">
      <div className="row">
        <h2>Setting money aside: an example</h2>
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
        {money(total)} this month ÷ {per} = <b>{money(Math.ceil((total / per) * 100) / 100)}</b> per paycheck.
      </p>
      <p className="small muted">
        Example only. FinPilot doesn’t know your paydays, so it simply divides this month’s total. Check that the money is in your account before each due date.
      </p>
    </section>
  );
}

export function Plan() {
  const { plan, inputs, update } = useStore();
  const [hot, setHot] = useState<string | null>(null); // the card pointed at, on the bar or on a tile
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
  const target = rows.find((r) => r.p.extra > 0);
  const f = plan.forecast;
  const cycle = rangeLabel(plan.cycle.period_start, plan.cycle.period_end);
  const by = (due: string | null) => (due ? ` by ${dateLabel(due)}` : "");
  const placed = rows.reduce((s, r) => s + r.p.total, 0);
  // cards already paid for this month: shown as done, never as a second instruction to pay
  const settled = plan.cards.filter((c) => (c.paid ?? 0) > 0 && !rows.some((r) => r.card.id === c.id));
  // An APR is missing, so the card that would save the most interest cannot be named.
  const undecided = plan.unallocated > 0 && plan.missing_apr.length > 0;
  const needApr = plan.missing_apr.length === 1 ? `${plan.missing_apr[0]}’s APR` : `the APR for ${plan.missing_apr.join(" and ")}`;
  const oneOff = inputs.first_month_budget !== null && inputs.first_month_budget !== undefined;

  return (
    <main className="page">
      <div className="plan-hero">
        {first && <CardFace card={first.card} index={plan.cards.findIndex((c) => c.id === first.card.id)} />}
        <div className="hero-copy">
          <span className="hero-kicker">Next payment · {cycle}</span>
          {first ? (
            <h1>
              <span className="nw">
                Pay {money(first.p.total)} to {first.card.name}
              </span>{" "}
              <span className="nw">{by(first.p.due).trim()}</span>
            </h1>
          ) : (
            <h1>Nothing more to pay this month</h1>
          )}
        </div>
      </div>
      {/* what this plan saves and how far along it is, right under the next payment */}
      <ProgressStrip plan={plan} />

      {plan.paid_this_cycle > 0 && (
        <p className="note">
          {money(plan.paid_this_cycle)} paid · {money(placed)} still to pay this month · {money(plan.budget)} next month
        </p>
      )}
      {oneOff && plan.paid_this_cycle === 0 && (
        <p className="note">
          This month uses {money(inputs.first_month_budget!)} instead of your usual {money(plan.budget)}. From the next month it is {money(plan.budget)} again.{" "}
          <button type="button" className="link" onClick={() => update({ ...inputs, first_month_budget: null }, { text: `This month is back to ${money(plan.budget)}.` })}>
            Undo
          </button>
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

      <FlowBar plan={plan} rows={rows} hot={hot} setHot={setHot} />
      <section className="grid3 pay-tiles" onMouseLeave={() => setHot(null)}>
        {rows.map(({ p, card }) => (
          <div key={card.id} className={`panel pay-tile ${hot === card.id ? "hot" : hot ? "dim" : ""}`} onMouseEnter={() => setHot(card.id)}>
            <div className="tile-head">
              <CardFace card={card} index={plan.cards.findIndex((c) => c.id === card.id)} zoom={0.36} />
              <div>
                <h2>{money(p.total)}</h2>
                <span className="big">{p.due ? `by ${dateLabel(p.due)}` : "no due date"}</span>
                <span className="small muted">{p.extra > 0 ? `${money(p.minimum)} minimum + ${money(p.extra)} extra` : p.payoff ? "pays the card off" : "minimum only"}</span>
              </div>
            </div>
            <dl className="kv">
              <dt>Balance today</dt>
              <dd>{money(card.balance)}</dd>
              <dt>APR</dt>
              <dd>{card.apr === null ? "Not entered" : `${card.apr}%`}</dd>
              {(card.paid ?? 0) > 0 && (
                <>
                  <dt>Already paid this month</dt>
                  <dd>{money(card.paid ?? 0)}</dd>
                </>
              )}
              {p.interest !== null && p.end_balance !== null && (
                <>
                  <dt>Interest this month</dt>
                  <dd>{money(p.interest)}</dd>
                  <dt>Balance after paying</dt>
                  <dd>{money(p.end_balance)}</dd>
                </>
              )}
            </dl>
            {p.payoff && <span className="small muted">This pays the card off (estimated). Check your issuer’s balance for any remaining interest or fees.</span>}
            {p.total < p.statement_minimum && !p.payoff && <span className="small muted">Less than the {money(p.statement_minimum)} statement minimum because part is already paid.</span>}
            <div className="actions">
              <a className="btn ghost" href={`#/update/${card.id}`}>
                Update {card.name}
              </a>
            </div>
          </div>
        ))}
        {settled.map((c) => (
          <div key={c.id} className={`panel pay-tile ${hot ? "dim" : ""}`}>
            <div className="tile-head">
              <CardFace card={c} index={plan.cards.findIndex((x) => x.id === c.id)} zoom={0.36} />
              <div>
                <h2>{money(c.paid ?? 0)} paid</h2>
                <span className="big">done for this month</span>
                <span className="small muted">Nothing more is due before its next statement.</span>
              </div>
            </div>
            <dl className="kv">
              <dt>Balance today</dt>
              <dd>{money(c.balance)}</dd>
              <dt>APR</dt>
              <dd>{c.apr === null ? "Not entered" : `${c.apr}%`}</dd>
            </dl>
            <div className="actions">
              <a className="btn ghost" href={`#/update/${c.id}`}>
                Update {c.name}
              </a>
            </div>
          </div>
        ))}
      </section>
      <div className="actions">
        <a className="btn ghost" href="#/update">
          Mark a payment as paid
        </a>
        <a className="btn ghost" href="#/import">
          Update from a new statement
        </a>
      </div>

      <OrderChooser plan={plan} />
      {target && <WhyBox plan={plan} cardId={target.card.id} extra={target.p.extra} />}

      {f && (
        <>
          <section className="grid4">
            <Stat label="Last payment due, estimated" value={monthName(f.debt_free_month)} note={`${f.months} monthly payments`} />
            <Stat label="Estimated interest" value={money(f.total_interest)} note={`On ${money0(plan.total_debt)} owed today`} />
            <Stat label="Monthly budget" value={money(plan.budget)} note={`${money(plan.minimums_total)} minimums + ${money(plan.above_minimums)} extra`} />
            <a className="panel stat link whatif-cta" href="#/what-if">
              <span>What if I pay more?</span>
              <b>Try another budget</b>
              <span className="small">See your new last-payment month →</span>
            </a>
          </section>
          <p className="note">
            This forecast assumes no new purchases on these cards.{" "}
            Bought something? <a href="#/update">Update the card’s balance</a>
          </p>

          <BalanceChart plan={plan} canCompare={plan.comparison.filter((c) => c.strategy !== "minimum").length > 1} />
        </>
      )}

      <CreditHealth plan={plan} />
      <Missions plan={plan} />
      <Assumptions plan={plan} />
    </main>
  );
}

export function Schedule() {
  const { plan, inputs } = useStore();
  const [error, setError] = useState("");
  if (!plan || !inputs) return <main className="page muted">Calculating…</main>;
  if (plan.status === "limited" || plan.status === "pay_in_full") {
    // No forecast, but what the person confirmed is still a payment to make.
    const known = plan.card_status.filter((x) => x.amount !== null && x.kind !== "paid_off").sort((p, q) => (p.due ?? "9999").localeCompare(q.due ?? "9999"));
    return (
      <main className="page">
        <PageHead title="Payments you told us about">There is no forecast for these cards, so only the amounts and dates you confirmed are listed.</PageHead>
        <section className="panel stack tight">
          {known.map((x) => (
            <div key={x.card_id} className="pay-row">
              <b className="pay-date">{x.due ? dateLabel(x.due) : "Date not entered"}</b>
              <span>
                <b>{x.name}</b>
                <span className="small muted">{x.amount_label}</span>
              </span>
              <b>{money(x.amount ?? 0)}</b>
            </div>
          ))}
          {known.length === 0 && <p className="muted">No amounts are confirmed yet. Add the statement amount or the minimum on each card.</p>}
        </section>
        <a className="btn" href="#/plan">
          See what each card needs
        </a>
      </main>
    );
  }
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
        <PageHead title={rows.length === 1 ? "Next month" : `Next ${rows.length} months`}>
          {rows.reduce((s, m) => s + m.payments.length, 0)} payments · {money0(paid)} in total · balance {money0(plan.total_debt)} → {money0(last.total_balance)}
        </PageHead>
        <button type="button" className="btn ghost" onClick={() => downloadCalendar(inputs).catch(() => setError("We couldn’t create the calendar file. Please try again."))}>
          Add due dates to my calendar
        </button>
      </div>
      {error && <p className="note danger">{error}</p>}
      {plan.paid_this_cycle > 0 && (
        <p className="note">
          {money(plan.paid_this_cycle)} is already paid this month and is not listed again. {money(plan.left_this_cycle)} of this month’s {money(plan.budget)} is still to pay.
        </p>
      )}
      <DueCalendar plan={plan} />
      <Payday plan={plan} />
      <p className="muted">
        After these {rows.length} months you owe about {money0(plan.total_debt - last.total_balance)} less. About {money0(interest)} of the {money0(paid)} is interest. Balance changed?{" "}
        <a href="#/update">Update a card →</a>
      </p>
      <Fold title="How a month is counted">
        <p className="small muted">A month runs from today’s date to the same date next month, not from the 1st. Each card is paid once in it, on its due date. Dates and amounts are estimates.</p>
      </Fold>
    </main>
  );
}

const STRATEGY_NAME: Record<string, string> = { avalanche: "Highest APR first", snowball: "Smallest balance first", minimum: "Keep paying today’s minimums" };
