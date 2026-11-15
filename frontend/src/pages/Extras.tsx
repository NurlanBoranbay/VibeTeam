import { useEffect, useState } from "react";
import { aiStatus, ApiProblem, askAssistant, extractStatement, type ImportedCard, type Inputs } from "../api";
import { money } from "../format";
import { useStore } from "../store";
import { Fold, go, PageHead } from "../ui";

// ---------------------------------------------------------------- assistant

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** what the assistant did in this turn, shown as ticks under its reply */
  actions?: string[];
  /** the inputs before this turn changed them, so the turn can be undone */
  before?: Inputs;
  failed?: boolean;
  /** a card read from a file the person attached, waiting for them to say which card it is */
  found?: ImportedCard;
  notes?: string[];
}

// every type the document reader accepts
const CHAT_FILES = ".pdf,.jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff,.doc,.docx,.rtf,.odt,.xls,.xlsx,.ods,.ppt,.pptx,.txt,.md,.csv";
const CHAT_FILE_MAX = 20 * 1024 * 1024;

const STARTERS = ["What should I pay this month?", "What if I pay $50 more each month?", "I paid my Card A payment today", "Why does the extra go to that card?"];

// one four-point star, centred in its box
const SPARK = "M12 2Q13.2 10.8 22 12Q13.2 13.2 12 22Q10.8 13.2 2 12Q10.8 10.8 12 2Z";

/**
 * The chat assistant. It can do what the screens do: its tools change the same inputs, so every
 * change it makes shows on the page behind it straight away, is listed under its reply, and can
 * be undone with one tap.
 */
export function Assistant() {
  const { inputs, update, chatOpen: open, setChatOpen: setOpen } = useStore();
  const [on, setOn] = useState<boolean | null>(null); // the server has a model switched on; null while asking
  const [busy, setBusy] = useState(false);
  const [freeLeft, setFreeLeft] = useState<number | null>(null); // questions left this month on Free
  const [text, setText] = useState("");
  const [log, setLog] = useState<ChatMessage[]>([]);

  useEffect(() => {
    aiStatus()
      .then((s) => setOn(!!s.assistant))
      .catch(() => setOn(false));
  }, []);
  useEffect(() => {
    const list = document.querySelector(".chat-list");
    if (list) list.scrollTop = list.scrollHeight;
  }, [log, busy, open]);

  // The panel is docked at the side: the page makes room for it instead of being covered.
  useEffect(() => {
    document.body.classList.toggle("with-assistant", open && !!inputs);
    return () => document.body.classList.remove("with-assistant");
  }, [open, inputs]);

  if (!inputs || !open) return null;

  async function send(question: string) {
    const q = question.trim();
    if (!q || busy || !inputs) return;
    const history = [...log, { role: "user" as const, content: q }];
    setLog(history);
    setText("");
    setBusy(true);
    try {
      const out = await askAssistant(history.filter((m) => !m.failed).map((m) => ({ role: m.role, content: m.content })), inputs);
      const actions = out.actions.map((a) => a.summary);
      setFreeLeft(out.free_left);
      setLog([...history, { role: "assistant", content: out.reply, actions, before: out.inputs ? inputs : undefined }]);
      if (out.inputs) update(out.inputs, { text: `Assistant: ${actions.join(" · ") || "plan updated"}.`, href: "#/plan", label: "See the plan" });
      if (out.navigate) go(out.navigate);
    } catch (e) {
      setLog([...history, { role: "assistant", content: e instanceof ApiProblem ? e.message : "I couldn’t answer just now. Please try again.", failed: true }]);
    } finally {
      setBusy(false);
    }
  }

  /** A statement attached in the chat: read it, show what was found, and ask which card it belongs to. */
  async function attach(file: File | undefined) {
    if (!file || busy || !inputs) return;
    const history = [...log, { role: "user" as const, content: `Attached: ${file.name}` }];
    setLog(history);
    if (file.size > CHAT_FILE_MAX) {
      setLog([...history, { role: "assistant", content: "That file is larger than 20 MB. Send just the statement summary, or a smaller file.", failed: true }]);
      return;
    }
    setBusy(true);
    try {
      const out = await extractStatement({ file });
      const c = out.cards[0];
      const parts = [`balance ${money(c.balance)}`, c.minimum ? `minimum ${money(c.minimum)}` : "", c.apr !== null ? `APR ${c.apr}%` : "", c.due_day ? `due day ${c.due_day}` : "", c.limit ? `limit ${money(c.limit)}` : ""].filter(Boolean);
      setLog([...history, { role: "assistant", content: `I read “${c.name}” from this file: ${parts.join(", ")}. Which of your cards is it?`, found: c, notes: out.notes }]);
    } catch (e) {
      setLog([...history, { role: "assistant", content: e instanceof ApiProblem ? e.message : "I couldn’t read that file. Try a PDF or a clear photo of the statement summary.", failed: true }]);
    } finally {
      setBusy(false);
    }
  }

  /** Put what was read onto one of the person's cards. Anything the file did not show is left as it was. */
  const applyFound = (i: number, cardId: string) => {
    const m = log[i];
    if (!m.found || !inputs) return;
    const f = m.found;
    const target = inputs.cards.find((c) => c.id === cardId);
    if (!target) return;
    const next = {
      ...inputs,
      first_month_budget: null,
      cards: inputs.cards.map((c) => (c.id === cardId ? { ...c, balance: f.balance, statement_balance: f.balance, minimum: f.minimum || c.minimum, apr: f.apr ?? c.apr, due_day: f.due_day ?? c.due_day, next_due: f.due_day && f.due_day !== c.due_day ? null : c.next_due, limit: f.limit ?? c.limit, min_paid: false } : c)),
    };
    const did = `${target.name} updated from the file: balance ${money(target.balance)} → ${money(f.balance)}`;
    update(next, { text: `Assistant: ${did}.`, href: "#/plan", label: "See the plan" });
    setLog(log.map((x, k) => (k === i ? { ...x, found: undefined, actions: [did], before: inputs } : x)));
  };

  const undo = (i: number) => {
    const m = log[i];
    if (!m.before) return;
    update(m.before, { text: "The assistant’s change was undone.", href: "#/plan", label: "See the plan" });
    setLog(log.map((x, k) => (k === i ? { ...x, before: undefined, actions: [...(x.actions ?? []), "Undone"] } : x)));
  };

  return (
    <aside className="chat" aria-label="Assistant">
      <header className="chat-head">
        <span className="chat-mark" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d={SPARK} />
          </svg>
        </span>
        <b>Assistant</b>
        <span className="chat-scope small">Your plan</span>
        <button type="button" className="chat-x" aria-label="Close the assistant" title="Close" onClick={() => setOpen(false)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 5h16v14H4zM15 5v14M9 10l2 2-2 2" />
          </svg>
        </button>
      </header>
      <div className="chat-list">
        {log.length === 0 && (
          <div className="chat-empty">
            <b className="chat-empty-title">Ask about your plan</b>
            <p className="muted">
              {on === false
                ? "The assistant isn’t switched on for this server right now."
                : "The assistant reads your plan and can change it for you: the budget, a balance, a payment you made. Every change is listed and can be undone."}
            </p>
            {STARTERS.map((s) => (
              <button key={s} type="button" className="chat-chip" onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {log.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role} ${m.failed ? "failed" : ""}`}>
            {/* the model sometimes writes Markdown emphasis; the chat shows plain text */}
            <p>{m.content.replace(/\*\*/g, "").replace(/^- /gm, "• ")}</p>
            {m.actions && m.actions.length > 0 && (
              <ul className="chat-did">
                {m.actions.map((a, k) => (
                  <li key={k}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                    {a}
                  </li>
                ))}
              </ul>
            )}
            {m.found && (
              <div className="chat-pick">
                {inputs.cards.map((c) => (
                  <button key={c.id} type="button" className="chat-chip" onClick={() => applyFound(i, c.id)}>
                    Update {c.name}
                  </button>
                ))}
                <a className="chat-chip" href="#/import">
                  It’s a new card
                </a>
                {(m.notes ?? []).slice(0, 2).map((n) => (
                  <span key={n} className="small muted">
                    {n}
                  </span>
                ))}
              </div>
            )}
            {m.before && (
              <button type="button" className="link small" onClick={() => undo(i)}>
                Undo this change
              </button>
            )}
          </div>
        ))}
        {busy && (
          <div className="chat-msg assistant typing" aria-label="The assistant is working">
            <i />
            <i />
            <i />
          </div>
        )}
      </div>
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <label className="chat-clip" htmlFor="chat-file" title="Attach a statement: PDF, photo, Word or Excel" aria-label="Attach a file">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.8 1.8 0 0 1-2.5-2.5l7.6-7.6" />
          </svg>
          <input id="chat-file" type="file" accept={CHAT_FILES} disabled={busy} onChange={(e) => { attach(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask, instruct, or attach a statement…" aria-label="Message" maxLength={600} disabled={busy} />
        <button type="submit" className="chat-send" aria-label="Send" disabled={busy || !text.trim()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5M6 11l6-6 6 6" />
          </svg>
        </button>
      </form>
      {freeLeft !== null && (
        <p className="chat-left small muted">
          {freeLeft} of 5 free questions left this month. <a href="#/plus">Plus has no limit.</a>
        </p>
      )}
      <p className="chat-foot">Estimates only, not financial advice. Check changes on the plan.</p>
    </aside>
  );
}

// ---------------------------------------------------------------- first visit

const TOUR = [
  { route: "plan", target: ".plan-hero", title: "Your next payment", text: "This is an example with three cards. The top of the plan always says what to pay next and by when." },
  { route: "plan", target: ".flow", title: "Where the money goes", text: "One bar for the month. Each slice is a card; green is the extra on top of the minimums." },
  { route: "schedule", target: ".head", title: "Schedule", text: "Every due date month by month, until the last payment. Tap a date to see what is due." },
  { route: "what-if", target: ".slider", title: "What if", text: "Move the amount and see the new debt-free month and interest before you change anything." },
  { route: "bank", target: ".goal-tabs", title: "Bank call", text: "A script for calling the card issuer: a lower rate, a waived fee or a hardship plan, with your own numbers in it." },
  { route: "update", target: ".fan", title: "Balances", text: "After you pay, mark it as paid here. The plan recalculates around what you really did." },
  { route: "plan", target: ".ai-btn", title: "Or just ask", text: "The assistant explains the plan, makes these changes for you and reads a statement you attach." },
];

/** A tour of the demo, one tab at a time. It starts the first time the demo opens, can be left at any
 * step, and ends with a choice: keep looking at the demo, or enter your own cards. */
export function Tutorial({ route }: { route: string }) {
  const { plan, isDemo, toured, setToured } = useStore();
  const [step, setStep] = useState(0);
  const [box, setBox] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const show = isDemo && !toured && !!plan && plan.status === "ok";
  const done = step >= TOUR.length;
  const at = TOUR[Math.min(step, TOUR.length - 1)];

  // each step opens its own tab
  useEffect(() => {
    if (show && !done && route !== at.route) go(at.route);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, step]);

  useEffect(() => {
    if (!show || done || route !== at.route) return setBox(null);
    const place = () => {
      const el = document.querySelector(at.target);
      if (!el) return setBox(null);
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      const r = el.getBoundingClientRect();
      setBox({ top: r.top + window.scrollY - 8, left: r.left + window.scrollX - 8, width: r.width + 16, height: r.height + 16 });
    };
    const timer = setTimeout(place, 450); // after the page has settled
    window.addEventListener("resize", place);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", place);
    };
  }, [show, done, step, route, at.route, at.target]);

  if (!show) return null;
  const own = () => {
    setToured();
    go("setup/1");
  };
  if (done)
    return (
      <div className="tour" role="dialog" aria-label="End of the tour">
        <b>That’s FinPilot</b>
        <p>Now build the same plan from your own cards. It takes about two minutes, with no account needed.</p>
        <div className="actions">
          <button type="button" className="btn" onClick={own}>
            Fill in my data
          </button>
          <button type="button" className="btn ghost" onClick={() => setToured()}>
            Continue with the demo
          </button>
        </div>
      </div>
    );
  return (
    <>
      {box && <div className="tour-ring" style={box} aria-hidden="true" />}
      <div className="tour" role="dialog" aria-label="A tour of the demo">
        <span className="small muted">
          {step + 1} of {TOUR.length}
        </span>
        <b>{at.title}</b>
        <p>{at.text}</p>
        <div className="actions">
          <button type="button" className="btn" onClick={() => setStep(step + 1)}>
            Next
          </button>
          {step > 0 && (
            <button type="button" className="btn ghost" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <button type="button" className="link small tour-own" onClick={own}>
            Start building my own plan
          </button>
        </div>
      </div>
    </>
  );
}

/** After the first results: an offer to keep the plan in an account. Optional, and dismissed for good with one tap. */
export function AccountOffer({ route }: { route: string }) {
  const { inputs, isDemo, account, toured, offerSeen, setOfferSeen } = useStore();
  if (!inputs || isDemo || account || !toured || offerSeen || route !== "plan") return null;
  return (
    <aside className="offer" role="status">
      <b>Keep this plan</b>
      <span className="small">Create a free account and it is saved for you, on this and any other device.</span>
      <div className="actions">
        <a className="btn" href="#/account" onClick={() => setOfferSeen()}>
          Create an account
        </a>
        <button type="button" className="link small" onClick={() => setOfferSeen()}>
          Not now
        </button>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- plans

const PLUS_MONTH = 9.99;
const PLUS_YEAR = Math.round((PLUS_MONTH * 12 - 20) * 100) / 100; // twelve months, $20 off (two months), billed once
const PLUS_YEAR_MONTHLY = Math.floor((PLUS_YEAR / 12) * 100) / 100;

const PLAN_FAQ: [string, string][] = [
  ["What happens to my cards and history if I cancel Plus?", "Nothing is deleted. Your cards, payments and plan stay in your account and you go back to the Free limits."],
  ["Which statements and banks are supported?", "Any US card issuer: FinPilot reads the statement itself, not your bank account. PDF, a photo or scan, Word, and Excel or CSV all work. Every number is shown for you to check before it is used."],
  ["What if Plus isn’t for me?", "The yearly plan starts with 7 days free: cancel in that week and you pay nothing. Monthly can be cancelled at any time and stops at the end of the month you paid for."],
];

const PLAN_ROWS: [string, string, string][] = [
  ["Payoff plan and schedule", "Highest rate first", "Compare highest rate first with smallest balance first"],
  ["What if", "A different amount every month", "Also a one-off month: a bonus, a refund, a tight month"],
  ["Bank-call scripts", "Waive a fee", "All four, including a lower APR"],
  ["Statements read for you", "1, to try it", "No limit"],
  ["Assistant", "5 questions a month", "No limit"],
  ["Reminders and calendar export", "—", "Included"],
];

/** Free and Plus side by side, with one switch for monthly or yearly billing.
 * Billing is not connected yet: the yearly button starts a real 7-day trial with no payment details,
 * and nothing is charged when it ends. */
export function PlansPage() {
  const { account, plan, tier, startTrial } = useStore();
  const [yearly, setYearly] = useState(true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const onPlus = tier?.tier === "plus";
  // what this person's own plan saves, to set the price against
  const mine = plan?.comparison.find((c) => c.strategy === plan.strategy);
  const floor = plan?.comparison.find((c) => c.strategy === "minimum");
  const saved = plan && plan.status === "ok" && mine && floor && floor.status === "ok" && mine.total_interest !== null && floor.total_interest !== null ? floor.total_interest - mine.total_interest : 0;
  const share = saved > 0 ? (PLUS_YEAR / saved) * 100 : 0;
  const until = tier?.plus_until ? new Date(tier.plus_until).toLocaleDateString("en-US", { month: "long", day: "numeric" }) : "";

  async function choose() {
    setNote("");
    if (!yearly) return setNote("Paid plans are not open yet, so nothing was charged. The 7-day trial on the yearly plan works now.");
    if (!account) return go("account");
    setBusy(true);
    try {
      await startTrial();
      setNote("Your 7 days of Plus have started. No card was asked for and nothing will be charged when they end.");
    } catch (e) {
      setNote(e instanceof ApiProblem ? `${e.message} Paid plans are not open yet.` : "We couldn’t start the trial. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <PageHead title="Plans">Save hundreds on interest. Let Plus do the routine for you.</PageHead>
      {saved >= 300 && (
        <p className="plans-worth">
          Your plan saves <b className="ok">{money(Math.round(saved))}</b> in interest. A year of Plus costs {share < 1 ? "less than 1%" : `about ${Math.round(share)}%`} of that.
        </p>
      )}
      <p className="note">For now everything in Plus is open to everyone, free, with no account needed. The limits below start when paid plans open.</p>
      <div className="tabs plans-switch" role="group" aria-label="Billing">
        <button type="button" className={yearly ? "tab" : "tab on"} aria-pressed={!yearly} onClick={() => setYearly(false)}>
          Monthly
        </button>
        <button type="button" className={yearly ? "tab on" : "tab"} aria-pressed={yearly} onClick={() => setYearly(true)}>
          Yearly <span className="plans-gift">2 months free</span>
        </button>
      </div>
      <section className="grid2 plans">
        <div className="panel stack tight plan-tier">
          <h2>Free</h2>
          <p className="plan-price">
            <b>$0</b>
          </p>
          <span className="small muted">{onPlus ? "What you go back to after Plus" : "What you have now"}</span>
          <ul className="list muted">
            {PLAN_ROWS.filter((r) => r[1] !== "—").map((r) => (
              <li key={r[0]}>
                {r[0]}: {r[1].charAt(0).toLowerCase() + r[1].slice(1)}
              </li>
            ))}
          </ul>
          <button type="button" className="btn ghost" disabled>
            {onPlus ? "Free" : "Your current plan"}
          </button>
        </div>
        <div className="panel stack tight plan-tier best">
          <div className="row start">
            <h2>Plus</h2>
            {yearly && <span className="pill ok-tag">2 months free</span>}
          </div>
          <p className="plan-price">
            <b>{money(yearly ? PLUS_YEAR_MONTHLY : PLUS_MONTH)}</b> / month
          </p>
          <span className="small muted">{yearly ? `${money(PLUS_YEAR)} billed annually, after 7 days free` : "Billed every month. Cancel any time."}</span>
          <ul className="list muted">
            {PLAN_ROWS.map((r) => (
              <li key={r[0]}>
                {r[0]}: {r[2].charAt(0).toLowerCase() + r[2].slice(1)}
              </li>
            ))}
          </ul>
          {onPlus ? (
            <button type="button" className="btn ghost" disabled>
              Plus is on until {until}
            </button>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={choose}>
              {yearly ? (account ? "Start 7-day free trial" : "Sign in to start the 7-day trial") : "Choose monthly"}
            </button>
          )}
          <span className="small muted plan-trust">We never ask for a card number, SSN or bank login. Cancel any time.</span>
        </div>
      </section>
      {note && (
        <p className="note" role="status">
          {note}
        </p>
      )}
      <section className="stack tight plans-faq">
        <h2>Questions</h2>
        {PLAN_FAQ.map(([q, text]) => (
          <Fold key={q} title={q}>
            <p className="muted">{text}</p>
          </Fold>
        ))}
      </section>
      <p className="small muted">Prices in US dollars. FinPilot gives estimates, not financial advice.</p>
    </main>
  );
}

// ---------------------------------------------------------------- account

export function AccountPage() {
  const { account, signIn, signOut, deleteAccount, inputs, isDemo } = useStore();
  const [mode, setMode] = useState<"new" | "in">("new");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);

  if (account) {
    return (
      <main className="page">
        <PageHead title="Your account">Signed in as {account.email}. Your plan is saved as you change it.</PageHead>
        <div className="grid2">
          <section className="panel stack tight">
            <h2>What is saved</h2>
            <ul className="muted list">
              <li>Your cards: nickname, balance, APR, minimum, due date, limit</li>
              <li>Your monthly budget and the order you chose</li>
              <li>Payments you marked as paid, and your progress</li>
            </ul>
            <p className="small muted">Never saved: card numbers, your name, a bank login, or the files you upload.</p>
            <div className="actions">
              <a className="btn" href="#/plan">
                Open my plan
              </a>
              <button type="button" className="btn ghost" onClick={() => signOut()}>
                Sign out
              </button>
            </div>
          </section>
          <section className="panel stack tight">
            <h2>Delete my account</h2>
            <p className="muted">Removes your account and everything saved for it from our server. This cannot be undone.</p>
            <div className="actions">
              {!confirming ? (
                <button type="button" className="btn danger" onClick={() => setConfirming(true)}>
                  Delete my account
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn danger"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      deleteAccount()
                        .catch(() => setError("We couldn’t delete the account. Please try again."))
                        .finally(() => {
                          setBusy(false);
                          setConfirming(false);
                        });
                    }}
                  >
                    Yes, delete it all
                  </button>
                  <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>
                    Keep it
                  </button>
                </>
              )}
            </div>
            {error && <p className="note danger">{error}</p>}
          </section>
        </div>
      </main>
    );
  }

  const submit = () => {
    setBusy(true);
    setError("");
    signIn(email, password, mode === "new")
      .then((hasPlan) => go(hasPlan ? "plan" : "setup/1"))
      .catch((e) => setError(e instanceof ApiProblem ? e.message : "That didn’t work. Please try again."))
      .finally(() => setBusy(false));
  };
  return (
    <main className="page">
      <PageHead title={mode === "new" ? "Create an account" : "Sign in"}>
        {mode === "new" ? "Optional. It keeps your plan so you can open it on another device. Next, a few questions build your plan." : "Open the plan you saved."}
      </PageHead>
      <div className="split">
        <section className="panel stack">
          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={mode === "new"} className={mode === "new" ? "tab on" : "tab"} onClick={() => { setMode("new"); setError(""); }}>
              Create account
            </button>
            <button type="button" role="tab" aria-selected={mode === "in"} className={mode === "in" ? "tab on" : "tab"} onClick={() => { setMode("in"); setError(""); }}>
              Sign in
            </button>
          </div>
          <form
            className="stack tight"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="field">
              <label htmlFor="acc-email">Email</label>
              <input id="acc-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="acc-pass">Password</label>
              <input id="acc-pass" type="password" autoComplete={mode === "new" ? "new-password" : "current-password"} minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
              {mode === "new" && <span className="small muted">At least 8 characters.</span>}
            </div>
            {error && (
              <p className="note danger" role="alert">
                {error}
              </p>
            )}
            <div className="actions">
              <button type="submit" className="btn" disabled={busy || !email || password.length < 8}>
                {busy ? "One moment…" : mode === "new" ? "Create my account" : "Sign in"}
              </button>
            </div>
          </form>
        </section>
        <aside className="panel stack tight">
          <h2>What an account stores</h2>
          <ul className="muted list">
            <li>Your email and a scrambled form of your password</li>
            <li>The cards, budget and payments you entered</li>
          </ul>
          <p className="small muted">No card numbers, no name, no bank login. You can delete the account and everything in it at any time.</p>
          {mode === "new" && inputs && !isDemo && <p className="small ok">The plan you just built will be saved to the new account.</p>}
          {mode === "in" && inputs && !isDemo && <p className="small warn">Signing in opens the plan saved in that account in place of the one on screen.</p>}
        </aside>
      </div>
    </main>
  );
}
