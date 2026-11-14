import { useEffect, useState } from "react";
import { calculatePlan, getCallScript, type CallScript, type CardIn, type Plan } from "./api";

// Demo example from the product brief: three cards, $500 a month.
const DEMO_CARDS: CardIn[] = [
  { id: "a", name: "Card A", balance: 1500, minimum: 40, apr: 29, due_day: 22, limit: 3000 },
  { id: "b", name: "Card B", balance: 2500, minimum: 60, apr: 24, due_day: 28, limit: 5000 },
  { id: "c", name: "Card C", balance: 600, minimum: 30, apr: 19, due_day: 5 },
];

const money = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: v % 1 ? 2 : 0 });
const monthName = (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleString("en-US", { month: "long", year: "numeric" });

export default function App() {
  const [budget, setBudget] = useState(500);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [script, setScript] = useState<CallScript | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let stale = false;
    calculatePlan({ budget, strategy: "avalanche", cards: DEMO_CARDS })
      .then((p) => !stale && (setPlan(p), setError("")))
      .catch(() => !stale && setError("Could not reach the FinPilot API. Start the backend on port 8000 and reload."));
    return () => {
      stale = true;
    };
  }, [budget]);

  const cardName = (id: string) => DEMO_CARDS.find((c) => c.id === id)?.name ?? id;
  const first = plan?.this_month[0];

  async function loadScript() {
    if (!first) return;
    try {
      setScript(await getCallScript(DEMO_CARDS[0], first.total));
    } catch {
      setError("Could not reach the AI service. Start it on port 8001 and try again.");
    }
  }

  return (
    <>
      <header className="top">
        <span className="logo">
          <i>F</i>FinPilot
        </span>
        <span className="pill">Demo example</span>
      </header>
      <main className="page">
        {error && <p className="note danger">{error}</p>}
        {plan?.status === "shortfall" && (
          <section>
            <h1>{money(plan.shortfall)} short of your minimum payments</h1>
            <p className="lede">
              Your cards need {money(plan.minimums_total)} a month and your budget is {money(plan.budget)}. No payoff plan is shown until the minimums are
              covered.
            </p>
          </section>
        )}
        {plan?.status === "ok" && first && (
          <section>
            <span className="muted">Next payment</span>
            <h1>
              Pay {money(first.total)} to {cardName(first.card_id)}
            </h1>
            <div className="columns">
              {plan.this_month.map((p) => (
                <div key={p.card_id} className="col">
                  <h2>{cardName(p.card_id)}</h2>
                  <strong>{money(p.total)}</strong>
                  <span className="muted">
                    {money(p.minimum)} minimum{p.extra > 0 ? ` + ${money(p.extra)} extra` : " only"}
                  </span>
                </div>
              ))}
            </div>
            <div className="stats">
              <div className="card">
                <span className="muted">Estimated debt-free month</span>
                <b>{monthName(plan.forecast!.debt_free_month)}</b>
              </div>
              <div className="card">
                <span className="muted">Estimated interest</span>
                <b>{money(Math.round(plan.forecast!.total_interest))}</b>
              </div>
              <div className="card">
                <span className="muted">Above minimums</span>
                <b>{money(plan.above_minimums)}</b>
              </div>
            </div>
          </section>
        )}

        <section className="card">
          <label htmlFor="budget">
            Monthly budget for all cards: <b>{money(budget)}</b>
          </label>
          <input id="budget" type="range" min={100} max={1000} step={10} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
          <span className="muted">Move it to see the plan recalculated by the backend.</span>
        </section>

        <section className="card">
          <h2>Bank call script</h2>
          {!script && (
            <button type="button" onClick={loadScript} disabled={!first}>
              Prepare the call for Card A
            </button>
          )}
          {script && (
            <>
              {script.lines.map((l) => (
                <p key={l.step}>
                  <span className="muted">{l.label}</span>
                  <br />
                  {l.say}
                </p>
              ))}
              <p className="muted">
                {script.source === "ai" ? "Worded by AI from your plan's figures." : "Standard wording."} {script.disclaimer}
              </p>
            </>
          )}
        </section>

        {plan && (
          <ul className="muted small">
            {plan.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
