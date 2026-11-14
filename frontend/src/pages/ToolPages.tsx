import { useEffect, useState, type CSSProperties } from "react";
import { getCallScript, runScenario, type CallScript, type Card, type Plan, type ScenarioParams } from "../api";
import { dateLabel, money, money0, monthName } from "../format";
import { useStore } from "../store";
import { cardName, go, NumberField, PageHead, SplitBar, Stat } from "../ui";

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
  if (!alt.forecast || !base.forecast) return <p className="note warn">There is no forecast for this preview. Check that every card has an APR.</p>;
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

/** Preview another monthly budget against the current plan, then apply it. Only the budget can be changed here. */
export function WhatIf() {
  const { inputs, plan, setInputs } = useStore();
  const base = inputs?.budget ?? 0;
  const [budget, setBudget] = useState(base);
  const { result, pending, failed, retry } = useScenario(inputs ? { scenario_budget: budget } : null);
  if (!inputs || !plan) return <main className="page muted">Calculating…</main>;
  const changed = budget !== base;
  const fresh = result && !pending && !failed && result.scenario.budget === budget ? result : null;
  const low = Math.max(10, Math.floor(plan.minimums_total / 10) * 10 - 50);
  return (
    <main className="page">
      <PageHead title="What if" image="/img/fp-icon-arrows-cycle.jpg">
        Preview a different monthly budget next to your current plan. Nothing changes until you apply it.
      </PageHead>
      <div className="split wide-right">
        <section className="panel stack">
          <span className="pill">Your current plan · {money(base)} a month</span>
          <div className="slider">
            <div className="row">
              <label htmlFor="wi-budget">Preview a monthly budget of</label>
              <b className="big">{money(budget)}</b>
            </div>
            <input id="wi-budget" type="range" min={low} max={Math.max(1000, base * 2)} step={10} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
            <span className="small muted">
              Your minimum payments need {money(plan.minimums_total)} of it.
            </span>
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={!changed || !fresh || fresh.scenario.status === "shortfall"}
              onClick={() => {
                setInputs({ ...inputs, budget });
                go("plan");
              }}
            >
              Apply monthly budget
            </button>
            <button type="button" className="btn ghost" disabled={!changed} onClick={() => setBudget(base)}>
              Back to {money(base)}
            </button>
          </div>
          <p className="small muted">Applying {money(budget)} updates your plan, schedule, forecast and credit limit use from one new calculation.</p>
          <p className="small muted">
            Why the result changes: minimums are covered first, and every dollar above them goes to {plan.strategy === "avalanche" ? "the card with the highest APR" : "the card with the smallest balance"}. A larger
            budget means more goes there each cycle.
          </p>
        </section>

        <section className="stack" aria-live="polite" aria-busy={pending}>
          <span className={changed ? "pill accent" : "pill"}>{changed ? `Preview · ${money(budget)} a month · not applied` : "This is your current plan"}</span>
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
              <Difference base={fresh.baseline} alt={fresh.scenario} />
              {fresh.scenario.status !== "shortfall" && <Payments plan={fresh.scenario} title={changed ? "This payment cycle with the previewed budget" : "This payment cycle"} />}
            </>
          )}
          <p className="small muted">Calculated by plain arithmetic, no AI, under the same assumptions as the plan: no new purchases, minimums at today’s amounts, interest estimated once per cycle.</p>
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

// Card faces drawn in CSS to match the product renders: matte black, brushed titanium, deep indigo.
const FACES = [
  { face: "linear-gradient(145deg, #26272c 0%, #0b0b0d 62%, #17181c 100%)", edge: "#3a3d44", glow: "#6e7bf2" },
  { face: "linear-gradient(120deg, #5a5e67 0%, #2a2c31 42%, #6a6e77 68%, #26282c 100%)", edge: "#6c7079", glow: "#f0a050" },
  { face: "linear-gradient(145deg, #3a41a0 0%, #12143a 68%, #232869 100%)", edge: "#4a54a8", glow: "#9aaaff" },
];
const FAN_HEAD = 400; // height of the heading area the fan sits behind
const FAN_ROW = 240; // vertical space one drawn card takes below it
const CARD_W = 190; // the card never changes size: portrait in the fan, turned a quarter when drawn
const CARD_H = 300;

/**
 * Cards sit in a fan behind the heading, like a hand of playing cards. Each is a real two-sided
 * card: tapping one moves it to a row below while it turns a quarter and flips over, showing a back
 * that is printed landscape. The card never changes shape and its text never moves.
 */
export function UpdateBalances() {
  const { inputs, plan, setInputs } = useStore();
  const [draft, setDraft] = useState<Card[]>(inputs?.cards ?? []);
  const [paid, setPaid] = useState<Record<string, boolean>>({});
  const [drawn, setDrawn] = useState<string[]>([]); // card ids, in the order they were tapped
  const [moved, setMoved] = useState<string[]>([]); // cards that have been tapped at least once: only these animate
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

  return (
    <main className="page">
      <section className="fan" aria-label="Your cards" style={{ height: FAN_HEAD + Math.max(drawn.length * FAN_ROW, 300) }}>
        <div className="fan-head">
          <h1>Update your balances</h1>
          <p className="lede">Tap a card to draw it from the fan and enter what its new statement says. Tap it again to put it back. You can open several at once.</p>
        </div>

        {drawn.length === 0 && (
          <div className="panel stack tight fan-summary">
            <h2>
              {draft.length} card{draft.length === 1 ? "" : "s"}, {money(draft.reduce((sum, c) => sum + c.balance, 0))} owed
            </h2>
            <dl className="kv">
              <dt>Minimums this payment cycle</dt>
              <dd>{money(plan.minimums_total)}</dd>
              <dt>Planned this payment cycle</dt>
              <dd>{money(plan.this_cycle.reduce((sum, p) => sum + p.total, 0))}</dd>
              <dt>Payments marked as made</dt>
              <dd>
                {Object.values(paid).filter(Boolean).length} of {draft.length}
              </dd>
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
                    <span>Statement balance</span>
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
          return [
            card,
            <div key={`${c.id}-info`} className="fan-info stack tight" style={{ "--dy": `${FAN_HEAD + slot * FAN_ROW}px` } as CSSProperties}>
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
