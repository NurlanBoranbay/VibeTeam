// Types mirror backend/app/schemas.py and the dict returned by engine.build_plan.

export type Strategy = "avalanche" | "snowball";

export interface CardIn {
  id?: string;
  name: string;
  balance: number;
  minimum: number;
  apr: number | null;
  due_day?: number | null;
  limit?: number | null;
}

export interface PlanIn {
  budget: number;
  strategy: Strategy;
  start?: string;
  cards: CardIn[];
}

export interface Payment {
  card_id: string;
  minimum: number;
  extra: number;
  total: number;
}

export interface Plan {
  status: "ok" | "shortfall" | "no_debt" | "apr_unknown" | "not_converging";
  budget: number;
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
  };
  comparison: { strategy: string; status: string; months: number | null; debt_free_month: string | null; total_interest: number | null }[];
}

export interface CallScript {
  source: "ai" | "template";
  lines: { step: string; label: string; say: string }[];
  questions: string[];
  disclaimer: string;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Request to ${url} failed with status ${res.status}`);
  return res.json() as Promise<T>;
}

export const calculatePlan = (plan: PlanIn) => post<Plan>("/api/plan/calculate", plan);

export const getCallScript = (card: CardIn, plannedPayment: number) =>
  post<CallScript>("/ai/call-script", {
    card_name: card.name,
    balance: card.balance,
    apr: card.apr,
    minimum: card.minimum,
    planned_payment: plannedPayment,
  });
