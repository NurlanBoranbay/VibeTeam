import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Card, Payment } from "./api";
import { money } from "./format";
import { useStore, type CardColors } from "./store";

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
  ["what-if", "What if"],
  ["bank", "Bank call"],
  ["update", "Balances"],
];

const DEMO_CHOICES = [
  { label: "Demo 1", note: "Three cards, $4,600 owed" },
  { label: "Demo 2", note: "One card nearly paid off" },
];

/** While a demo is open: one "Demo" control in the top bar; the demo actions sit in its menu. */
function DemoMenu({ index, load }: { index: number; load: (which?: number) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(".demo-menu")) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const pick = (which?: number) => {
    load(which);
    setOpen(false);
  };
  return (
    <div className="demo-menu">
      <button type="button" className="navlink demo-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <i aria-hidden="true" />
        Demo
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="demo-pop" role="menu" aria-label="Demo">
          <p className="demo-pop-title">You’re looking at an example</p>
          {DEMO_CHOICES.map((d, i) => (
            <button key={d.label} type="button" role="menuitemradio" aria-checked={i === index} className="demo-item" onClick={() => pick(i)}>
              <span>
                <b>{d.label}</b>
                <small>{d.note}</small>
              </span>
              {i === index && <em>Open</em>}
            </button>
          ))}
          <hr />
          <button type="button" role="menuitem" className="demo-item" onClick={() => pick()}>
            <span>
              <b>Reset demo</b>
              <small>Undo changes to {DEMO_CHOICES[index]?.label ?? "this demo"}</small>
            </span>
          </button>
          <hr />
          <a role="menuitem" className="demo-item demo-build" href="#/setup/1" onClick={() => setOpen(false)}>
            <span>
              <b>Build my plan</b>
              <small>Leave the demo and enter your own cards</small>
            </span>
          </a>
        </div>
      )}
    </div>
  );
}

/** The profile button at the far right of the top bar: sign-in or the account, and Your data. */
function ProfileMenu({ route }: { route: string }) {
  const { account, signOut, plus, isDemo } = useStore();
  const [open, setOpen] = useState(false);
  // any click outside the menu closes it; a click on one of its links closes it too
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const el = e.target as Element;
      if (!el.closest(".profile") || el.closest(".profile-menu a, .profile-menu button")) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  const here = route === "account" || route === "data" || route === "plus";
  return (
    <span className="profile">
      <button type="button" className={`profile-btn ${account ? "in" : ""} ${here ? "here" : ""}`} aria-haspopup="menu" aria-expanded={open} aria-label={account ? `Profile: ${account.email}` : "Profile"} onClick={() => setOpen(!open)}>
        {account ? (
          <b>{account.email[0].toUpperCase()}</b>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
          </svg>
        )}
      </button>
      {open && (
        <div className="profile-menu" role="menu">
          {account ? (
            <>
              <span className="profile-who">
                <span className="small muted">Signed in as</span>
                <b className="profile-email" title={account.email}>
                  {account.email}
                </b>
              </span>
              <a role="menuitem" href="#/account">
                Account
              </a>
            </>
          ) : (
            <>
              <span className="profile-who">
                <b>Not signed in</b>
                <span className="small muted">An account keeps your plan on any device.</span>
              </span>
              <a role="menuitem" href="#/account">
                Sign in or create an account
              </a>
            </>
          )}
          <a role="menuitem" href="#/plus" className="profile-plus">
            Plans
            <span className={plus && !isDemo ? "pill ok-tag" : "pill"}>{plus && !isDemo ? "Plus" : "Free"}</span>
          </a>
          <a role="menuitem" href="#/data">
            Your data
          </a>
          {account && (
            <button type="button" role="menuitem" onClick={() => signOut()}>
              Sign out
            </button>
          )}
        </div>
      )}
    </span>
  );
}

export function TopNav({ route }: { route: string }) {
  const { isDemo, inputs, loadDemo, demoIndex, account, chatOpen, setChatOpen } = useStore();
  return (
    <header className="top">
      <a className="logo" href="#/">
        <i>F</i>FinPilot
      </a>
      {/* every page link in one row, evenly spaced, right after the logo */}
      <nav aria-label="Main">
        {[...(inputs ? NAV : []), ...(isDemo || (account && inputs) ? [["import", "Import"]] : [])].map(([to, label]) => (
          <a key={to} href={`#/${to}`} aria-current={route === to ? "page" : undefined}>
            {label}
          </a>
        ))}
      </nav>
      <span className="top-right">
        {isDemo && <DemoMenu index={demoIndex} load={loadDemo} />}
        {inputs && (
          <button type="button" className={chatOpen ? "ai-btn on" : "ai-btn"} aria-pressed={chatOpen} aria-label="Assistant" title="Assistant" onClick={() => setChatOpen(!chatOpen)}>
            {/* one four-point star, centred on the button */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2Q13.2 10.8 22 12Q13.2 13.2 12 22Q10.8 13.2 2 12Q10.8 10.8 12 2Z" />
            </svg>
          </button>
        )}
        <ThemeToggle />
        {/* in the demo this action lives in the Demo menu, so the bar stays on one row */}
        {!isDemo && (
          <a className="btn" href="#/setup/1">
            {inputs ? "Edit plan" : "Build my plan"}
          </a>
        )}
        <ProfileMenu route={route} />
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
      <i className="bar-min" /> Minimum
      <i className="bar-extra" /> Extra
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

// Card faces drawn in CSS to match the product renders. The first three are the defaults, in card order;
// the person can give any card any face. `ink` is the text colour printed on the face.
const LIGHT_INK = { ink: "#f7f8f8", ink2: "#c9cbd0", ink3: "#a3a8b2" };
export const FACES = [
  { name: "Graphite", face: "linear-gradient(145deg, #26272c 0%, #0b0b0d 62%, #17181c 100%)", edge: "#3a3d44", glow: "#6e7bf2", ...LIGHT_INK },
  { name: "Titanium", face: "linear-gradient(120deg, #5a5e67 0%, #2a2c31 42%, #6a6e77 68%, #26282c 100%)", edge: "#6c7079", glow: "#f0a050", ...LIGHT_INK },
  { name: "Indigo", face: "linear-gradient(145deg, #3a41a0 0%, #12143a 68%, #232869 100%)", edge: "#4a54a8", glow: "#9aaaff", ...LIGHT_INK },
  { name: "Garnet", face: "linear-gradient(145deg, #7a1824 0%, #2c070c 64%, #511019 100%)", edge: "#93323d", glow: "#f7a1a3", ...LIGHT_INK },
  { name: "Pearl", face: "linear-gradient(145deg, #ffffff 0%, #e4e6eb 58%, #f7f8fa 100%)", edge: "#c3c7cf", glow: "#9aaaff", ink: "#15161a", ink2: "#474c56", ink3: "#666c77" },
  { name: "Plum", face: "linear-gradient(145deg, #57237f 0%, #1c0b2e 66%, #3a1857 100%)", edge: "#74409e", glow: "#c9a2ff", ...LIGHT_INK },
];

/** The CSS variables that paint a card face. */
export function faceStyle(f: number): Record<string, string> {
  const look = FACES[((f % FACES.length) + FACES.length) % FACES.length];
  return { "--face": look.face, "--edge": look.edge, "--glow": look.glow, "--ink": look.ink, "--ink-2": look.ink2, "--ink-3": look.ink3 };
}

/** Which face each card shows: its picked colour, else the first default no other card is using. */
export function resolveFaces(ids: string[], colors: CardColors): Record<string, number> {
  const out: Record<string, number> = {};
  const used = new Set<number>();
  for (const id of ids) {
    const c = colors[id];
    if (typeof c === "number" && c >= 0 && c < FACES.length && !used.has(c)) {
      out[id] = c;
      used.add(c);
    }
  }
  ids.forEach((id, i) => {
    if (out[id] !== undefined) return;
    let f = i % FACES.length;
    if (used.has(f)) f = FACES.findIndex((_, k) => !used.has(k));
    if (f < 0) f = i % FACES.length;
    out[id] = f;
    used.add(f);
  });
  return out;
}

/** Face index for a card id, among `cards` (default: the cards in the current plan). */
export function useFaces(cards?: { id: string }[]): (id: string, fallback?: number) => number {
  const { inputs, colors } = useStore();
  const list = cards ?? inputs?.cards ?? [];
  const faces = resolveFaces(
    list.map((c) => c.id),
    colors,
  );
  return (id, fallback = 0) => faces[id] ?? fallback;
}

/** Colour swatches for one card. Picking a colour another card has swaps the two cards' colours. */
export function CardColorPicker({ card, cards, compact }: { card: { id: string; name: string }; cards: { id: string; name: string }[]; compact?: boolean }) {
  const { colors, setColors } = useStore();
  const [swapped, setSwapped] = useState<string | null>(null);
  useEffect(() => {
    if (!swapped) return;
    const t = setTimeout(() => setSwapped(null), 3200);
    return () => clearTimeout(t);
  }, [swapped]);
  const ids = cards.map((c) => c.id);
  const faces = resolveFaces(ids, colors);
  const mine = faces[card.id] ?? 0;
  const owner = (f: number) => cards.find((c) => c.id !== card.id && faces[c.id] === f);
  const pick = (f: number) => {
    if (f === mine) return;
    const other = owner(f);
    const next: CardColors = { ...colors };
    for (const id of ids) next[id] = faces[id];
    next[card.id] = f;
    if (other) next[other.id] = mine;
    setColors(next);
    setSwapped(other ? `${other.name || "The other card"} took ${FACES[mine].name}` : null);
  };
  return (
    <div className={compact ? "color-pick compact" : "color-pick"}>
      <span className={compact ? "sr-only" : "color-pick-label"} id={`${card.id}-color`}>
        Card colour <b>{FACES[mine].name}</b>
      </span>
      <div className="swatches" role="radiogroup" aria-labelledby={`${card.id}-color`}>
        {FACES.map((f, i) => {
          const other = owner(i);
          return (
            <button
              key={f.name}
              type="button"
              role="radio"
              aria-checked={i === mine}
              className={other ? "swatch taken" : "swatch"}
              style={faceStyle(i) as CSSProperties}
              title={other ? `${f.name}, on ${other.name || "another card"}: picking it swaps colours` : f.name}
              aria-label={other ? `${f.name}, used by ${other.name || "another card"}; picking it swaps colours` : f.name}
              onClick={() => pick(i)}
            />
          );
        })}
      </div>
      <span className="small muted color-pick-note" aria-live="polite">
        {swapped ?? (compact ? "" : "A colour already on another card swaps with it.")}
      </span>
    </div>
  );
}

/** A picture of one card, the same face it has on the Balances page. It shows whatever the card holds right now. */
export function CardFace({ card, index, zoom, cards }: { card: Card; index: number; zoom?: number; cards?: { id: string }[] }) {
  const faceOf = useFaces(cards);
  return (
    <span className="hero-card" style={{ ...faceStyle(faceOf(card.id, Math.max(0, index))), "--shine-delay": "0s", zoom: zoom ?? 0.52 } as CSSProperties} aria-hidden="true">
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

/** Stands in for a feature that is part of Plus, with the way to get it. */
export function PlusLock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel stack tight plus-lock">
      <span className="pill ok-tag">Plus</span>
      <h2>{title}</h2>
      <p className="muted">{children}</p>
      <a className="btn" href="#/plus">
        See Plus
      </a>
    </section>
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
        <button type="button" className="btn ghost" onClick={() => loadDemo()}>
          Open the demo example
        </button>
      </div>
    </main>
  );
}
