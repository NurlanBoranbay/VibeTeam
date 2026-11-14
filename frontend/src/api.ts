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
  /** How interest applies to this card, as the person confirmed it. null = not answered yet. */
  treatment?: Treatment | null;
  /** the balance includes a cash advance, transfer, deferred-interest purchase or installment plan */
  mixed?: boolean;
  /** a payment is overdue, or the account is under a special arrangement */
  past_due?: boolean;
  /** pay in full: recent statements paid in full and on time, with a grace period */
  grace?: "yes" | "no" | "unsure" | null;
  can_pay_full?: boolean;
  /** pay in full: the issuer's amount still to pay toward the latest statement (not the current balance) */
  statement_due?: number | null;
  promo_kind?: "intro_zero" | "deferred" | "transfer" | "unsure" | null;
  promo_end?: string | null;
  /** the actual next payment due date, ISO */
  next_due?: string | null;
  /** the minimum for the upcoming due date is already paid */
  min_paid?: boolean;
}

export type Treatment = "revolving" | "pay_in_full" | "promo" | "unsure";

/** How one card is handled by the plan. Only "revolving" cards are forecast. */
export interface CardStatus {
  card_id: string;
  name: string;
  kind: "revolving" | "paid_off" | "grace" | "review";
  code: string;
  title: string;
  message: string;
  amount: number | null;
  amount_label: string | null;
  due: string | null;
}

export interface Inputs {
  goal: Goal;
  budget: number;
  strategy: Strategy;
  cards: Card[];
  /** money still available for cards in the current month, when part of the budget is already spent */
  first_month_budget?: number | null;
}

export interface Payment {
  card_id: string;
  /** the part of the payment that counts toward the statement minimum; capped at what the card owes */
  minimum: number;
  extra: number;
  total: number;
  /** ISO date of this payment's due date, or null when the card has no due day. */
  due: string | null;
  /** the minimum payment the person entered, never changed by the plan */
  statement_minimum: number;
  /** true when this payment clears the card; `total` is then an estimated payoff amount */
  payoff: boolean;
  /** start_balance + interest - total = end_balance. Null when there is no forecast (an APR is missing). */
  start_balance: number | null;
  interest: number | null;
  end_balance: number | null;
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
  /** what this comparison pays each cycle: the budget, or only the minimums */
  payment_basis: number;
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
  /** "limited" and "pay_in_full": a card is outside the ordinary revolving model, so nothing is forecast */
  status: "ok" | "shortfall" | "no_debt" | "apr_unknown" | "not_converging" | "limited" | "pay_in_full";
  card_status: CardStatus[];
  /** cards that stop a complete forecast */
  blocked_by: string[];
  strategy: Strategy;
  budget: number;
  cycle: { index: number; period_start: string; period_end: string };
  cards: Card[];
  total_debt: number;
  minimums_total: number;
  above_minimums: number;
  shortfall: number;
  /** identical to cycles[0].payments whenever there is a forecast */
  this_cycle: Payment[];
  /** budget not placed on any card, because an APR is missing and the best card cannot be chosen */
  unallocated: number;
  /** names of cards with a balance and no APR */
  missing_apr: string[];
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
    /** every payment of the whole plan that has a due date */
    due_dates: { due: string; card_id: string; total: number; minimum: number; extra: number; end_balance: number | null; payoff: boolean }[];
  };
  /** the next three payment cycles */
  cycles: CycleRow[];
  comparison: Comparison[];
  limit_use: LimitUse;
}

export interface ScenarioParams {
  scenario_budget?: number;
  /** extra dollars paid in the first month only */
  one_time?: number;
  /** one month (1 = this month) with a different budget */
  low_month_index?: number;
  low_month_budget?: number;
  /** card id -> a purchase added to that card's balance */
  balance_add?: Record<string, number>;
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

/** What the API accepts: an unanswered card is sent as "unsure" (never forecast), and empty dates as null. */
const wire = (inputs: Inputs) => ({
  ...inputs,
  cards: inputs.cards.map((c) => ({ ...c, treatment: c.treatment ?? "unsure", next_due: c.next_due || null, promo_end: c.promo_end || null })),
});

export const calculatePlan = async (inputs: Inputs): Promise<Plan> => (await post("/api/plan/calculate", wire(inputs))).json();

export const runScenario = async (inputs: Inputs, params: ScenarioParams): Promise<{ baseline: Plan; scenario: Plan }> =>
  (await post("/api/plan/scenario", { ...wire(inputs), ...params })).json();

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
  const blob = await (await post("/api/plan/calendar", wire(inputs))).blob();
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

/** One card from a statement: pasted text, or a PDF, Word or plain-text file. Reading with AI can take a while, so the timeout is longer. */
export async function extractStatement(input: { text: string } | { file: File }): Promise<ImportResult> {
  let body: Record<string, string>;
  if ("text" in input) body = { text: input.text };
  else if (/\.pdf$/i.test(input.file.name)) body = { pdf_base64: await fileToBase64(input.file) };
  else if (/\.docx$/i.test(input.file.name)) body = { docx_base64: await fileToBase64(input.file) };
  else if (/\.(jpe?g|png|webp)$/i.test(input.file.name)) body = { image_base64: await fileToBase64(input.file), image_type: /\.png$/i.test(input.file.name) ? "image/png" : /\.webp$/i.test(input.file.name) ? "image/webp" : "image/jpeg" };
  else body = { text: await input.file.text() };
  const out = await (await post("/ai/extract-statement", body, 60000)).json();
  return { cards: [out.card], notes: out.notes, source: out.source };
}
