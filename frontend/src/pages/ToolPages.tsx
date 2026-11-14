import { useEffect, useState, type CSSProperties } from "react";
import { getCallScript, runScenario, type CallScript, type Card, type Plan, type ScenarioParams } from "../api";
import { dateLabel, money, money0, monthName } from "../format";
import { useStore } from "../store";
import { cardName, go, NumberField, PageHead, SplitBar, Stat } from "../ui";

/** Runs a scenario on the backend, debounced, and returns baseline + scenario. */
function useScenario(params: ScenarioParams | null) {
  const { inputs } = useStore();
  const [result, setResult] = useState<{ baseline: Plan; scenario: Plan } | null>(null);
  const [error, setError] = useState("");
  const key = JSON.stringify(params);
  useEffect(() => {
    if (!inputs || !params) {
      setResult(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      runScenario(inputs, params)
        .then((r) => {
          if (!stale) {
            setResult(r);
            setError("");
          }
        })
        .catch(() => {
          if (!stale) setError("Could not reach the FinPilot API. Start the backend on port 8000.");
        });
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs, key]);
  return { result, error };
}

function Difference({ base, alt }: { base: Plan; alt: Plan }) {
  if (alt.status === "shortfall") {
    return (
      <div className="note danger stack tight">
        <h2>{money(alt.shortfall)} short of the minimums</h2>
        <span>Minimum payments need {money(alt.minimums_total)} a month. No payoff plan or debt-free month is shown below that amount.</span>
      </div>
    );
  }
  if (!alt.forecast || !base.forecast) return <p className="note warn">No forecast for this scenario. Check that every card has an APR.</p>;
  const dm = alt.forecast.months - base.forecast.months;
  const di = alt.forecast.total_interest - base.forecast.total_interest;
  const target = alt.this_month.find((p) => p.extra > 0);
  return (
    <div className="grid3">
      <Stat
        label="Estimated debt-free month"
        value={monthName(alt.forecast.debt_free_month)}
        note={dm === 0 ? "Same month as your plan" : `${Math.abs(dm)} month${Math.abs(dm) === 1 ? "" : "s"} ${dm < 0 ? "sooner" : "later"}`}
        tone={dm < 0 ? "ok" : dm > 0 ? "warn" : undefined}
      />
      <Stat
        label="Estimated interest"
        value={money0(alt.forecast.total_interest)}
        note={Math.abs(di) < 0.5 ? "Same as your plan" : `${money0(Math.abs(di))} ${di < 0 ? "less" : "more"} than your plan`}
        tone={di < -0.5 ? "ok" : di > 0.5 ? "warn" : undefined}
      />
      <Stat label="Extra goes first to" value={target ? cardName(alt.cards, target.card_id) : "—"} note={alt.strategy === "avalanche" ? "Highest APR" : "Smallest balance"} />
    </div>
  );
}

function Payments({ plan }: { plan: Plan }) {
  const max = Math.max(1, ...plan.this_month.map((p) => p.total));
  return (
    <section className="panel stack">
      <h2>This month in the scenario</h2>
      {plan.this_month.map((p) => (
        <div key={p.card_id} className="track">
          <b>{cardName(plan.cards, p.card_id)}</b>
          <SplitBar payment={p} max={max} />
          <span>{money(p.total)}</span>
        </div>
      ))}
    </section>
  );
}

export function WhatIf() {
  const { inputs, plan, setInputs } = useStore();
  const [budget, setBudget] = useState(inputs?.budget ?? 0);
  const [once, setOnce] = useState(0);
  const [tight, setTight] = useState(false);
  const base = inputs?.budget ?? 0;
  const tightBudget = Math.max(plan?.minimums_total ?? 0, Math.round(base * 0.6));
  const { result, error } = useScenario(inputs ? { scenario_budget: budget, one_time: once, ...(tight ? { low_month_index: 2, low_month_budget: tightBudget } : {}) } : null);
  if (!inputs || !plan) return <main className="page muted">Calculating…</main>;
  const changed = budget !== base || once > 0 || tight;
  return (
    <main className="page">
      <PageHead title="What if" image="/img/fp-icon-arrows-cycle.jpg">
        Change a number and the whole schedule is recalculated on the spot. Nothing here changes your plan until you apply it.
      </PageHead>
      {error && <p className="note danger">{error}</p>}
      <div className="split wide-right">
        <section className="panel stack">
          <div className="slider">
            <div className="row">
              <label htmlFor="wi-budget">Monthly budget</label>
              <b className="big">{money(budget)}</b>
            </div>
            <input id="wi-budget" type="range" min={Math.max(50, Math.floor(plan.minimums_total / 10) * 10 - 50)} max={Math.max(1000, base * 2)} step={10} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
            <span className="small muted">
              Your plan uses {money(base)}. Minimums need {money(plan.minimums_total)}.
            </span>
          </div>
          <div className="slider">
            <div className="row">
              <label htmlFor="wi-once">One-time extra this month</label>
              <b className="big">{money(once)}</b>
            </div>
            <input id="wi-once" type="range" min={0} max={2000} step={50} value={once} onChange={(e) => setOnce(Number(e.target.value))} />
            <span className="small muted">A bonus, tax refund or gift. Goes where the extra goes.</span>
          </div>
          <label className="check">
            <input type="checkbox" checked={tight} onChange={(e) => setTight(e.target.checked)} />
            <span>
              <b>One tight month</b>
              <span className="small muted">Pay only {money(tightBudget)} next month, then return to the budget.</span>
            </span>
          </label>
          <div className="actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setBudget(base);
                setOnce(0);
                setTight(false);
              }}
            >
              Reset to my plan
            </button>
            <button type="button" className="btn" disabled={budget === base} onClick={() => setInputs({ ...inputs, budget })}>
              Use {money(budget)} as my budget
            </button>
          </div>
          <span className="small muted">A bank-confirmed lower APR is entered on the Bank call page.</span>
        </section>
        <section className="stack" aria-live="polite">
          {result ? (
            <>
              <Difference base={result.baseline} alt={result.scenario} />
              {result.scenario.status !== "shortfall" && <Payments plan={result.scenario} />}
              {!changed && <p className="muted">This is your current plan. Move a slider to compare.</p>}
            </>
          ) : (
            <p className="muted">Calculating…</p>
          )}
          <p className="small muted">Calculated by plain arithmetic, no AI. Same assumptions as the plan: no new purchases, minimums at today's amounts, interest estimated monthly.</p>
        </section>
      </div>
    </main>
  );
}

export function BankCall() {
  const { inputs, plan, setInputs } = useStore();
  const withApr = (plan?.cards ?? []).filter((c) => c.apr !== null && c.balance > 0).sort((a, b) => (b.apr ?? 0) - (a.apr ?? 0));
  const [cardId, setCardId] = useState<string | null>(null);
  const [script, setScript] = useState<CallScript | null>(null);
  const [scriptError, setScriptError] = useState("");
  const [newApr, setNewApr] = useState<number | null>(null);
  const card: Card | undefined = withApr.find((c) => c.id === cardId) ?? withApr[0];
  const planned = plan?.this_month.find((p) => p.card_id === card?.id)?.total ?? card?.minimum ?? 0;

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
        if (!stale) setScriptError("Could not reach the AI service. Start it on port 8001 to get the script.");
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id, card?.apr, card?.balance, planned]);

  const offerValid = card && newApr !== null && newApr >= 0 && newApr < (card.apr ?? 0);
  const { result } = useScenario(offerValid && card ? { apr_overrides: { [card.id]: newApr! } } : null);

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
        A ten-minute call to the number on the back of {card.name}. The bank may say no. If it says yes, enter the new rate below and your plan is recalculated.
      </PageHead>
      <div className="split">
        <section className="panel stack">
          <div className="row">
            <h2>What to say</h2>
            <div className="actions">
              {withApr.map((c) => (
                <button key={c.id} type="button" className={`btn ghost small ${c.id === card.id ? "on" : ""}`} aria-pressed={c.id === card.id} onClick={() => setCardId(c.id)}>
                  {c.name} · {c.apr}%
                </button>
              ))}
            </div>
          </div>
          {scriptError && <p className="note danger">{scriptError}</p>}
          {!script && !scriptError && <p className="muted">Preparing the script…</p>}
          {script?.lines.map((l) => (
            <div key={l.step} className="line">
              <span className="small muted">{l.label}</span>
              <p>{l.say}</p>
            </div>
          ))}
          {script && (
            <div className="actions">
              <button type="button" className="btn ghost" onClick={() => navigator.clipboard?.writeText(script.lines.map((l) => l.say).join("\n\n")).catch(() => undefined)}>
                Copy script
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
        {offerValid && result && result.scenario.forecast && result.baseline.forecast && (
          <>
            <Difference base={result.baseline} alt={result.scenario} />
            <div className="tbl">
              <table>
                <thead>
                  <tr>
                    <th>This month's payments</th>
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
                      <td className="r muted">{money(result.baseline.this_month.find((p) => p.card_id === c.id)?.total ?? 0)}</td>
                      <td className="r">
                        <b>{money(result.scenario.this_month.find((p) => p.card_id === c.id)?.total ?? 0)}</b>
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

// Card faces drawn in CSS to match the product renders: matte black, brushed titanium, deep indigo.
const FACES = [
  { face: "linear-gradient(145deg, #1d1e22 0%, #0b0b0d 70%)", edge: "#34363c", glow: "#6e7bf2" },
  { face: "linear-gradient(120deg, #4a4d55 0%, #2a2c31 45%, #55585f 70%, #26282c 100%)", edge: "#5c6068", glow: "#f0a050" },
  { face: "linear-gradient(145deg, #2a2f6e 0%, #12143a 75%)", edge: "#3f478f", glow: "#9aaaff" },
];
const FAN_ROW = 250; // vertical space one drawn card takes on the left

/** Cards sit in a fan like a hand of playing cards. Tapping one draws it to the left and opens its details. */
export function UpdateBalances() {
  const { inputs, plan, setInputs } = useStore();
  const [draft, setDraft] = useState<Card[]>(inputs?.cards ?? []);
  const [paid, setPaid] = useState<Record<string, boolean>>({});
  const [drawn, setDrawn] = useState<string[]>([]); // card ids, in the order they were tapped
  if (!inputs || !plan) return <main className="page muted">Calculating…</main>;

  const patch = (id: string, change: Partial<Card>) => setDraft(draft.map((c) => (c.id === id ? { ...c, ...change } : c)));
  const toggle = (id: string) => setDrawn(drawn.includes(id) ? drawn.filter((x) => x !== id) : [...drawn, id]);
  const original = (id: string) => inputs.cards.find((c) => c.id === id);
  const changed = draft.filter((c) => JSON.stringify(c) !== JSON.stringify(original(c.id))).length;
  const mid = (draft.length - 1) / 2;

  return (
    <main className="page">
      <PageHead title="Update your balances">
        Tap a card to draw it from the fan and enter what its new statement says. Tap it again to put it back. You can open several at once.
      </PageHead>

      <section className="fan" aria-label="Your cards" style={{ height: Math.max(drawn.length * FAN_ROW, 430) }}>
        {drawn.length === 0 && (
          <div className="panel stack tight fan-summary">
            <h2>
              {draft.length} card{draft.length === 1 ? "" : "s"}, {money(draft.reduce((sum, c) => sum + c.balance, 0))} owed
            </h2>
            <dl className="kv">
              <dt>Minimums this month</dt>
              <dd>{money(plan.minimums_total)}</dd>
              <dt>Planned this month</dt>
              <dd>{money(plan.this_month.reduce((sum, p) => sum + p.total, 0))}</dd>
              <dt>Payments marked as made</dt>
              <dd>
                {Object.values(paid).filter(Boolean).length} of {draft.length}
              </dd>
              <dt>Cards changed</dt>
              <dd>
                {changed} of {draft.length}
              </dd>
            </dl>
            <span className="small muted">Tap any card to open it here.</span>
          </div>
        )}

        {draft.flatMap((c, i) => {
          const slot = drawn.indexOf(c.id);
          const isDrawn = slot >= 0;
          const look = FACES[i % FACES.length];
          const planned = plan.this_month.find((p) => p.card_id === c.id);
          const estimate = plan.ninety_days[0]?.balances[c.id];
          const before = original(c.id);
          const diff = estimate !== undefined && before && c.balance !== before.balance ? c.balance - estimate : null;
          const place = {
            "--x": isDrawn ? "0px" : `calc(76% + ${(i - mid) * 96 - 88}px)`,
            "--y": `${isDrawn ? slot * FAN_ROW : 60 + Math.abs(i - mid) * 22}px`,
            "--r": `${isDrawn ? 0 : (i - mid) * 13}deg`,
            "--w": isDrawn ? "320px" : "176px",
            "--h": isDrawn ? "202px" : "278px",
            "--face": look.face,
            "--edge": look.edge,
            "--glow": look.glow,
            zIndex: isDrawn ? 10 : i + 1,
          } as CSSProperties;
          const card = (
            <button
              key={c.id}
              type="button"
              className={isDrawn ? "fan-card drawn" : "fan-card"}
              style={place}
              aria-pressed={isDrawn}
              aria-label={isDrawn ? `Put ${c.name} back in the fan` : `Open ${c.name}`}
              onClick={() => toggle(c.id)}
            >
              <span className="fan-top">
                <b>{c.name}</b>
                <span>{c.apr === null ? "APR not entered" : `${c.apr}% APR`}</span>
              </span>
              <span className="fan-chip" aria-hidden="true" />
              <span className="fan-bottom">
                <span>Balance</span>
                <b>{money(c.balance)}</b>
                <span>{c.due_day ? `Due day ${c.due_day}` : "No due day"}</span>
              </span>
            </button>
          );
          if (!isDrawn) return [card];
          return [
            card,
            <div key={`${c.id}-info`} className="fan-info stack tight" style={{ "--y": `${slot * FAN_ROW}px` } as CSSProperties}>
              <span className="small muted">
                {planned ? `Planned: ${money(planned.total)}${planned.due ? ` by ${dateLabel(planned.due)}` : ""}` : "No payment planned"}
                {estimate !== undefined ? ` · estimated balance after ${money(estimate)}` : ""}
              </span>
              <div className="fields">
                <NumberField
                  id={`${c.id}-ubal`}
                  label="Statement balance ($)"
                  value={c.balance}
                  onChange={(v) => patch(c.id, { balance: v ?? 0 })}
                  hint={diff === null ? undefined : Math.abs(diff) < 0.005 ? "Matches the estimate" : `${money(Math.abs(diff))} ${diff > 0 ? "above" : "below"} the estimate`}
                />
                <NumberField id={`${c.id}-umin`} label="Minimum due ($)" value={c.minimum} onChange={(v) => patch(c.id, { minimum: v ?? 0 })} />
                <NumberField id={`${c.id}-udue`} label="Due day" value={c.due_day} onChange={(v) => patch(c.id, { due_day: v })} step="1" max={31} />
              </div>
              <label className="check">
                <input type="checkbox" checked={!!paid[c.id]} onChange={(e) => setPaid({ ...paid, [c.id]: e.target.checked })} />
                <span>I made this payment</span>
              </label>
            </div>,
          ];
        })}
      </section>

      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={changed === 0}
          onClick={() => {
            setInputs({ ...inputs, cards: draft });
            go("plan");
          }}
        >
          Recalculate my plan
        </button>
        <span className="small muted">
          {changed} of {draft.length} cards changed. Marking a payment here does not send money and is not confirmed by your bank.
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
      <PageHead title="Your data">FinPilot works from what you type. There is no account, and nothing is sent to a bank or a credit bureau.</PageHead>
      <section className="cols3">
        <div className="col">
          <h2>What you enter</h2>
          <ul className="muted list">
            <li>Card nicknames</li>
            <li>Balances, APRs and minimums</li>
            <li>Due days and limits</li>
            <li>Monthly budget and goal</li>
          </ul>
        </div>
        <div className="col">
          <h2>Where it goes</h2>
          <ul className="muted list">
            <li>Sent to the FinPilot server only to calculate, not stored there</li>
            <li>Kept in this browser only if you turn saving on</li>
            <li>Not shared with banks, bureaus or advertisers</li>
          </ul>
        </div>
        <div className="col">
          <h2>What we never ask</h2>
          <ul className="muted list">
            <li>Name, email or sign-up</li>
            <li>Social Security number</li>
            <li>Full card numbers</li>
            <li>Bank login or password</li>
          </ul>
        </div>
      </section>
      <div className="grid2">
        <section className="panel stack tight">
          <label className="check">
            <input type="checkbox" checked={saveOnDevice} disabled={isDemo} onChange={(e) => setSaveOnDevice(e.target.checked)} />
            <span>
              <b>Save my plan on this device</b>
              <span className="small muted">Off by default. When off, your numbers disappear when you close the tab.</span>
            </span>
          </label>
          {isDemo && <p className="small muted">The demo example is never saved.</p>}
          <p className="note warn">On a shared or public computer, leave this off. Anyone who opens this browser could see your balances.</p>
        </section>
        <section className="panel stack tight">
          <h2>Delete everything</h2>
          <p className="muted">Removes all cards and the budget from this browser. This cannot be undone. There is no copy anywhere else.</p>
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
