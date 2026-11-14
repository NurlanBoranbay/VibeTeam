// Types mirror backend/app/schemas.py and the dict returned by engine.build_plan.

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

export interface MonthRow {
  month: string;
  payments: Payment[];
  interest: number;
  balances: Record<string, number>;
  total_balance: number;
}

export interface Comparison {
  strategy: "avalanche" | "snowball" | "minimum";
  status: string;
  months: number | null;
  debt_free_month: string | null;
  total_interest: number | null;
  payoff_month: Record<string, string>;
  first_cleared: { card_id: string; month: string } | null;
}

export interface LimitUse {
  cards: { card_id: string; limit: number; balance: number; now_pct: number; after_balance: number | null; after_pct: number | null }[];
  missing: string[];
  total_limit: number;
  now_pct: number | null;
  after_pct: number | null;
}

export interface Plan {
  status: "ok" | "shortfall" | "no_debt" | "apr_unknown" | "not_converging";
  strategy: Strategy;
  budget: number;
  start_month: string;
  cards: Card[];
  total_debt: number;
  minimums_total: number;
  above_minimums: number;
  shortfall: number;
  this_month: Payment[];
  assumptions: string[];
  missing: string[];
  forecast: null | {
    months: number;
    debt_free_month: string;
    total_interest: number;
    payoff_month: Record<string, string>;
    balance_by_month: number[];
    month_labels: string[];
  };
  ninety_days: MonthRow[];
  comparison: Comparison[];
  limit_use: LimitUse;
}

export interface ScenarioParams {
  scenario_budget?: number;
  one_time?: number;
  low_month_index?: number;
  low_month_budget?: number;
  apr_overrides?: Record<string, number>;
}

export interface CallScript {
  source: "ai" | "template";
  lines: { step: string; label: string; say: string }[];
  questions: string[];
  disclaimer: string;
}

async function post(url: string, body: unknown): Promise<Response> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res;
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

/** Downloads the next 90 days of due dates as an .ics file. */
export async function downloadCalendar(inputs: Inputs): Promise<void> {
  const blob = await (await post("/api/plan/calendar", inputs)).blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "finpilot-due-dates.ics";
  a.click();
  URL.revokeObjectURL(url);
}
