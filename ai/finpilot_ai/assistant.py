"""The FinPilot assistant: a chat model that can do what the screens do.

The model never calculates. It calls tools; every tool either reads the plan from the payoff engine
or changes the person's inputs under the same checks the forms apply. The reply carries the changed
inputs and a list of what was done, so the app can show each action and let the person undo it.

`calc` and `scenario` are passed in (they call the backend), which keeps this module free of I/O
and lets tests run it with a scripted model.
"""
from __future__ import annotations

import copy
import json
import uuid
from datetime import date, timedelta
from typing import Callable

from . import llm

MAX_ROUNDS = 6
MAX_CARDS = 3
PAGES = {"plan": "plan", "schedule": "schedule", "compare": "forecast", "what-if": "what-if", "bank call": "bank", "balances": "update", "import": "import", "your data": "data", "account": "account"}

SYSTEM = """You are FinPilot's assistant inside a credit card payoff planner. You help one person understand and change their own plan.

How to work:
- Never calculate or guess figures. Every number you state must come from a tool result in this conversation. Call get_plan before you describe the plan, and again after you change something.
- To do something the person asks (change the budget, mark a payment as paid, update a balance, rename a card, switch strategy, open a page), call the matching tool. Do not tell them to do it by hand when a tool exists.
- Do exactly what was asked, once. Ask first before removing a card.
- If a tool returns an error, tell the person what was wrong in plain words and what you need.
- Use ask_expert only for a question that needs careful multi-step reasoning about their situation. It is slow and costs money.
- You are not a licensed financial advisor. Explain what the plan does and what a change would do; do not recommend financial products, and do not promise results. The plan is an estimate.
- Be brief: two or three short sentences, plain words, dollar amounts as the tools give them. Reply in the language the person writes in."""


def _fn(name: str, description: str, properties: dict | None = None, required: list[str] | None = None) -> dict:
    return {"type": "function", "function": {"name": name, "description": description, "parameters": {"type": "object", "properties": properties or {}, "required": required or []}}}


_CARD = {"type": "string", "description": "The card's name as shown in the plan, for example Card A"}
_MONEY = {"type": "number", "description": "Dollars"}

TOOLS = [
    _fn("get_plan", "The current plan: what to pay on each card this month and when, what is already paid, the last-payment month, total interest, and each card's details."),
    _fn("set_budget", "Change the monthly budget for all cards together (minimum payments included).", {"amount": _MONEY}, ["amount"]),
    _fn("set_strategy", "Choose where extra money goes first.", {"strategy": {"type": "string", "enum": ["highest_apr_first", "smallest_balance_first"]}}, ["strategy"]),
    _fn("update_card", "Change details of an existing card. Only pass the fields that change.", {
        "card": _CARD, "name": {"type": "string"}, "balance": _MONEY, "apr": {"type": "number", "description": "Purchase APR in percent"},
        "minimum": _MONEY, "due_day": {"type": "integer", "description": "Day of the month, 1-31"}, "limit": _MONEY}, ["card"]),
    _fn("add_card", "Add a card that carries a balance and is charged regular purchase interest.", {
        "name": {"type": "string"}, "balance": _MONEY, "apr": {"type": "number"}, "minimum": _MONEY,
        "due_day": {"type": "integer"}, "limit": _MONEY}, ["name", "balance", "minimum"]),
    _fn("remove_card", "Remove a card from the plan. Only after the person confirmed.", {"card": _CARD}, ["card"]),
    _fn("mark_paid", "Record a payment the person already made on a card. Lowers that card's balance by the amount.", {
        "card": _CARD, "amount": _MONEY, "date": {"type": "string", "description": "ISO date the payment was made; omit for today"}}, ["card", "amount"]),
    _fn("set_this_month_total", "Use a different total for this month only (a bonus, or a short month). The monthly budget is unchanged from next month.", {"amount": _MONEY}, ["amount"]),
    _fn("clear_this_month_total", "Go back to the usual monthly budget for this month."),
    _fn("preview_budget", "What a different monthly budget would do, without changing anything: new last-payment month and interest.", {"amount": _MONEY}, ["amount"]),
    _fn("preview_extra_this_month", "What a one-time extra payment this month would do, without changing anything.", {"amount": _MONEY}, ["amount"]),
    _fn("open_page", "Show the person a page of the app.", {"page": {"type": "string", "enum": list(PAGES)}}, ["page"]),
    _fn("ask_expert", "Ask a stronger model one hard question about this person's plan. Use rarely.", {"question": {"type": "string"}}, ["question"]),
]


def _money(v: float) -> str:
    return f"${v:,.0f}" if float(v).is_integer() else f"${v:,.2f}"


def _upcoming_due(card: dict, today: date) -> date | None:
    nd = card.get("next_due")
    if nd and nd >= today.isoformat():
        return date.fromisoformat(nd)
    day = card.get("due_day")
    if not day:
        return None

    def on(y: int, m: int) -> date:
        last = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)).day
        return date(y, m, min(day, last))

    first = on(today.year, today.month)
    if first >= today:
        return first
    return on(today.year + (today.month == 12), today.month % 12 + 1)


def paid_toward(card: dict, payments: list[dict], today: date) -> float:
    """Recorded payments that count toward the card's upcoming due date: made in the month before it."""
    end = _upcoming_due(card, today) or today
    month, year = (end.month - 1) or 12, end.year - (end.month == 1)
    last = (date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)).day
    start = date(year, month, min(end.day, last))
    return round(sum(p["amount"] for p in payments if p.get("card_id") == card["id"] and start.isoformat() < p.get("date", "") <= end.isoformat()), 2)


def wire(inputs: dict, today: date) -> dict:
    """The inputs as the plan API accepts them (same rules as the web app)."""
    payments = inputs.get("payments") or []
    cards = []
    for c in inputs.get("cards", []):
        cards.append({**c, "treatment": c.get("treatment") or "unsure", "next_due": c.get("next_due") or None, "promo_end": c.get("promo_end") or None, "paid": paid_toward(c, payments, today)})
    out = {k: v for k, v in inputs.items() if k not in ("payments", "cards")}
    return {**out, "cards": cards}


def summary(plan: dict) -> dict:
    """What the model is allowed to quote from: a compact, labelled view of the plan."""
    names = {c["id"]: c["name"] for c in plan.get("cards", [])}
    f = plan.get("forecast") or {}
    return {
        "status": plan.get("status"),
        "monthly_budget": plan.get("budget"),
        "total_owed": plan.get("total_debt"),
        "minimum_payments_total": plan.get("minimums_total"),
        "short_of_minimums_by": plan.get("shortfall") or 0,
        "already_paid_this_month": plan.get("paid_this_cycle", 0),
        "pay_this_month": [{"card": names.get(p["card_id"], p["card_id"]), "amount": p["total"], "minimum_part": p["minimum"], "extra_part": p["extra"], "due": p.get("due")} for p in plan.get("this_cycle", [])],
        "last_payment_month": f.get("debt_free_month"),
        "monthly_payments_left": f.get("months"),
        "total_interest_estimate": f.get("total_interest"),
        "strategy": "highest_apr_first" if plan.get("strategy") == "avalanche" else "smallest_balance_first",
        "cards": [{"name": c["name"], "balance": c["balance"], "apr": c.get("apr"), "minimum": c["minimum"], "due_day": c.get("due_day"), "limit": c.get("limit")} for c in plan.get("cards", [])],
        "cards_not_forecast": plan.get("blocked_by") or [],
        "note": "All figures are estimates from a monthly interest model.",
    }


class _Stop(Exception):
    """A tool refused the request; the message goes back to the model."""


def run(messages: list[dict], inputs: dict, calc: Callable[[dict], dict], scenario: Callable[[dict, dict], dict],
        chat: Callable[..., dict] = llm.chat, today: date | None = None) -> dict:
    today = today or date.today()
    state = copy.deepcopy(inputs)
    actions: list[dict] = []
    navigate: str | None = None
    expert_used = False

    def card_of(ref: str) -> dict:
        ref = (ref or "").strip().lower()
        for c in state["cards"]:
            if c["id"].lower() == ref or c["name"].strip().lower() == ref:
                return c
        raise _Stop(f"No card called {ref!r}. Cards: {', '.join(c['name'] for c in state['cards'])}.")

    def plan_now() -> dict:
        return calc(wire(state, today))

    def did(text: str) -> None:
        actions.append({"summary": text})

    def tool(name: str, a: dict) -> dict:
        nonlocal navigate, expert_used
        if name == "get_plan":
            return summary(plan_now())
        if name == "set_budget":
            amount = float(a["amount"])
            if not 0 < amount <= 1_000_000:
                raise _Stop("The budget must be above $0.")
            old = state["budget"]
            state["budget"] = round(amount, 2)
            state["first_month_budget"] = None
            did(f"Monthly budget {_money(old)} → {_money(amount)}")
            return summary(plan_now())
        if name == "set_strategy":
            new = "avalanche" if a["strategy"] == "highest_apr_first" else "snowball"
            state["strategy"] = new
            did("Extra goes to the highest APR first" if new == "avalanche" else "Extra goes to the smallest balance first")
            return summary(plan_now())
        if name == "update_card":
            c = card_of(a["card"])
            changed = []
            for field, label in (("name", "name"), ("balance", "balance"), ("apr", "APR"), ("minimum", "minimum"), ("due_day", "due day"), ("limit", "limit")):
                if field not in a or a[field] is None:
                    continue
                v = a[field]
                if field == "name":
                    v = str(v).strip()[:40]
                    if not v:
                        raise _Stop("The card needs a name.")
                elif field == "apr" and not 0 <= float(v) <= 100:
                    raise _Stop("The APR must be between 0 and 100.")
                elif field == "due_day" and not 1 <= int(v) <= 31:
                    raise _Stop("The due day must be between 1 and 31.")
                elif field in ("balance", "minimum") and float(v) < 0:
                    raise _Stop(f"The {label} cannot be below $0.")
                elif field == "limit" and float(v) <= 0:
                    raise _Stop("The limit must be above $0.")
                old = c.get(field)
                c[field] = v if field == "name" else (int(v) if field == "due_day" else round(float(v), 2))
                if field == "due_day":
                    c["next_due"] = None
                changed.append(f"{label} {old} → {c[field]}")
            if not changed:
                raise _Stop("Nothing to change was given.")
            did(f"{c['name']}: " + ", ".join(changed))
            return summary(plan_now())
        if name == "add_card":
            if len(state["cards"]) >= MAX_CARDS:
                raise _Stop(f"This version plans up to {MAX_CARDS} cards.")
            if float(a["balance"]) < 0 or float(a["minimum"]) < 0:
                raise _Stop("Amounts cannot be below $0.")
            apr = a.get("apr")
            if apr is not None and not 0 <= float(apr) <= 100:
                raise _Stop("The APR must be between 0 and 100.")
            card = {"id": f"card-{uuid.uuid4().hex[:6]}", "name": str(a["name"]).strip()[:40] or "Card", "balance": round(float(a["balance"]), 2),
                    "minimum": round(float(a["minimum"]), 2), "apr": None if apr is None else float(apr), "due_day": a.get("due_day"),
                    "limit": a.get("limit"), "treatment": "revolving"}
            state["cards"].append(card)
            did(f"Added {card['name']} ({_money(card['balance'])})")
            return summary(plan_now())
        if name == "remove_card":
            c = card_of(a["card"])
            if len(state["cards"]) == 1:
                raise _Stop("The plan needs at least one card.")
            state["cards"] = [x for x in state["cards"] if x["id"] != c["id"]]
            state["payments"] = [p for p in state.get("payments") or [] if p.get("card_id") != c["id"]]
            did(f"Removed {c['name']}")
            return summary(plan_now())
        if name == "mark_paid":
            c = card_of(a["card"])
            amount = round(float(a["amount"]), 2)
            when = a.get("date") or today.isoformat()
            try:
                date.fromisoformat(when)
            except ValueError as exc:
                raise _Stop("The date must look like 2026-11-22.") from exc
            if amount <= 0 or amount > c["balance"] + 0.005:
                raise _Stop(f"The amount must be above $0 and not more than the {_money(c['balance'])} balance.")
            if when > today.isoformat():
                raise _Stop("A payment can only be marked as paid on or before today.")
            c["balance"] = round(max(0.0, c["balance"] - amount), 2)
            state.setdefault("payments", [])
            state["payments"] = (state["payments"] or []) + [{"id": uuid.uuid4().hex[:8], "card_id": c["id"], "amount": amount, "date": when}]
            did(f"{_money(amount)} marked as paid on {c['name']}")
            return summary(plan_now())
        if name == "set_this_month_total":
            amount = float(a["amount"])
            if amount <= 0:
                raise _Stop("The amount must be above $0.")
            state["first_month_budget"] = round(amount, 2)
            plan = plan_now()
            if plan.get("status") == "shortfall":
                state["first_month_budget"] = None
                raise _Stop(f"That is {_money(plan.get('shortfall') or 0)} short of the minimum payments, so it cannot be applied. The person should call the issuer before the due date.")
            did(f"This month only: {_money(amount)} in total")
            return summary(plan)
        if name == "clear_this_month_total":
            state["first_month_budget"] = None
            did("This month is back to the usual budget")
            return summary(plan_now())
        if name in ("preview_budget", "preview_extra_this_month"):
            params = {"scenario_budget": float(a["amount"])} if name == "preview_budget" else {"one_time": float(a["amount"])}
            out = scenario(wire(state, today), params)
            return {"now": summary(out["baseline"]), "with_change": summary(out["scenario"]), "nothing_was_changed": True}
        if name == "open_page":
            navigate = PAGES.get(a["page"], "plan")
            return {"opened": a["page"]}
        if name == "ask_expert":
            if expert_used:
                raise _Stop("The expert was already asked once in this turn.")
            expert_used = True
            answer = chat([
                {"role": "system", "content": "You answer one question about a person's credit card payoff plan. Use only the figures given. No product recommendations. Under 120 words."},
                {"role": "user", "content": f"Plan:\n{json.dumps(summary(plan_now()))}\n\nQuestion: {a['question']}"},
            ], tier="hard", max_tokens=500)
            return {"answer": answer["content"], "answered_by": answer["model"]}
        raise _Stop(f"There is no tool called {name}.")

    convo = [{"role": "system", "content": SYSTEM + f"\nToday is {today.isoformat()}."}] + [{"role": m["role"], "content": str(m["content"])[:4000]} for m in messages[-14:] if m.get("role") in ("user", "assistant")]
    model = ""
    reply = ""
    for _ in range(MAX_ROUNDS):
        out = chat(convo, tools=TOOLS)
        model = out["model"]
        if not out["tool_calls"]:
            reply = out["content"]
            break
        convo.append({"role": "assistant", "content": out["content"] or "", "tool_calls": out["tool_calls"]})
        for call in out["tool_calls"]:
            fn = call.get("function", {})
            try:
                args = json.loads(fn.get("arguments") or "{}")
                result = tool(fn.get("name", ""), args if isinstance(args, dict) else {})
            except _Stop as stop:
                result = {"error": str(stop)}
            except (KeyError, TypeError, ValueError) as exc:
                result = {"error": f"The request was not understood ({type(exc).__name__}). Check the arguments."}
            convo.append({"role": "tool", "tool_call_id": call.get("id", ""), "content": json.dumps(result)[:6000]})
    else:
        reply = "I did what I could, but stopped before finishing. Please check the plan and tell me what is still missing."
    changed = state != inputs
    return {"reply": reply or "Done.", "inputs": state if changed else None, "actions": actions, "navigate": navigate, "model": model}
