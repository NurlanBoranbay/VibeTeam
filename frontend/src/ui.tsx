import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Card, Payment } from "./api";
import { money } from "./format";
import { useStore } from "./store";

/** Current route, e.g. "plan" or "setup/2". Routes live in the URL hash: #/plan */
export function useRoute(): string {
  const read = () => window.location.hash.replace(/^#\/?/, "");
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => {
      setRoute(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export const go = (route: string) => {
  window.location.hash = `/${route}`;
};

type Theme = "light" | "dark";
const THEME_KEY = "finpilot.theme";

/** The saved choice, else the system setting. Applied to <html data-theme>, which styles.css keys off. */
function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // storage blocked: fall through to the system setting
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const t = initialTheme();
    document.documentElement.dataset.theme = t;
    return t;
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggle = () => {
    const next: Theme = theme === "light" ? "dark" : "light";
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // not saved; still switches for this visit
    }
    setTheme(next);
  };
  return [theme, toggle];
}

function ThemeToggle() {
  const [theme, toggle] = useTheme();
  const toLight = theme === "dark";
  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label={toLight ? "Switch to light theme" : "Switch to dark theme"} title={toLight ? "Light theme" : "Dark theme"}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {toLight ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : (
          <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />
        )}
      </svg>
    </button>
  );
}

const NAV: [string, string][] = [
  ["plan", "Plan"],
  ["schedule", "Schedule"],
  ["forecast", "Compare"],
  ["what-if", "What if"],
  ["bank", "Bank call"],
  ["update", "Balances"],
];

export function TopNav({ route }: { route: string }) {
  const { isDemo, inputs, loadDemo, demoIndex } = useStore();
  return (
    <header className="top">
      <a className="logo" href="#/">
        <i>F</i>FinPilot
      </a>
      {inputs && (
        <nav aria-label="Main">
          {NAV.map(([to, label]) => (
            <a key={to} href={`#/${to}`} aria-current={route === to ? "page" : undefined}>
              {label}
            </a>
          ))}
        </nav>
      )}
      <span className="top-right">
        <a href="#/import" aria-current={route === "import" ? "page" : undefined}>
          Import
        </a>
        <a href="#/data">Your data</a>
        {isDemo && (
          <>
            <span className="pill">Demo example</span>
            <button type="button" className="link small" onClick={() => loadDemo()}>
              Reset demo
            </button>
            <button type="button" className="link small" onClick={() => loadDemo(demoIndex + 1)}>
              {demoIndex === 0 ? "Demo 2" : "Demo 1"}
            </button>
          </>
        )}
        <ThemeToggle />
        <a className="btn" href="#/setup/1">
          {inputs && !isDemo ? "Edit plan" : "Build my plan"}
        </a>
      </span>
    </header>
  );
}

export function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: "ok" | "warn" | "danger" }) {
  return (
    <div className="panel stat">
      <span className="muted">{label}</span>
      <b>{value}</b>
      {note && <span className={`small ${tone ?? "muted"}`}>{note}</span>}
    </div>
  );
}

/** Minimum vs extra share of one payment, scaled against the largest payment shown. */
/**
 * One payment as a full-width bar: purple is the minimum, orange is the extra. Every card with a
 * payment gets the same bar. The amount is printed on a segment when it fits, and beside the bar
 * when the segment is too narrow, so figures never overlap.
 */
export function SplitBar({ payment }: { payment: Payment; max?: number }) {
  const total = payment.minimum + payment.extra;
  if (total <= 0) return null;
  const parts = [
    { key: "min", amount: payment.minimum, cls: "bar-min", name: "minimum" },
    { key: "extra", amount: payment.extra, cls: "bar-extra", name: "extra" },
  ].filter((x) => x.amount > 0);
  const share = (amount: number) => (amount / total) * 100;
  const outside = parts.filter((x) => share(x.amount) < 24);
  return (
    <span className="paybar" role="img" aria-label={`${money(payment.minimum)} minimum${payment.extra > 0 ? `, ${money(payment.extra)} extra` : ""}`}>
      <span className="bar tall">
        {parts.map((x) => (
          <span key={x.key} className={x.cls} style={{ width: `${share(x.amount)}%` }}>
            {share(x.amount) >= 24 && <b>{money(x.amount)}</b>}
          </span>
        ))}
      </span>
      {outside.length > 0 && (
        <span className="paybar-out">
          {outside.map((x) => (
            <span key={x.key} className={x.key}>
              {money(x.amount)} {x.name}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** One legend for every payment bar on the screen. */
export function PayLegend() {
  return (
    <p className="pay-legend small">
      <i className="bar-min" /> Purple = minimum payment
      <i className="bar-extra" /> Orange = extra payment
    </p>
  );
}

export function Meter({ value, tone }: { value: number; tone?: "danger" }) {
  return (
    <span className="bar" role="img" aria-label={`${Math.round(value)}%`}>
      <span className={tone === "danger" ? "bar-danger" : "bar-min"} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </span>
  );
}

// Card faces drawn in CSS to match the product renders: matte black, brushed titanium, deep indigo.
export const FACES = [
  { face: "linear-gradient(145deg, #26272c 0%, #0b0b0d 62%, #17181c 100%)", edge: "#3a3d44", glow: "#6e7bf2" },
  { face: "linear-gradient(120deg, #5a5e67 0%, #2a2c31 42%, #6a6e77 68%, #26282c 100%)", edge: "#6c7079", glow: "#f0a050" },
  { face: "linear-gradient(145deg, #3a41a0 0%, #12143a 68%, #232869 100%)", edge: "#4a54a8", glow: "#9aaaff" },
];

/** A picture of one card, the same face it has on the Balances page. It shows whatever the card holds right now. */
export function CardFace({ card, index, zoom }: { card: Card; index: number; zoom?: number }) {
  const look = FACES[Math.max(0, index) % FACES.length];
  return (
    <span className="hero-card" style={{ "--face": look.face, "--edge": look.edge, "--glow": look.glow, "--shine-delay": "0s", zoom: zoom ?? 0.52 } as CSSProperties} aria-hidden="true">
      <span className="fan-face">
        <span className="fan-content">
          <span className="fan-top">
            <b>{card.name || "Card"}</b>
            <span>{card.apr === null || (card.treatment && card.treatment !== "revolving") ? "" : `${card.apr}% APR`}</span>
          </span>
          <span className="fan-chip" />
          <span className="fan-bottom">
            <span>Balance</span>
            <b>{money(card.balance)}</b>
            <span>{card.due_day ? `Due day ${card.due_day}` : ""}</span>
          </span>
        </span>
      </span>
    </span>
  );
}

/** A small "?" next to a label. The explanation opens on hover or keyboard focus. */
export function Help({ text }: { text: string }) {
  return (
    <span className="help" tabIndex={0} role="note" aria-label={text}>
      ?<span className="help-pop">{text}</span>
    </span>
  );
}

const DF_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const two = (n: number) => String(n).padStart(2, "0");

/** "2026-11-14" -> "Nov 14, 2026" */
export const prettyDate = (v: string) => `${DF_MONTHS[Number(v.slice(5, 7)) - 1].slice(0, 3)} ${Number(v.slice(8, 10))}, ${v.slice(0, 4)}`;

/** A date picker drawn in the app's own style: a button that opens a small month grid. */
export function DateField({ id, label, value, onChange, max, help, clearable }: { id: string; label: string; value: string | null; onChange: (v: string | null) => void; max?: string; help?: string; clearable?: boolean }) {
  const now = new Date();
  const today = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState((value || today).slice(0, 7));
  const y = Number(view.slice(0, 4));
  const m = Number(view.slice(5, 7));
  const step = (by: number) => {
    const d = new Date(y, m - 1 + by, 1);
    setView(`${d.getFullYear()}-${two(d.getMonth() + 1)}`);
  };
  const lead = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();
  const pick = (v: string | null) => {
    onChange(v);
    setOpen(false);
  };
  return (
    <div
      className="field datefield"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <span className="field-label">
        <label htmlFor={id}>{label}</label>
        {help && <Help text={help} />}
      </span>
      <button
        id={id}
        type="button"
        className={value ? "date-btn" : "date-btn empty"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setView((value || today).slice(0, 7));
          setOpen(!open);
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 7h16v13H4zM4 11h16M8 4v4M16 4v4" />
        </svg>
        {value ? prettyDate(value) : "Choose a date"}
      </button>
      {open && (
        <div className="date-pop" role="dialog" aria-label={label}>
          <div className="date-head">
            <button type="button" className="due-arrow" aria-label="Earlier month" onClick={() => step(-1)}>
              ‹
            </button>
            <b>
              {DF_MONTHS[m - 1]} {y}
            </b>
            <button type="button" className="due-arrow" aria-label="Later month" disabled={max !== undefined && `${view}-31` >= max} onClick={() => step(1)}>
              ›
            </button>
          </div>
          <div className="due-grid">
            {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
              <span key={`h${i}`} className="due-head">
                {d}
              </span>
            ))}
            {Array.from({ length: lead }, (_, i) => (
              <span key={`e${i}`} />
            ))}
            {Array.from({ length: days }, (_, i) => {
              const v = `${view}-${two(i + 1)}`;
              return (
                <button key={v} type="button" className={`date-day ${v === value ? "on" : ""} ${v === today ? "today" : ""}`} disabled={max !== undefined && v > max} onClick={() => pick(v)}>
                  {i + 1}
                </button>
              );
            })}
          </div>
          <div className="date-foot">
            <button type="button" className="link small" disabled={max !== undefined && today > max} onClick={() => pick(today)}>
              Today
            </button>
            {clearable && value && (
              <button type="button" className="link small" onClick={() => pick(null)}>
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function NumberField(props: {
  id: string;
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  hint?: string;
  help?: string;
  /** shown under the field in red; the value is not accepted while it is set */
  error?: string;
  placeholder?: string;
  prefix?: string;
  step?: string;
  max?: number;
}) {
  return (
    <div className="field">
      <span className="field-label">
        <label htmlFor={props.id}>{props.label}</label>
        {props.help && <Help text={props.help} />}
      </span>
      <input
        id={props.id}
        type="number"
        inputMode="decimal"
        min={0}
        max={props.max}
        step={props.step ?? "0.01"}
        placeholder={props.placeholder}
        aria-invalid={props.error ? true : undefined}
        value={props.value ?? ""}
        onChange={(e) => props.onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
      {props.error ? (
        <span className="small danger" role="alert">
          {props.error}
        </span>
      ) : (
        props.hint && <span className="small muted">{props.hint}</span>
      )}
    </div>
  );
}

export const cardName = (cards: Card[], id: string) => cards.find((c) => c.id === id)?.name ?? id;

/** Background detail, closed by default so pages stay short. */
export function Fold({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="fold">
      <summary>{title}</summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

export function PageHead({ kicker, title, children, image }: { kicker?: ReactNode; title: ReactNode; children?: ReactNode; image?: string }) {
  return (
    <div className="head">
      <div className="head-text">
        {kicker && <span className="muted">{kicker}</span>}
        <h1>{title}</h1>
        {children && <p className="lede">{children}</p>}
      </div>
      {image && <img className="head-img" src={image} alt="" />}
    </div>
  );
}

/** Shown when a calculation failed and there is no earlier plan to fall back on. */
export function Problem({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="page">
      <PageHead title="We couldn’t calculate your plan">Please try again. Your numbers are still here.</PageHead>
      <div className="actions">
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
        <a className="btn ghost" href="#/setup/4">
          Check my numbers
        </a>
      </div>
    </main>
  );
}

/** Shown on plan pages when there is nothing to calculate from yet. */
export function Empty() {
  const { loadDemo } = useStore();
  return (
    <main className="page">
      <PageHead title="Nothing to show yet">This page is built from your cards and monthly budget. Enter them, or open the demo example to look around.</PageHead>
      <div className="actions">
        <a className="btn" href="#/setup/1">
          Build my plan
        </a>
        <button type="button" className="btn ghost" onClick={loadDemo}>
          Open the demo example
        </button>
      </div>
    </main>
  );
}
