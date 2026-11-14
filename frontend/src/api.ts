// Types mirror backend/app/schemas.py and the dict returned by engine.build_plan.
//
// Periods: every schedule row is one PAYMENT CYCLE, a rolling month from the plan's start date
// (for a plan started Nov 14: Nov 14 - Dec 13). Each card is paid once per cycle on its due day.

export type Strategy = "avalanche" | "snowball";
export type Goal = "less_interest" | "faster_payoff" | "future_loan" | "tight_budget";

export interface Card {
  id: string;
  name: string;
  balance: number;
  minimum: number;
  apr: number | null;
  due_day: number | null;
  limit: number | null;
}

export interface Inputs {
  goal: Goal;
  budget: number;
  strategy: Strategy;
  cards: Card[];
}

export interface Payment {
  card_id: string;
  minimum: number;
  extra: number;
  total: number;
  /** ISO date of this payment's due date, or null when the card has no due day. */
  due: string | null;
}

export interface CycleRow {
  index: number;
  period_start: string;
  period_end: string;
  payments: Payment[];
  interest: number;
  balances: Record<string, number>;
  total_balance: number;
}

export interface Comparison {
  strategy: "avalanche" | "snowball" | "minimum";
  status: string;
  /** number of payment cycles */
  months: number | null;
  debt_free_month: string | null;
  total_interest: number | null;
  payoff_month: Record<string, string>;
  first_cleared: { card_id: string; month: string } | null;
}

export interface LimitUse {
  cards: { card_id: string; limit: number; balance: number; now_pct: number; after_balance: number | null; after_pct: number | null }[];
  /** names of cards with no credit limit entered */
  missing: string[];
  /** true only when every card entered has a limit; the combined figures exist only then */
  complete: boolean;
  /** last day of the third payment cycle, which the "after" figures refer to */
  after_date: string | null;
  total_limit: number | null;
  now_pct: number | null;
  after_pct: number | null;
}

export interface Plan {
  status: "ok" | "shortfall" | "no_debt" | "apr_unknown" | "not_converging";
  strategy: Strategy;
  budget: number;
  cycle: { index: number; period_start: string; period_end: string };
  cards: Card[];
  total_debt: number;
  minimums_total: number;
  above_minimums: number;
  shortfall: number;
  this_cycle: Payment[];
  assumptions: string[];
  missing: string[];
  forecast: null | {
    /** number of payment cycles until every card is cleared */
    months: number;
    /** month of the very last payment, by its due date */
    debt_free_month: string;
    total_interest: number;
    payoff_month: Record<string, string>;
    payoff_cycle: Record<string, number>;
    balance_by_cycle: number[];
    cycle_ends: string[];
  };
  /** the next three payment cycles */
  cycles: CycleRow[];
  comparison: Comparison[];
  limit_use: LimitUse;
}

export interface ScenarioParams {
  scenario_budget?: number;
  apr_overrides?: Record<string, number>;
}

export interface CallScript {
  source: "ai" | "template";
  lines: { step: string; label: string; say: string }[];
  questions: string[];
  disclaimer: string;
}

const TIMEOUT_MS = 12000; // never leave the person waiting indefinitely

/** A failure with a message written for the person, sent by the server (for example an unreadable file). */
export class ApiProblem extends Error {}

async function post(url: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: abort.signal });
    if (!res.ok) {
      const detail = await res.json().then((j) => j?.detail).catch(() => null);
      if (res.status < 500 && typeof detail === "string") throw new ApiProblem(detail);
      throw new Error(`${url} answered ${res.status}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export const calculatePlan = async (inputs: Inputs): Promise<Plan> => (await post("/api/plan/calculate", inputs)).json();

export const runScenario = async (inputs: Inputs, params: ScenarioParams): Promise<{ baseline: Plan; scenario: Plan }> =>
  (await post("/api/plan/scenario", { ...inputs, ...params })).json();

export const getCallScript = async (card: Card, plannedPayment: number): Promise<CallScript> =>
  (
    await post("/ai/call-script", {
      card_name: card.name,
      balance: card.balance,
      apr: card.apr,
      minimum: card.minimum,
      planned_payment: plannedPayment,
    })
  ).json();

/** Downloads the due dates of the next three payment cycles as an .ics file. */
export async function downloadCalendar(inputs: Inputs): Promise<void> {
  const blob = await (await post("/api/plan/calendar", inputs)).blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "finpilot-due-dates.ics";
  a.click();
  URL.revokeObjectURL(url);
}

/** A card as read from a file or statement, before the person has checked it. */
export type ImportedCard = Omit<Card, "id">;

export interface ImportResult {
  cards: ImportedCard[];
  notes: string[];
  /** "file" = read from a spreadsheet, "ai" = read by AI and checked, "patterns" = matched by label */
  source: string;
}

const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("could not read the file"));
    reader.readAsDataURL(file);
  });

/** Cards from a CSV or Excel sheet. Plain parsing on the server, no AI. */
export async function importTable(file: File): Promise<ImportResult> {
  const body = { filename: file.name, content_base64: await fileToBase64(file) };
  const out = await (await post("/api/import/table", body)).json();
  return { cards: out.cards, notes: out.notes, source: "file" };
}

/** One card from a statement: pasted text or a PDF. Reading with AI can take a while, so the timeout is longer. */
export async function extractStatement(input: { text: string } | { file: File }): Promise<ImportResult> {
  const body = "text" in input ? { text: input.text } : { pdf_base64: await fileToBase64(input.file) };
  const out = await (await post("/ai/extract-statement", body, 60000)).json();
  return { cards: [out.card], notes: out.notes, source: out.source };
}
