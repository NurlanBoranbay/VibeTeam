import { useEffect, useState } from "react";
import { aiStatus, ApiProblem, askAssistant, extractStatement, type ImportedCard, type Inputs } from "../api";
import { money } from "../format";
import { useStore } from "../store";
import { go, PageHead } from "../ui";

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
  const { inputs, update, chatOpen: open, setChatOpen: setOpen, account } = useStore();
  const [on, setOn] = useState<boolean | null>(null); // the server has a model switched on; null while asking
  const [busy, setBusy] = useState(false);
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
        {!account && (
          <div className="chat-empty">
            <b className="chat-empty-title">Sign in to use the assistant</b>
            <p className="muted">The assistant and statement reading are for people with an account. A free account is enough, and your plan comes with you.</p>
            <a className="btn" href="#/account">
              Sign in or create an account
            </a>
          </div>
        )}
        {account && log.length === 0 && (
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
          <input id="chat-file" type="file" accept={CHAT_FILES} disabled={busy || !account} onChange={(e) => { attach(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={account ? "Ask, instruct, or attach a statement…" : "Sign in to ask"} aria-label="Message" maxLength={600} disabled={busy || !account} />
        <button type="submit" className="chat-send" aria-label="Send" disabled={busy || !text.trim()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5M6 11l6-6 6 6" />
          </svg>
        </button>
      </form>
      <p className="chat-foot">Estimates only, not financial advice. Check changes on the plan.</p>
    </aside>
  );
}

// ---------------------------------------------------------------- first visit

const TOUR = [
  { target: ".plan-hero", title: "Your next payment", text: "The top of the plan always says what to pay next and by when." },
  { target: ".flow", title: "Where the money goes", text: "One bar for the month. Each slice is a card; green is the extra on top of the minimum." },
  { target: ".top nav", title: "Try a change", text: "What if shows what a different budget does. Balances is where you mark a payment as paid." },
  { target: ".ai-btn", title: "Or just ask", text: "The assistant can explain the plan and make these changes for you." },
];

/** A short tour of the plan, shown once after the first results. It can be skipped at any step. */
export function Tutorial({ route }: { route: string }) {
  const { plan, toured, setToured } = useStore();
  const [step, setStep] = useState(0);
  const [box, setBox] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const show = !toured && route === "plan" && !!plan && plan.status === "ok";
  const at = TOUR[step];

  useEffect(() => {
    if (!show) return;
    const place = () => {
      const el = document.querySelector(at.target);
      if (!el) return setBox(null);
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      const r = el.getBoundingClientRect();
      setBox({ top: r.top + window.scrollY - 8, left: r.left + window.scrollX - 8, width: r.width + 16, height: r.height + 16 });
    };
    const timer = setTimeout(place, 350); // after the page has settled
    window.addEventListener("resize", place);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", place);
    };
  }, [show, step, at.target]);

  if (!show) return null;
  const last = step === TOUR.length - 1;
  return (
    <>
      {box && <div className="tour-ring" style={box} aria-hidden="true" />}
      <div className="tour" role="dialog" aria-label="A short tour">
        <span className="small muted">
          {step + 1} of {TOUR.length}
        </span>
        <b>{at.title}</b>
        <p>{at.text}</p>
        <div className="actions">
          <button type="button" className="btn" onClick={() => (last ? setToured() : setStep(step + 1))}>
            {last ? "Done" : "Next"}
          </button>
          <button type="button" className="link small" onClick={() => setToured()}>
            Skip the tour
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
const PLUS_YEAR = Math.round((PLUS_MONTH * 12 - 20) * 100) / 100; // twelve months, $20 off, billed once

/** Free and Plus. Billing is not connected yet, so choosing Plus charges nothing and changes nothing. */
export function PlansPage() {
  const { account } = useStore();
  const [picked, setPicked] = useState<string | null>(null);
  const tiers = [
    { id: "free", name: "Free", price: "$0", per: "", note: "What you have now", points: ["A payoff plan for up to 3 cards", "Schedule, what-if and the bank-call scripts", "With a free account: the assistant, and 5 documents read a month"], cta: "Your current plan", best: false },
    { id: "month", name: "Plus monthly", price: money(PLUS_MONTH), per: "a month", note: "Billed every month. Cancel any time.", points: ["Everything in Free", "No monthly limit on documents read", "Payment reminders"], cta: "Choose monthly", best: false },
    { id: "year", name: "Plus yearly", price: money(PLUS_YEAR), per: "a year", note: `Billed once a year. $20 less than twelve months at ${money(PLUS_MONTH)}.`, points: ["Everything in Plus monthly", `Works out to ${money(Math.round((PLUS_YEAR / 12) * 100) / 100)} a month`], cta: "Choose yearly", best: true },
  ];
  return (
    <main className="page">
      <PageHead title="Plans">Start free. Plus adds the hands-off parts.</PageHead>
      <section className="grid3 plans">
        {tiers.map((t) => (
          <div key={t.id} className={t.best ? "panel stack tight plan-tier best" : "panel stack tight plan-tier"}>
            <div className="row start">
              <h2>{t.name}</h2>
              {t.best && <span className="pill ok-tag">Save $20</span>}
            </div>
            <p className="plan-price">
              <b>{t.price}</b> {t.per}
            </p>
            <span className="small muted">{t.note}</span>
            <ul className="list muted">
              {t.points.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <button type="button" className={t.id === "free" ? "btn ghost" : "btn"} disabled={t.id === "free"} onClick={() => setPicked(t.id)}>
              {t.cta}
            </button>
          </div>
        ))}
      </section>
      {picked && (
        <p className="note" role="status">
          Paid plans are not open yet, so nothing was charged and your plan is still Free. Everything listed under Plus works for everyone during this preview.
          {!account && (
            <>
              {" "}
              <a href="#/account">Create a free account</a> to keep your plan in the meantime.
            </>
          )}
        </p>
      )}
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
