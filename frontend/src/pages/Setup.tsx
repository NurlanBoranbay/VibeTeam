import { useState } from "react";
import type { Card, Goal, Inputs } from "../api";
import { money } from "../format";
import { newCard, useStore } from "../store";
import { go, NumberField } from "../ui";

const STEPS = ["Goal", "Budget", "Cards", "Review"];
const GOALS: { id: Goal; title: string; text: string }[] = [
  { id: "less_interest", title: "Pay less interest", text: "Extra money goes to the highest APR first. Shows interest saved up front." },
  { id: "faster_payoff", title: "Pay cards off faster", text: "Shows the estimated debt-free month first and what would move it closer." },
  { id: "future_loan", title: "Get ready for a future loan", text: "Adds how much of each credit limit is in use, next to the payoff plan." },
  { id: "tight_budget", title: "Make a tight budget work", text: "Starts by checking that every minimum is covered, then places what is left." },
];
const MAX_CARDS = 3;

const blank = (): Inputs => ({ goal: "less_interest", budget: 0, strategy: "avalanche", cards: [newCard(0)] });

function problems(step: number, d: Inputs): string {
  if (step === 2 && !(d.budget > 0)) return "Enter the monthly amount you can put toward your cards.";
  if (step === 3) {
    if (!d.cards.length) return "Add at least one card.";
    for (const c of d.cards) {
      if (!c.name.trim()) return "Give every card a nickname.";
      if (!(c.balance > 0)) return `${c.name} needs a balance above $0.`;
      if (!(c.minimum > 0)) return `${c.name} needs its minimum payment.`;
      if (c.apr !== null && c.apr > 100) return `${c.name} has an APR above 100%. Check the statement.`;
      if (c.due_day !== null && (c.due_day < 1 || c.due_day > 31)) return `${c.name} needs a due day between 1 and 31.`;
    }
  }
  return "";
}

export default function Setup({ step }: { step: number }) {
  const { inputs, isDemo, setInputs } = useStore();
  const [draft, setDraft] = useState<Inputs>(() => (inputs && !isDemo ? inputs : blank()));
  const [error, setError] = useState("");

  const patch = (p: Partial<Inputs>) => setDraft({ ...draft, ...p });
  const patchCard = (id: string, p: Partial<Card>) => patch({ cards: draft.cards.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  const minimums = draft.cards.reduce((s, c) => s + Math.min(c.minimum, c.balance), 0);
  const debt = draft.cards.reduce((s, c) => s + c.balance, 0);
  const gap = minimums - draft.budget;

  function next() {
    const e = problems(step, draft);
    setError(e);
    if (e) return;
    if (step < 4) return go(`setup/${step + 1}`);
    setInputs(draft);
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
              <h1>What do you want from this plan?</h1>
              <p className="lede">Pick the one that fits best. It changes what the plan puts first on screen. You can switch later.</p>
              <div className="stack tight" role="radiogroup" aria-label="Goal">
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
              <h1>How much can go to your cards each month?</h1>
              <p className="lede">One total for all cards, after necessary expenses and the cash reserve you want to keep. It already includes your minimum payments.</p>
              <div style={{ maxWidth: 320 }}>
                <NumberField id="budget" label="Monthly amount for all cards ($)" value={draft.budget || null} onChange={(v) => patch({ budget: v ?? 0 })} step="10" placeholder="500" />
              </div>
              <p className="muted">Pick a number you can repeat every month. A lower amount you keep up beats a higher one you miss.</p>
            </>
          )}

          {step === 3 && (
            <>
              <h1>Add your credit cards</h1>
              <p className="lede">A nickname is enough. Never enter a card number. Balance and minimum are required; the APR is needed for an interest forecast.</p>
              {draft.cards.map((c) => (
                <div key={c.id} className="panel stack tight">
                  <div className="row">
                    <h2>{c.name || "Card"}</h2>
                    <button type="button" className="btn ghost small" onClick={() => patch({ cards: draft.cards.filter((x) => x.id !== c.id) })}>
                      Remove
                    </button>
                  </div>
                  <div className="fields">
                    <div className="field">
                      <label htmlFor={`${c.id}-name`}>Nickname</label>
                      <input id={`${c.id}-name`} maxLength={40} value={c.name} onChange={(e) => patchCard(c.id, { name: e.target.value })} />
                    </div>
                    <NumberField id={`${c.id}-bal`} label="Current balance ($)" value={c.balance || null} onChange={(v) => patchCard(c.id, { balance: v ?? 0 })} hint="App home screen, &quot;Current balance&quot;." />
                    <NumberField id={`${c.id}-apr`} label="Purchase APR (%)" value={c.apr} onChange={(v) => patchCard(c.id, { apr: v })} hint="Statement, &quot;Interest Charge Calculation&quot;. Leave empty if unknown." max={100} />
                    <NumberField id={`${c.id}-min`} label="Minimum payment due ($)" value={c.minimum || null} onChange={(v) => patchCard(c.id, { minimum: v ?? 0 })} hint="Statement summary." />
                    <NumberField id={`${c.id}-due`} label="Due day of month" value={c.due_day} onChange={(v) => patchCard(c.id, { due_day: v })} step="1" max={31} hint="1 to 31." />
                    <NumberField id={`${c.id}-lim`} label="Credit limit ($, optional)" value={c.limit} onChange={(v) => patchCard(c.id, { limit: v })} step="100" hint="Only for the credit use page." />
                  </div>
                  {c.apr === null && <p className="note warn">Without the APR, FinPilot can still split your payment but will not show an interest forecast or a debt-free month.</p>}
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
              <h1>Check the numbers before we calculate</h1>
              <p className="lede">The plan is only as good as these inputs. Go back to fix anything that looks off.</p>
              <div className="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Card</th>
                      <th className="r">Balance</th>
                      <th className="r">APR</th>
                      <th className="r">Minimum</th>
                      <th className="r">Due day</th>
                      <th className="r">Limit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.cards.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <b>{c.name}</b>
                        </td>
                        <td className="r">{money(c.balance)}</td>
                        <td className={`r ${c.apr === null ? "warn" : ""}`}>{c.apr === null ? "Not entered" : `${c.apr}%`}</td>
                        <td className="r">{money(c.minimum)}</td>
                        <td className="r">{c.due_day ?? "—"}</td>
                        <td className={`r ${c.limit === null ? "muted" : ""}`}>{c.limit === null ? "Not entered" : money(c.limit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {gap > 0 && (
                <p className="note danger">
                  Your budget is {money(gap)} short of the minimum payments. You will see what to do next instead of a payoff plan.
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
          <p className="small muted">Calculated on our server from these numbers only. Nothing is saved unless you turn saving on.</p>
        </aside>
      </div>
    </main>
  );
}
