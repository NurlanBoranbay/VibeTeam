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

const NAV: [string, string][] = [
  ["plan", "Plan"],
  ["schedule", "Schedule"],
  ["forecast", "Compare"],
  ["what-if", "What if"],
  ["bank", "Bank call"],
  ["update", "Balances"],
];

export function TopNav({ route }: { route: string }) {
  const { isDemo, inputs } = useStore();
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
        {isDemo && <span className="pill">Demo example</span>}
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
export function SplitBar({ payment, max }: { payment: Payment; max: number }) {
  const scale = max > 0 ? 100 / max : 0;
  return (
    <span className="bar" role="img" aria-label={`${payment.minimum} minimum, ${payment.extra} extra`}>
      <span className="bar-min" style={{ width: `${payment.minimum * scale}%` }} />
      <span className="bar-extra" style={{ width: `${payment.extra * scale}%` }} />
    </span>
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
            <span>{card.apr === null ? "" : `${card.apr}% APR`}</span>
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

export function NumberField(props: {
  id: string;
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  hint?: string;
  help?: string;
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
        value={props.value ?? ""}
        onChange={(e) => props.onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
      {props.hint && <span className="small muted">{props.hint}</span>}
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
