import { useEffect, useState } from "react";
import { ApiProblem, extractStatement, importTable, type Card, type ImportedCard, type Treatment } from "../api";
import { money } from "../format";
import { useStore } from "../store";
import { go, NumberField, PageHead, Pick } from "../ui";

type SourceId = "table" | "doc" | "pdf" | "photo";

// Inner ring: sources that work today. Outer ring: planned, not built.
// `logo` is the product's own mark, loaded from the Simple Icons CDN (an open, CC0 icon set); the
// drawn `icon` is shown if it cannot load. Sources without a logo there keep a drawn icon in a
// colour people associate with the file type.
interface Source {
  label: string;
  icon: string;
  logo?: string;
  color?: string;
}
const LOGOS = "https://cdn.simpleicons.org";
const FILE_ICONS = "https://api.iconify.design/vscode-icons"; // file-type marks for Excel and PDF, which Simple Icons does not carry
const LIVE: (Source & { id: SourceId })[] = [
  { id: "table", label: "Excel or CSV", icon: "M3 5h18v14H3zM3 10h18M3 15h18M9 5v14M15 5v14", color: "#33c481", logo: `${FILE_ICONS}/file-type-excel.svg` },
  { id: "doc", label: "Statement document", icon: "M5 4h14v16H5zM8 9h8M8 13h8M8 17h5", logo: `${LOGOS}/googledocs` },
  { id: "photo", label: "Photo of a statement", icon: "M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", color: "#6fd6a0" },
  { id: "pdf", label: "Statement PDF", icon: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 14h8M8 18h5", color: "#ff6b63", logo: `${FILE_ICONS}/file-type-pdf2.svg` },
];
const SOON: Source[] = [
  { label: "Google Sheets", icon: "M4 4h16v16H4zM4 12h16M12 4v16", logo: `${LOGOS}/googlesheets` },
  { label: "Google Calendar", icon: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4", logo: `${LOGOS}/googlecalendar` },
  { label: "Notion", icon: "M6 3h12v18H6zM9 7h6M9 11h6M3 7h3M3 12h3M3 17h3", logo: `${LOGOS}/notion/white` },
  { label: "Google Drive", icon: "M8 4h8l6 10-4 6H6l-4-6zM8 4l6 10M16 4L10 14M2 14h20", logo: `${LOGOS}/googledrive` },
  { label: "Gmail", icon: "M3 6h18v12H3zM3 7l9 7 9-7", logo: `${LOGOS}/gmail` },
  { label: "Airtable", icon: "M3 8l9-4 9 4-9 4zM3 11v7l8 3v-7zM21 11v7l-8 3v-7z", logo: `${LOGOS}/airtable` },
  { label: "Bank connection", icon: "M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" },
];
const IMPORT_MAX = 20;

const SAMPLE = `SUMMIT REWARDS VISA
Account Summary
Previous Balance $1,380.22   Payments -$200.00   Purchases +$283.74   Interest Charged +$36.04
New Balance $1,500.00
Credit Limit $3,000.00   Available Credit $1,500.00
Minimum Payment Due $40.00
Payment Due Date December 22, 2026
Interest Charge Calculation
Purchases   29.00% (v)   $1,490.12`;

/** Position on a ring: angle in degrees (0 = right, 90 = down), radius as a share of the orbit's width. */
const at = (angle: number, radius: number) => ({
  left: `${50 + radius * Math.cos((angle * Math.PI) / 180)}%`,
  top: `${50 + radius * Math.sin((angle * Math.PI) / 180)}%`,
});

/** The product's logo when there is one and it loads; otherwise the drawn icon. */
function Mark({ source, size }: { source: Source; size: number }) {
  const [failed, setFailed] = useState(false);
  if (source.logo && !failed) return <img src={source.logo} alt="" width={size} height={size} onError={() => setFailed(true)} />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={source.color ?? "currentColor"} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={source.icon} />
    </svg>
  );
}

const SOURCE_NOTE: Record<string, string> = {
  file: "Read directly from your file. No AI was used.",
  ai: "Read by AI. Every figure was checked against the statement text; anything not found there was left empty. The balance is the statement balance: check it against the current balance in your banking app.",
  patterns: "Read by matching the standard statement labels. No AI was used. The balance is the statement balance: check it against the current balance in your banking app.",
};

// The drop zone is always the same box and takes any supported file. Choosing a source in the
// inner ring only changes the words at the top of it.
const DROP_TEXT: Record<SourceId | "any", { title: string; hint: string }> = {
  any: { title: "Paste or drop your files here", hint: "Excel, CSV, PDF, Word, text or a photo · up to 10 MB" },
  table: { title: "Paste or drop your spreadsheet here", hint: ".xlsx or .csv, one row per card: Card, Balance, APR, Minimum, Due day, Limit" },
  doc: { title: "Paste or drop your statement document here", hint: ".docx or .txt of one card’s statement, or paste copied statement text" },
  photo: { title: "Paste or drop a photo of your statement here", hint: ".jpg or .png of the summary: balance, minimum payment, due date and rates. Read by AI." },
  pdf: { title: "Paste or drop your statement PDF here", hint: ".pdf downloaded from your bank, one card per file" },
};
const DROP_ACCEPT = ".csv,.xlsx,.xlsm,.pdf,.docx,.txt,.md,.jpg,.jpeg,.png,.webp";
const DROP_MAX_BYTES = 10 * 1024 * 1024;

/** What a statement would change on an existing card, field by field, for the person to check first. */
function changes(old: Card, found: ImportedCard, currentBalance: number): { label: string; from: string; to: string }[] {
  const pct = (v: number | null) => (v === null ? "Not entered" : `${v}%`);
  const day = (v: number | null) => (v === null ? "Not entered" : `Day ${v}`);
  return [
    { label: "Statement amount", from: old.statement_balance === null || old.statement_balance === undefined ? "Not entered" : money(old.statement_balance), to: money(found.balance) },
    { label: "Current balance", from: money(old.balance), to: money(currentBalance) },
    { label: "Minimum still due", from: money(old.minimum), to: money(found.minimum || old.minimum) },
    { label: "Due date", from: day(old.due_day), to: day(found.due_day ?? old.due_day) },
    { label: "APR", from: pct(old.apr), to: pct(found.apr ?? old.apr) },
  ];
}

export default function ImportPage() {
  const { setPrefill, inputs, update } = useStore();
  // With a plan open, each card that was read must be sent somewhere on purpose: onto an existing
  // card, or added as a new one. Nothing replaces the plan silently.
  const [target, setTarget] = useState<Record<number, string>>({});
  const [current, setCurrent] = useState<Record<number, number | null>>({});
  const [kindOf, setKindOf] = useState<Record<number, Treatment | "">>({});
  const [active, setActive] = useState<SourceId | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cards, setCards] = useState<ImportedCard[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [source, setSource] = useState("");
  const [table, setTable] = useState(false);

  async function run(job: () => Promise<{ cards: ImportedCard[]; notes: string[]; source: string }>, append: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await job();
      const merged = append ? [...cards, ...result.cards] : result.cards;
      const extra = merged.length > IMPORT_MAX ? [`This version plans up to ${IMPORT_MAX} cards, so only the first ${IMPORT_MAX} are kept.`] : [];
      setCards(merged.slice(0, IMPORT_MAX));
      setTarget({});
      setCurrent({});
      setKindOf({});
      setTable(!append);
      setNotes([...result.notes, ...extra]);
      setSource(result.source);
    } catch (e) {
      setError(e instanceof ApiProblem ? e.message : "We couldn’t read that. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  /** Any supported file, however it arrived: dropped, pasted or picked with Browse. */
  function take(file: File | undefined) {
    if (!file || busy) return;
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    if (file.size > DROP_MAX_BYTES) setError("This file is larger than 10 MB. Drop just the statement summary or a smaller file.");
    else if (["csv", "xlsx", "xlsm"].includes(ext)) run(() => importTable(file), false);
    else if (["pdf", "docx", "txt", "md", "jpg", "jpeg", "png", "webp"].includes(ext)) run(() => extractStatement({ file }), true);
    else setError("This file type can’t be read. Use Excel, CSV, PDF, Word (.docx), text or a JPG/PNG photo.");
  }

  // Ctrl+V anywhere on the page: a copied file, or copied statement text.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      if (!data || busy) return;
      if (data.files.length > 0) {
        e.preventDefault();
        take(data.files[0]);
        return;
      }
      const pasted = data.getData("text");
      if (!pasted.trim()) return;
      e.preventDefault();
      if (pasted.trim().length < 40) setError("That’s too short to be a statement. Copy the summary with the balance and minimum payment, then paste again.");
      else run(() => extractStatement({ text: pasted }), true);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  const drop = DROP_TEXT[active ?? "any"];

  const useCards = () => {
    // only the plain card fields are passed on, and the treatment is left unanswered: the person confirms it in setup
    setPrefill(cards.map((c, i) => ({ id: `card-${i}-${Math.random().toString(36).slice(2, 7)}`, name: c.name, balance: c.balance, minimum: c.minimum, apr: c.apr, due_day: c.due_day, limit: c.limit, treatment: null })));
    go("setup/3");
  };

  // ---- applying to an open plan
  const adding = cards.filter((_, i) => target[i] === "new").length;
  const room = IMPORT_MAX - (inputs?.cards.length ?? 0) - adding;
  const ready =
    cards.length > 0 &&
    cards.every((c, i) => {
      const t = target[i] ?? "";
      const bal = current[i] === undefined ? c.balance : current[i];
      return t !== "" && bal !== null && bal >= 0 && (t !== "new" || !!kindOf[i]);
    });
  const applyToPlan = () => {
    if (!inputs || !ready) return;
    let next = inputs.cards;
    const said: string[] = [];
    cards.forEach((c, i) => {
      const bal = (current[i] === undefined ? c.balance : current[i]) ?? c.balance;
      if (target[i] === "new") {
        next = [...next, { id: `card-${Math.random().toString(36).slice(2, 8)}`, name: c.name, balance: bal, statement_balance: c.balance, minimum: c.minimum, apr: c.apr, due_day: c.due_day, limit: c.limit, treatment: kindOf[i] as Treatment }];
        said.push(`${c.name} added`);
        return;
      }
      next = next.map((x) => {
        if (x.id !== target[i]) return x;
        const diff = changes(x, c, bal).filter((r) => r.from !== r.to).map((r) => `${r.label.toLowerCase()} ${r.from} → ${r.to}`);
        said.push(`${x.name}: ${diff.length ? diff.join(", ") : "no change"}`);
        // a new statement brings a new minimum to pay: the old "already paid" mark no longer applies
        return { ...x, balance: bal, statement_balance: c.balance, minimum: c.minimum || x.minimum, apr: c.apr ?? x.apr, due_day: c.due_day ?? x.due_day, next_due: c.due_day && c.due_day !== x.due_day ? null : x.next_due, limit: c.limit ?? x.limit, min_paid: false };
      });
    });
    update({ ...inputs, cards: next, first_month_budget: null }, { text: `Updated from the statement. ${said.join(". ")}. The plan and forecast are recalculated.`, href: "#/plan", label: "See the plan" });
    go("plan");
  };

  return (
    <main className="page">
      <PageHead title={inputs ? "Update from a statement" : "Bring your cards in"}>{inputs ? "Drop a new statement, choose which card it belongs to, and check what changes before you apply it." : "Drop a file. We fill in your cards. You check every number."}</PageHead>

      <div className="split import">
        <section className="orbit" aria-label="Import sources">
          <span className="orbit-ring inner" aria-hidden="true" />
          {LIVE.map((s, i) => (
            <button key={s.id} type="button" className={`orbit-item live ${active === s.id ? "on" : ""}`} style={at(-90 + i * (360 / LIVE.length), 25)} aria-pressed={active === s.id} onClick={() => { setActive(s.id); setError(""); }}>
              <span className="orbit-icon">
                <Mark source={s} size={46} />
              </span>
              <span className="orbit-label">{s.label}</span>
            </button>
          ))}
        </section>

        <section className="stack">
          <div className="note stack tight">
            <b>How your file is read</b>
            <span className="small">
              It is sent to our server and read there by our own document and AI models to pull out the numbers. The file itself is not kept. Only
              the balance, minimum payment, due date, rates and credit limit are used.
            </span>
            <span className="small">You can black out your name, address and account number before you upload. They are not needed.</span>
          </div>

          <label
            htmlFor="imp-file"
            className={`drop ${over ? "over" : ""} ${busy ? "busy" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files[0]); }}
          >
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
            </svg>
            <span className="drop-title">{drop.title}</span>
            <span className="drop-hint">{drop.hint}</span>
            <span className="drop-browse">Browse</span>
            <input id="imp-file" type="file" accept={DROP_ACCEPT} disabled={busy} onChange={(e) => { take(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          <p className="small muted">
            Leave out your name and account number where you can. No file to hand?{" "}
            <button type="button" className="link" disabled={busy} onClick={() => run(() => extractStatement({ text: SAMPLE }), true)}>
              Try a sample statement
            </button>
          </p>

          {busy && <p className="muted">Reading…</p>}
          {error && <p className="note danger" role="alert">{error}</p>}

          {cards.length > 0 && !busy && (
            <div className="panel stack tight">
              <h2>
                {cards.length} card{cards.length === 1 ? "" : "s"} found
              </h2>
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
                    {cards.map((c, i) => (
                      <tr key={i}>
                        <td>
                          <b>{c.name}</b>
                        </td>
                        <td className="r">{money(c.balance)}</td>
                        <td className={`r ${c.apr === null ? "warn" : ""}`}>{c.apr === null ? "Not found" : `${c.apr}%`}</td>
                        <td className={`r ${c.minimum ? "" : "warn"}`}>{c.minimum ? money(c.minimum) : "Not found"}</td>
                        <td className={`r ${c.due_day === null ? "muted" : ""}`}>{c.due_day ?? "—"}</td>
                        <td className={`r ${c.limit === null ? "muted" : ""}`}>{c.limit === null ? "—" : money(c.limit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="small muted">{SOURCE_NOTE[source]}</p>
              {notes.length > 0 && (
                <ul className="list small muted">
                  {notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              {inputs ? (
                <div className="stack">
                  <h2>Where does each card go?</h2>
                  {cards.map((c, i) => {
                    const t = target[i] ?? "";
                    const old = inputs.cards.find((x) => x.id === t);
                    const extra = c as unknown as { balance_label?: string | null };
                    const now = current[i] === undefined ? c.balance : current[i];
                    return (
                      <div key={i} className="record stack tight">
                        <div className="field">
                          <label htmlFor={`imp-target-${i}`}>
                            “{c.name}” from this file is…
                          </label>
                          <Pick
                            id={`imp-target-${i}`}
                            value={t}
                            onChange={(v) => setTarget({ ...target, [i]: v })}
                            options={[
                              ...inputs.cards.map((x) => ({ value: x.id, label: `An update to ${x.name}`, disabled: Object.entries(target).some(([k, v]) => v === x.id && Number(k) !== i) })),
                              { value: "new", label: "A new card to add", disabled: room <= 0 && t !== "new" },
                            ]}
                          />
                        </div>
                        {t !== "" && (
                          <>
                            <NumberField
                              id={`imp-current-${i}`}
                              label="Current balance in your banking app ($)"
                              value={now ?? null}
                              onChange={(v) => setCurrent({ ...current, [i]: v })}
                              hint={`The statement shows ${money(c.balance)}${extra.balance_label ? ` as “${extra.balance_label}”` : ""}. That is the statement amount; change this if your app shows a different balance today.`}
                            />
                            {t === "new" && (
                              <div className="field">
                                <label htmlFor={`imp-kind-${i}`}>Which best describes this card?</label>
                                <Pick
                                  id={`imp-kind-${i}`}
                                  value={kindOf[i] ?? ""}
                                  onChange={(v) => setKindOf({ ...kindOf, [i]: v as Treatment })}
                                  options={[
                                    { value: "revolving", label: "I carry a balance and pay regular purchase interest" },
                                    { value: "pay_in_full", label: "I normally pay my statement in full" },
                                    { value: "promo", label: "I have a promotional or special financing offer" },
                                    { value: "unsure", label: "I’m not sure" },
                                  ]}
                                />
                              </div>
                            )}
                            {old && (
                              <div className="tbl">
                                <table>
                                  <thead>
                                    <tr>
                                      <th>{old.name}</th>
                                      <th className="r">Now</th>
                                      <th className="r">After</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {changes(old, c, now ?? c.balance).map((row) => (
                                      <tr key={row.label} className={row.from === row.to ? "muted" : ""}>
                                        <td>{row.label}</td>
                                        <td className="r">{row.from}</td>
                                        <td className="r">
                                          <b>{row.to}</b>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                  <p className="small muted">Your other cards, your monthly budget and the payments you recorded are kept. Payments already included in the balance you enter are not taken off again.</p>
                  <div className="actions">
                    <button type="button" className="btn" disabled={!ready} onClick={applyToPlan}>
                      Apply to my plan
                    </button>
                    <button type="button" className="btn ghost" onClick={() => { setCards([]); setNotes([]); }}>
                      Clear
                    </button>
                    <button type="button" className="link small" onClick={useCards}>
                      Start a new plan with these cards instead
                    </button>
                  </div>
                </div>
              ) : (
                <div className="actions">
                  <button type="button" className="btn" onClick={useCards}>
                    Check and use these cards
                  </button>
                  <button type="button" className="btn ghost" onClick={() => { setCards([]); setNotes([]); }}>
                    Clear
                  </button>
                  {!table && cards.length < IMPORT_MAX && <span className="small muted">Drop another statement to add a card.</span>}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
