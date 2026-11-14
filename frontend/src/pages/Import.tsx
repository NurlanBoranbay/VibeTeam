import { useState } from "react";
import { ApiProblem, extractStatement, importTable, type ImportedCard } from "../api";
import { money } from "../format";
import { useStore } from "../store";
import { go, PageHead } from "../ui";

type SourceId = "table" | "paste" | "pdf";

// Inner ring: sources that work today. Outer ring: planned, not built.
const LIVE: { id: SourceId; label: string; icon: string }[] = [
  { id: "table", label: "Excel or CSV", icon: "M3 5h18v14H3zM3 10h18M3 15h18M9 5v14M15 5v14" },
  { id: "paste", label: "Paste a statement", icon: "M5 4h14v16H5zM8 9h8M8 13h8M8 17h5" },
  { id: "pdf", label: "Statement PDF", icon: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 14h8M8 18h5" },
];
const SOON: { label: string; icon: string }[] = [
  { label: "Google Sheets", icon: "M4 4h16v16H4zM4 12h16M12 4v16" },
  { label: "Notion", icon: "M6 3h12v18H6zM9 7h6M9 11h6M3 7h3M3 12h3M3 17h3" },
  { label: "Gmail", icon: "M3 6h18v12H3zM3 7l9 7 9-7" },
  { label: "Photo of a statement", icon: "M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" },
  { label: "Bank connection", icon: "M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" },
];
const IMPORT_MAX = 3;

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

const Icon = ({ d }: { d: string }) => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const SOURCE_NOTE: Record<string, string> = {
  file: "Read directly from your file. No AI was used.",
  ai: "Read by AI. Every figure was checked against the statement text; anything not found there was left empty.",
  patterns: "Read by matching the standard statement labels. No AI was used.",
};

export default function ImportPage() {
  const { setPrefill } = useStore();
  const [active, setActive] = useState<SourceId | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cards, setCards] = useState<ImportedCard[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [source, setSource] = useState("");

  async function run(job: () => Promise<{ cards: ImportedCard[]; notes: string[]; source: string }>, append: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await job();
      const merged = append ? [...cards, ...result.cards] : result.cards;
      const extra = merged.length > IMPORT_MAX ? [`This version plans up to ${IMPORT_MAX} cards, so only the first ${IMPORT_MAX} are kept.`] : [];
      setCards(merged.slice(0, IMPORT_MAX));
      setNotes([...result.notes, ...extra]);
      setSource(result.source);
    } catch (e) {
      setError(e instanceof ApiProblem ? e.message : "We couldn’t read that. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const useCards = () => {
    setPrefill(cards.map((c, i) => ({ ...c, id: `card-${i}-${Math.random().toString(36).slice(2, 7)}` })));
    go("setup/3");
  };

  return (
    <main className="page">
      <PageHead title="Bring your cards in">Skip the typing. Pick a source in the inner ring and FinPilot fills in your cards for you to check. Nothing is saved, and you confirm every number before a plan is built.</PageHead>

      <div className="split import">
        <section className="orbit" aria-label="Import sources">
          <span className="orbit-ring outer" aria-hidden="true" />
          <span className="orbit-ring inner" aria-hidden="true" />
          <span className="orbit-core" aria-hidden="true">
            F
          </span>
          {LIVE.map((s, i) => (
            <button key={s.id} type="button" className={`orbit-item live ${active === s.id ? "on" : ""}`} style={at(-90 + i * 120, 25)} aria-pressed={active === s.id} onClick={() => { setActive(s.id); setError(""); }}>
              <span className="orbit-icon">
                <Icon d={s.icon} />
                <i aria-hidden="true" />
              </span>
              <span className="orbit-label">{s.label}</span>
            </button>
          ))}
          {SOON.map((s, i) => (
            <div key={s.label} className="orbit-item soon" style={at(-54 + i * 72, 43)}>
              <span className="orbit-icon">
                <Icon d={s.icon} />
              </span>
              <span className="orbit-label">
                {s.label}
                <small>Soon</small>
              </span>
            </div>
          ))}
        </section>

        <section className="stack">
          <div className="row start">
            <span className="pill ok-pill">Inner ring · works now</span>
            <span className="pill">Outer ring · coming soon</span>
          </div>

          {active === null && <p className="lede">Choose Excel or CSV, a pasted statement, or a statement PDF.</p>}

          {active === "table" && (
            <div className="panel stack tight">
              <h2>Excel or CSV</h2>
              <p className="muted">One row per card. Headings are matched by name, in any order: Card, Balance, APR, Minimum, Due day, Limit. Only Balance is required.</p>
              <div className="field">
                <label htmlFor="imp-table">Choose a .csv or .xlsx file</label>
                <input id="imp-table" type="file" accept=".csv,.xlsx,.xlsm" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) run(() => importTable(f), false); e.target.value = ""; }} />
              </div>
            </div>
          )}

          {active === "paste" && (
            <div className="panel stack tight">
              <h2>Paste a statement</h2>
              <p className="muted">Paste the summary part of one card’s statement: balance, minimum payment, due date and interest rates. Leave out your name and account number.</p>
              <div className="field">
                <label htmlFor="imp-text">Statement text</label>
                <textarea id="imp-text" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="New Balance $1,500.00 …" />
              </div>
              <div className="actions">
                <button type="button" className="btn" disabled={busy || text.trim().length < 40} onClick={() => run(() => extractStatement({ text }), true)}>
                  Read this statement
                </button>
                <button type="button" className="btn ghost" disabled={busy} onClick={() => setText(SAMPLE)}>
                  Use a sample statement
                </button>
              </div>
            </div>
          )}

          {active === "pdf" && (
            <div className="panel stack tight">
              <h2>Statement PDF</h2>
              <p className="muted">Upload one card’s statement as a PDF downloaded from your bank. Scanned pages without text can’t be read; paste the text instead.</p>
              <div className="field">
                <label htmlFor="imp-pdf">Choose a .pdf file</label>
                <input id="imp-pdf" type="file" accept=".pdf,application/pdf" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) run(() => extractStatement({ file: f }), true); e.target.value = ""; }} />
              </div>
            </div>
          )}

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
              <div className="actions">
                <button type="button" className="btn" onClick={useCards}>
                  Check and use these cards
                </button>
                <button type="button" className="btn ghost" onClick={() => { setCards([]); setNotes([]); }}>
                  Clear
                </button>
                {active !== "table" && cards.length < IMPORT_MAX && <span className="small muted">Read another statement to add a card.</span>}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
