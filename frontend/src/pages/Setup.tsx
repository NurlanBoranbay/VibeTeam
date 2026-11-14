import { useEffect, useState } from "react";
import type { Card, Goal, Inputs, Treatment } from "../api";
import { money } from "../format";
import { newCard, useStore } from "../store";
import { CardFace, go, Help, NumberField } from "../ui";

const STEPS = ["Goal", "Budget", "Cards", "Review"];
const GOALS: { id: Goal; title: string; text: string }[] = [
  { id: "less_interest", title: "Pay less interest", text: "Extra money goes to the highest APR first. Shows interest saved up front." },
  { id: "faster_payoff", title: "Pay cards off faster", text: "Shows the estimated debt-free month first and what would move it closer." },
  { id: "future_loan", title: "Get ready for a future loan", text: "Adds how much of each credit limit is in use, next to the payoff plan." },
  { id: "tight_budget", title: "Make a tight budget work", text: "Starts by checking that every minimum is covered, then places what is left." },
];
const MAX_CARDS = 3;
const TREATMENTS: { id: Treatment; label: string }[] = [
  { id: "revolving", label: "I carry a balance and pay regular purchase interest." },
  { id: "pay_in_full", label: "I normally pay my statement in full." },
  { id: "promo", label: "I have a promotional or special financing offer." },
  { id: "unsure", label: "I’m not sure." },
];
const TREATMENT_SHORT: Record<string, string> = { revolving: "Carries a balance", pay_in_full: "Paid in full", promo: "Promotional offer", unsure: "Not sure" };

const blank = (): Inputs => ({ goal: "less_interest", budget: 0, strategy: "avalanche", cards: [newCard(0)] });

function problems(step: number, d: Inputs, entered: string[]): string {
  if (step === 2 && !(d.budget > 0)) return "Enter the monthly amount you can put toward your cards.";
  if (step === 3) {
    if (!d.cards.length) return "Add at least one card.";
    for (const c of d.cards) {
      if (!c.name.trim()) return "Give every card a nickname.";
      // A paid-off card stays in the plan at $0 with no minimum. An empty balance is not a zero.
      if (!entered.includes(c.id)) return `Enter the current balance for ${c.name}. Use 0 if it is paid off.`;
      if (c.balance < 0) return `${c.name} cannot have a balance below $0.`;
      if (!c.treatment) return `Choose what best describes ${c.name}.`;
      if (c.treatment === "pay_in_full" && c.balance > 0 && !c.grace) return `Answer the question about paying ${c.name} in full.`;
      if (c.treatment === "promo" && c.balance > 0 && !c.promo_kind) return `Choose which offer ${c.name} has.`;
      // an empty minimum is not a zero: $0 is accepted only when the person says nothing more is due
      if (c.treatment === "revolving" && c.balance > 0 && !(c.minimum > 0) && !c.min_paid) return `${c.name} has a balance, so enter the minimum still due, or tick that it is already paid.`;
      if (c.apr !== null && c.apr > 100) return `${c.name} has an APR above 100%. Check the statement.`;
      if (c.due_day !== null && (c.due_day < 1 || c.due_day > 31)) return `${c.name} needs a due day between 1 and 31.`;
    }
  }
  return "";
}

export default function Setup({ step }: { step: number }) {
  const { inputs, isDemo, setInputs, prefill, setPrefill } = useStore();
  // Imported cards replace the card list but keep an existing goal and budget.
  const [draft, setDraft] = useState<Inputs>(() => {
    const base = inputs && !isDemo ? inputs : blank();
    return prefill ? { ...base, cards: prefill } : base;
  });
  const [imported] = useState(prefill !== null);
  useEffect(() => {
    if (prefill) setPrefill(null); // used once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [error, setError] = useState("");
  // cards whose balance was typed (or came from the plan or an import); a new card starts empty, not at $0
  const [entered, setEntered] = useState<string[]>(() => draft.cards.filter((c) => imported || (inputs && !isDemo)).map((c) => c.id));

  const patch = (p: Partial<Inputs>) => setDraft({ ...draft, ...p });
  const patchCard = (id: string, p: Partial<Card>) => patch({ cards: draft.cards.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  const minimums = draft.cards.reduce((s, c) => s + Math.min(c.minimum, c.balance), 0);
  const debt = draft.cards.reduce((s, c) => s + c.balance, 0);
  const gap = minimums - draft.budget;

  function next() {
    const e = problems(step, draft, entered);
    setError(e);
    if (e) return;
    if (step < 4) return go(`setup/${step + 1}`);
    setInputs({ ...draft, first_month_budget: null });
    go("plan");
  }

  return (
    <main className="page">
      <nav className="steps" aria-label="Setup steps">
        {STEPS.map((s, i) => (
          <a key={s} href={`#/setup/${i + 1}`} className={i + 1 <= step ? "on" : ""} aria-current={i + 1 === step ? "step" : undefined}>
            <span className="small muted">Step {i + 1}</span> {s}
          </a>
        ))}
      </nav>

      <div className="split">
        {/* keyed by step so each step opens with the page transition while the draft is kept */}
        <section className="stack page-in" key={step}>
          {step === 1 && (
            <>
              <h1>What’s your goal?</h1>
              <p className="lede">Pick one. You can switch later.</p>
              <div className="stack tight goals" role="radiogroup" aria-label="Goal">
                {GOALS.map((g) => (
                  <label key={g.id} className={`choice ${draft.goal === g.id ? "on" : ""}`}>
                    <input type="radio" name="goal" checked={draft.goal === g.id} onChange={() => patch({ goal: g.id })} />
                    <span>
                      <b>{g.title}</b>
                      <span className="muted">{g.text}</span>
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h1>How much can you pay each month?</h1>
              <p className="lede">One number for all your cards together, minimum payments included.</p>
              <div style={{ maxWidth: 340 }}>
                <NumberField
                  id="budget"
                  label="Total for all cards, per month ($)"
                  value={draft.budget || null}
                  onChange={(v) => patch({ budget: v ?? 0 })}
                  step="10"
                  placeholder="500"
                  help="Not your salary. It is what is left for card payments after rent, food and bills. It already includes the minimum payments, so do not add them on top."
                />
              </div>
              <div className="sum-example" aria-label="Example">
                <span>
                  <b>$130</b>
                  <small>minimums</small>
                </span>
                <i>+</i>
                <span>
                  <b>$370</b>
                  <small>extra you can add</small>
                </span>
                <i>=</i>
                <span className="sum-total">
                  <b>$500</b>
                  <small>enter this</small>
                </span>
              </div>
              <p className="muted">Pick an amount you can repeat every month.</p>
            </>
          )}

          {step === 3 && (
            <>
              <h1>Add your cards</h1>
              <p className="lede">A nickname is enough. Never a card number. The forecast assumes no new purchases.</p>
              {imported ? (
                <p className="note warn">These cards were filled in from your import. Check each number against your statement and add anything that is missing.</p>
              ) : (
                <p className="muted">
                  Rather not type? <a href="#/import">Import from Excel, CSV or a statement.</a>
                </p>
              )}
              {draft.cards.map((c, ci) => (
                <div key={c.id} className="panel stack tight">
                  <div className="row">
                    <h2>{c.name || "Card"}</h2>
                    <button type="button" className="btn ghost small" onClick={() => patch({ cards: draft.cards.filter((x) => x.id !== c.id) })}>
                      Remove
                    </button>
                  </div>
                  <fieldset className="treat">
                    <legend>Is this balance being charged interest right now? Pick what fits best.</legend>
                    {TREATMENTS.map((t) => (
                      <label key={t.id} className={c.treatment === t.id ? "treat-opt on" : "treat-opt"}>
                        <input type="radio" name={`${c.id}-treat`} checked={c.treatment === t.id} onChange={() => patchCard(c.id, { treatment: t.id })} />
                        <span>{t.label}</span>
                      </label>
                    ))}
                  </fieldset>
                  {c.treatment === "pay_in_full" && (
                    <div className="follow">
                      <div className="field">
                        <label htmlFor={`${c.id}-grace`}>Have you paid your recent statements in full and on time, and does this card have a grace period on purchases?</label>
                        <select id={`${c.id}-grace`} value={c.grace ?? ""} onChange={(e) => patchCard(c.id, { grace: (e.target.value || null) as Card["grace"] })}>
                          <option value="">Choose…</option>
                          <option value="yes">Yes</option>
                          <option value="no">No</option>
                          <option value="unsure">Not sure</option>
                        </select>
                      </div>
                      <label className="check">
                        <input type="checkbox" checked={c.can_pay_full === false} onChange={(e) => patchCard(c.id, { can_pay_full: !e.target.checked })} />
                        <span>I can’t pay the full statement amount this time</span>
                      </label>
                    </div>
                  )}
                  {c.treatment === "promo" && (
                    <div className="follow fields">
                      <div className="field">
                        <label htmlFor={`${c.id}-promo`}>Which offer is it?</label>
                        <select id={`${c.id}-promo`} value={c.promo_kind ?? ""} onChange={(e) => patchCard(c.id, { promo_kind: (e.target.value || null) as Card["promo_kind"] })}>
                          <option value="">Choose…</option>
                          <option value="intro_zero">0% introductory APR</option>
                          <option value="deferred">No interest if paid in full by a deadline</option>
                          <option value="transfer">A balance transfer or another special arrangement</option>
                          <option value="unsure">Not sure</option>
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor={`${c.id}-pend`}>When does the offer end?</label>
                        <input id={`${c.id}-pend`} type="date" value={c.promo_end ?? ""} onChange={(e) => patchCard(c.id, { promo_end: e.target.value || null })} />
                      </div>
                    </div>
                  )}
                  {c.treatment === "revolving" && (
                    <div className="follow">
                      <label className="check">
                        <input type="checkbox" checked={!!c.mixed} onChange={(e) => patchCard(c.id, { mixed: e.target.checked })} />
                        <span>This balance includes a cash advance, a balance transfer, a deferred-interest purchase or an installment plan</span>
                      </label>
                      <label className="check">
                        <input type="checkbox" checked={!!c.min_paid} onChange={(e) => patchCard(c.id, { min_paid: e.target.checked })} />
                        <span>I already paid the minimum for the upcoming due date</span>
                      </label>
                    </div>
                  )}
                  {c.treatment && (
                    <label className="check follow">
                      <input type="checkbox" checked={!!c.past_due} onChange={(e) => patchCard(c.id, { past_due: e.target.checked })} />
                      <span>A payment on this card is overdue, or it is under a hardship or special repayment arrangement</span>
                    </label>
                  )}
                  {c.treatment && c.treatment !== "revolving" && <p className="note warn">This card will be shown with what you need to pay or check, but it will not get an interest forecast.</p>}
                  <div className="card-form">
                  <div className="fields">
                    <div className="field">
                      <span className="field-label">
                        <label htmlFor={`${c.id}-name`}>Nickname</label>
                        <Help text="Any name you will recognise, like Chase or Travel card. Never the card number." />
                      </span>
                      <input id={`${c.id}-name`} maxLength={40} value={c.name} onChange={(e) => patchCard(c.id, { name: e.target.value })} />
                    </div>
                    <NumberField
                      id={`${c.id}-bal`}
                      label="Current balance ($)"
                      value={entered.includes(c.id) ? c.balance : null}
                      onChange={(v) => {
                        patchCard(c.id, { balance: v ?? 0 });
                        setEntered(v === null ? entered.filter((x) => x !== c.id) : entered.includes(c.id) ? entered : [...entered, c.id]);
                      }}
                      help="What you owe on this card today, as shown in your banking app. Use 0 for a paid-off card."
                    />
                    {c.treatment !== "pay_in_full" && (
                      <NumberField id={`${c.id}-apr`} label="Purchase APR (%)" value={c.apr} onChange={(v) => patchCard(c.id, { apr: v })} help="The yearly interest rate on purchases. On your statement it is under Interest Charge Calculation. Leave empty if you do not know it; you will get payments but no interest forecast." max={100} />
                    )}
                    {c.treatment === "pay_in_full" ? (
                      <NumberField id={`${c.id}-stmt`} label="Statement amount still to pay ($)" value={c.statement_due ?? null} onChange={(v) => patchCard(c.id, { statement_due: v })} help="The amount your issuer says is still needed for your latest statement. It is not the current balance, which can include newer purchases. Leave empty if you are not sure." />
                    ) : (
                      <NumberField id={`${c.id}-min`} label="Minimum still due ($)" value={c.minimum || null} onChange={(v) => patchCard(c.id, { minimum: v ?? 0 })} help="The minimum the issuer still needs for the upcoming due date. Use the figure on your latest statement or in the app." />
                    )}
                    <div className="field">
                      <span className="field-label">
                        <label htmlFor={`${c.id}-due`}>Next payment due date</label>
                        <Help text="The actual next due date shown by your issuer. Later due dates are estimated from its day of the month." />
                      </span>
                      <input id={`${c.id}-due`} type="date" value={c.next_due ?? ""} onChange={(e) => patchCard(c.id, { next_due: e.target.value || null, due_day: e.target.value ? Number(e.target.value.slice(8, 10)) : null })} />
                    </div>
                    <NumberField id={`${c.id}-lim`} label="Credit limit ($, optional)" value={c.limit} onChange={(v) => patchCard(c.id, { limit: v })} step="100" help="The most you can borrow on this card. Optional; it is only used to show credit usage." />
                  </div>
                  <CardFace card={c} index={ci} zoom={0.62} />
                  </div>
                  {c.treatment === "revolving" && c.apr === null && <p className="note warn">No APR: you get payments, but no interest forecast or debt-free month.</p>}
                </div>
              ))}
              <div className="actions">
                <button type="button" className="btn ghost" disabled={draft.cards.length >= MAX_CARDS} onClick={() => patch({ cards: [...draft.cards, newCard(draft.cards.length)] })}>
                  Add another card
                </button>
                <span className="small muted">This version plans up to three cards.</span>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <h1>Everything right?</h1>
              <p className="lede">One last look before we do the math.</p>
              <div className="review">
                {draft.cards.map((c, ci) => (
                  <a key={c.id} className="panel review-card" href="#/setup/3">
                    <CardFace card={c} index={ci} zoom={0.42} />
                    <dl className="facts">
                      <div>
                        <dt>Type</dt>
                        <dd className={c.treatment === "revolving" ? "" : "warn"}>{TREATMENT_SHORT[c.treatment ?? "unsure"]}</dd>
                      </div>
                      <div>
                        <dt>Balance</dt>
                        <dd>{money(c.balance)}</dd>
                      </div>
                      {c.treatment === "pay_in_full" ? (
                        <div>
                          <dt>Statement to pay</dt>
                          <dd className={c.statement_due === null || c.statement_due === undefined ? "warn" : ""}>{c.statement_due === null || c.statement_due === undefined ? "Not entered" : money(c.statement_due)}</dd>
                        </div>
                      ) : (
                        <>
                          <div>
                            <dt>APR</dt>
                            <dd className={c.apr === null ? "warn" : ""}>{c.apr === null ? "Missing" : `${c.apr}%`}</dd>
                          </div>
                          <div>
                            <dt>Minimum due</dt>
                            <dd>{c.min_paid ? "Already paid" : money(c.minimum)}</dd>
                          </div>
                        </>
                      )}
                      <div>
                        <dt>Next due date</dt>
                        <dd className={c.next_due || c.due_day ? "" : "warn"}>{c.next_due ?? (c.due_day ? `Day ${c.due_day}` : "Not entered")}</dd>
                      </div>
                      <div>
                        <dt>Limit</dt>
                        <dd>{c.limit === null ? "—" : money(c.limit)}</dd>
                      </div>
                    </dl>
                  </a>
                ))}
              </div>
              {gap > 0 && (
                <p className="note danger">
                  Your budget is {money(gap)} short of the minimums. We will show what to do next.
                </p>
              )}
            </>
          )}

          <p className="error" role="alert">
            {error}
          </p>
          <div className="actions">
            {step > 1 && (
              <a className="btn ghost" href={`#/setup/${step - 1}`}>
                Back
              </a>
            )}
            <button type="button" className="btn" onClick={next}>
              {step === 4 ? "Calculate my plan" : "Continue"}
            </button>
          </div>
        </section>

        <aside className="panel stack tight">
          <h2>So far</h2>
          <dl className="kv">
            <dt>Cards</dt>
            <dd>{draft.cards.length}</dd>
            <dt>Total owed</dt>
            <dd>{money(debt)}</dd>
            <dt>Minimums</dt>
            <dd>{money(minimums)}</dd>
            <dt>Monthly budget</dt>
            <dd>{draft.budget ? money(draft.budget) : "—"}</dd>
            <dt>
              <b>Above minimums</b>
            </dt>
            <dd className={gap > 0 ? "danger" : "ok"}>
              <b>{draft.budget ? (gap > 0 ? `−${money(gap)}` : money(-gap)) : "—"}</b>
            </dd>
          </dl>
          <p className="small muted">Nothing is saved unless you turn saving on.</p>
        </aside>
      </div>
    </main>
  );
}
