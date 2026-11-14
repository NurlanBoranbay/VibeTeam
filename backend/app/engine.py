"""FinPilot payoff engine.

Pure functions, no I/O. All money is in dollars as floats rounded to cents at the edges.

Periods: every row of a schedule is one PAYMENT CYCLE, a rolling month that starts on the plan's
start date (cycle 1 = start .. start + 1 month - 1 day). Each card is paid once per cycle, on its
due day inside that window. Cycles are not calendar months: a plan started on Nov 14 has a first
cycle of Nov 14 - Dec 13, so a card due on the 5th is paid on Dec 5 in cycle 1.

Scope: the forecast is only for ordinary interest-bearing purchase balances (one known rate per card,
account current, no promotion). Every card states how it is treated (`Card.treatment`), as confirmed by
the person. A card that pays in full under a grace period, has promotional or mixed-rate balances, is
past due or is not classified is never pushed through the APR calculator: `build_plan` then returns a
"limited" plan with what is known about each card and no combined payoff date. See docs/model.md.

Model (shown to the user as assumptions):
- Interest is estimated once per payment cycle: balance * APR / 12, added before that cycle's payment.
  Payment dates inside a cycle do not change the interest in this model.
- Minimum payments stay at today's dollar amount unless a card's balance is lower. A minimum already
  paid for the upcoming due date (`min_paid`) is not scheduled again in cycle 1.
- No new purchases.
- Minimums are reserved first; what is left goes to one target card at a time
  (highest APR first, or smallest balance first). A cleared card's money rolls to the next.
- A payment never exceeds what is needed to clear the card.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from calendar import monthrange
from datetime import date, timedelta
from typing import Literal

Strategy = Literal["avalanche", "snowball", "minimum"]
MAX_MONTHS = 600
EPS = 0.005


@dataclass
class Card:
    id: str
    name: str
    balance: float
    minimum: float
    apr: float | None = None  # percent, e.g. 29.0. None = unknown
    due_day: int | None = None
    limit: float | None = None
    # How interest applies to this card, as confirmed by the person; never inferred.
    treatment: str = "revolving"  # revolving | pay_in_full | promo | unsure
    mixed: bool = False  # balance includes a cash advance, transfer, deferred-interest or installment part
    past_due: bool = False  # a payment is overdue, or the account is under a special arrangement
    grace: str | None = None  # pay_in_full: recent statements paid in full and on time? yes | no | unsure
    can_pay_full: bool = True  # pay_in_full: able to pay the statement amount this time
    statement_due: float | None = None  # pay_in_full: issuer-confirmed amount still to pay toward the statement
    promo_kind: str | None = None  # promo: intro_zero | deferred | transfer | unsure
    promo_end: str | None = None  # ISO date the offer ends
    next_due: str | None = None  # ISO date of the actual next payment due date
    min_paid: bool = False  # the minimum for the upcoming due date has already been paid


@dataclass
class Payment:
    card_id: str
    minimum: float = 0.0
    extra: float = 0.0

    @property
    def total(self) -> float:
        return round(self.minimum + self.extra, 2)


@dataclass
class MonthRow:
    index: int  # payment cycle number, 1 = the cycle that starts on the plan's start date
    month: str  # "2026-11", the month the cycle starts in
    period_start: str  # ISO date, first day of the cycle
    period_end: str  # ISO date, last day of the cycle
    payments: list[Payment]
    interest: float
    balances: dict[str, float]
    total_balance: float
    start_balances: dict[str, float] = field(default_factory=dict)  # per card, before this cycle's interest
    card_interest: dict[str, float] = field(default_factory=dict)  # per card, added this cycle


@dataclass
class Forecast:
    status: Literal["ok", "shortfall", "no_debt", "apr_unknown", "not_converging"]
    strategy: Strategy
    months: int | None = None
    debt_free_month: str | None = None
    total_interest: float | None = None
    schedule: list[MonthRow] = field(default_factory=list)
    payoff_month: dict[str, str] = field(default_factory=dict)  # month of each card's last payment
    payoff_cycle: dict[str, int] = field(default_factory=dict)  # cycle in which each card is cleared
    shortfall: float = 0.0
    minimums_total: float = 0.0


def month_label(start: date, index: int) -> str:
    """Month in which payment cycle `index` starts, where cycle 1 starts on the start date."""
    m = start.month - 1 + (index - 1)
    return f"{start.year + m // 12:04d}-{m % 12 + 1:02d}"


def _add_months(d: date, months: int) -> date:
    m = d.month - 1 + months
    year, month = d.year + m // 12, m % 12 + 1
    return date(year, month, min(d.day, monthrange(year, month)[1]))


def cycle_window(start: date, index: int) -> tuple[date, date]:
    """First and last day of payment cycle `index` (a rolling month from the start date)."""
    return _add_months(start, index - 1), _add_months(start, index) - timedelta(days=1)


def due_date(start: date, index: int, due_day: int | None) -> str | None:
    """ISO date of a card's payment in cycle `index`: its due day inside that cycle's window.

    A due day that has already passed in the cycle's first month falls in the following month.
    """
    if not due_day:
        return None
    m = start.month - 1 + (index - 1) + (1 if due_day < start.day else 0)
    year, month = start.year + m // 12, m % 12 + 1
    return f"{year:04d}-{month:02d}-{min(due_day, monthrange(year, month)[1]):02d}"


def _owing(cards: list[Card]) -> list[Card]:
    return [c for c in cards if c.balance > EPS]


def minimums_total(cards: list[Card]) -> float:
    return round(sum(min(c.minimum, c.balance) for c in _owing(cards)), 2)


def shortfall(cards: list[Card], budget: float) -> float:
    """How much the budget falls short of the minimum payments. 0 when covered."""
    return round(max(0.0, minimums_total(cards) - budget), 2)


def _order(cards: list[Card], strategy: Strategy) -> list[Card]:
    if strategy == "snowball":
        return sorted(cards, key=lambda c: (c.balance, -(c.apr or 0.0)))
    # avalanche: highest APR first; unknown APR goes last, ties by smaller balance
    return sorted(cards, key=lambda c: (-(c.apr if c.apr is not None else -1.0), c.balance))


def _pay_month(cards: list[Card], pool: float, strategy: Strategy) -> list[Payment]:
    """Apply one month of payments to `cards` in place. Interest must already be added."""
    pays = {c.id: Payment(c.id) for c in cards}
    for c in cards:
        p = min(c.minimum, c.balance, pool)
        c.balance -= p
        pool -= p
        pays[c.id].minimum = round(p, 2)
    if strategy != "minimum":
        for c in _order([c for c in cards if c.balance > EPS], strategy):
            if pool <= EPS:
                break
            p = min(pool, c.balance)
            c.balance -= p
            pool -= p
            pays[c.id].extra = round(p, 2)
    for c in cards:
        if c.balance < EPS:
            c.balance = 0.0
    return list(pays.values())


def allocate(cards: list[Card], budget: float, strategy: Strategy = "avalanche") -> list[Payment]:
    """This month's split of the budget, before any interest is modelled.

    Works even when an APR is unknown. Returns [] when the budget cannot cover the minimums.
    """
    if shortfall(cards, budget) > 0:
        return []
    work = [Card(**vars(c)) for c in _owing(cards)]
    for c in work:
        if c.min_paid:
            c.minimum = 0.0  # already paid for the upcoming due date
    return _pay_month(work, budget, strategy)


def simulate(
    cards: list[Card],
    budget: float,
    strategy: Strategy = "avalanche",
    start: date | None = None,
    one_time: float = 0.0,
    budget_overrides: dict[int, float] | None = None,
) -> Forecast:
    """Month-by-month forecast until every card is cleared.

    one_time: extra dollars added in month 1.
    budget_overrides: {month_index: budget} for single months with a different amount.
    Never returns a debt-free month when the budget is short or an APR is missing.
    """
    start = start or date.today()
    owing = _owing(cards)
    mins = minimums_total(cards)
    if not owing:
        return Forecast("no_debt", strategy, months=0, total_interest=0.0)
    gap = shortfall(cards, budget)
    if gap > 0:
        return Forecast("shortfall", strategy, shortfall=gap, minimums_total=mins)
    if any(c.apr is None for c in owing):
        return Forecast("apr_unknown", strategy, minimums_total=mins)

    work = [Card(**vars(c)) for c in owing]
    overrides = budget_overrides or {}
    fc = Forecast("ok", strategy, minimums_total=mins)
    total_interest = 0.0
    m = 0
    while any(c.balance > EPS for c in work) and m < MAX_MONTHS:
        m += 1
        month_interest = 0.0
        start_balances = {c.id: c.balance for c in work}
        card_interest = {}
        for c in work:
            i = c.balance * (c.apr or 0.0) / 1200
            c.balance += i
            month_interest += i
            card_interest[c.id] = i
        pool = overrides.get(m, budget) + (one_time if m == 1 else 0.0)
        if strategy == "minimum":
            pool = float("inf")  # only minimums are paid; budget above them is unused
        usual = {c.id: c.minimum for c in work}
        if m == 1:
            for c in work:
                if c.min_paid:
                    c.minimum = 0.0  # already paid for the upcoming due date: not scheduled again
        pays = _pay_month(work, pool, strategy)
        for c in work:
            c.minimum = usual[c.id]
        total_interest += month_interest
        label = month_label(start, m)
        first_day, last_day = cycle_window(start, m)
        for c in work:
            if c.balance == 0.0 and c.id not in fc.payoff_month:
                # the month of the card's last payment, by its real due date when it has one
                fc.payoff_month[c.id] = (due_date(start, m, c.due_day) or first_day.isoformat())[:7]
                fc.payoff_cycle[c.id] = m
        fc.schedule.append(
            MonthRow(
                index=m,
                month=label,
                period_start=first_day.isoformat(),
                period_end=last_day.isoformat(),
                payments=[p for p in pays if p.total > 0],
                interest=round(month_interest, 2),
                balances={c.id: round(c.balance, 2) for c in work},
                total_balance=round(sum(c.balance for c in work), 2),
                start_balances={k: round(v, 2) for k, v in start_balances.items()},
                card_interest={k: round(v, 2) for k, v in card_interest.items()},
            )
        )
    if any(c.balance > EPS for c in work):
        return Forecast("not_converging", strategy, minimums_total=mins)
    fc.months = m
    fc.debt_free_month = max(fc.payoff_month.values())  # month of the very last payment
    fc.total_interest = round(total_interest, 2)
    return fc


ASSUMPTIONS = [
    "For ordinary purchase balances that are already charged interest. Special financing and mixed-rate cards are not forecast.",
    "You pay the full budget every month, can fund each payment by its due date, and make no new purchases.",
    "APRs stay as entered.",
    "Minimum payments are held at today's amounts as an approximation; your issuer sets the real ones.",
    "Estimated with a monthly interest model (balance x APR / 12, added before the payment). Your issuer may calculate interest daily, so actual charges and payoff amounts can differ.",
    "When an estimated payoff is reached, check your issuer's balance and next statement for any remaining interest or fees.",
]


def _nice(iso: str | None) -> str:
    if not iso:
        return "the date in the offer"
    y, m, d = (int(x) for x in iso.split("-"))
    return f"{['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} {d}, {y}"


def card_support(c: Card, start: date) -> dict:
    """How this card is handled. Decided only from what the person confirmed; nothing is inferred.

    kind: "revolving" (forecast), "paid_off", "grace" (pays in full, reminder only), "review" (not forecast).
    """
    out = {"card_id": c.id, "name": c.name, "kind": "review", "code": "", "title": "", "message": "", "amount": None, "amount_label": None, "due": c.next_due}

    def done(kind: str, code: str, title: str, message: str, amount: float | None = None, label: str | None = None) -> dict:
        out.update(kind=kind, code=code, title=title, message=message, amount=amount, amount_label=label)
        return out

    minimum = round(min(c.minimum, c.balance), 2) if c.minimum > 0 else None
    if c.balance <= EPS:
        return done("paid_off", "paid_off", "Paid off", "No balance. Its credit limit still counts toward your credit usage.")
    if c.past_due:
        return done("review", "past_due", "Overdue or special arrangement",
                    "A payment is overdue or the account is under a special arrangement. Confirm the amount due and the terms with the issuer before planning.", minimum, "Minimum you entered")
    if c.next_due and c.next_due < start.isoformat() and not c.min_paid:
        return done("review", "due_passed", "Due date has passed",
                    f"Its due date ({_nice(c.next_due)}) has passed. If that payment was made, enter the next due date. If not, confirm the amount due with the issuer.", minimum, "Minimum you entered")
    if c.treatment == "revolving":
        if c.mixed:
            return done("review", "mixed", "More than one rate on this card",
                        "This balance includes a cash advance, a transfer, deferred-interest or an installment plan. One purchase APR cannot describe it, so it is not forecast.", minimum, "Minimum you entered")
        return done("revolving", "revolving", "Regular purchase interest", "Included in the payoff forecast.", minimum, "Minimum")
    if c.treatment == "pay_in_full":
        if c.grace == "yes" and c.can_pay_full:
            return done("grace", "grace", "Paid in full each month",
                        "You may be able to avoid purchase interest by paying the required statement amount by the due date, subject to your card's terms.", c.statement_due, "Statement amount to pay")
        why = "You can't pay the statement in full this time" if not c.can_pay_full else "It isn't confirmed that this card has an active grace period"
        return done("review", "grace_review", "Terms need review",
                    f"{why}, so we can't tell from one balance how interest will apply. Check your statement or ask the issuer.", c.statement_due, "Statement amount to pay")
    if c.treatment == "promo":
        if c.promo_kind == "intro_zero":
            return done("review", "promo_zero", "0% introductory APR",
                        f"0% until {_nice(c.promo_end)}. Not forecast yet: the rate after the offer ends changes the plan, and 0% is never assumed to last.", minimum, "Minimum you entered")
        if c.promo_kind == "deferred":
            return done("review", "promo_deferred", "No interest if paid in full",
                        f"Interest is waived only if the whole promotional balance is paid by {_nice(c.promo_end)}. If it isn't, interest for the entire period can be charged at once. Confirm the payoff amount with the issuer.", minimum, "Minimum you entered")
        if c.promo_kind == "transfer":
            return done("review", "promo_transfer", "Balance transfer or special arrangement",
                        "Transfers can carry fees, their own rate and their own end date, and new purchases may be charged differently. This card needs a more detailed model.", minimum, "Minimum you entered")
        return done("review", "promo_unsure", "Which offer is it?", "Tell us which kind of offer this is, or check the terms with the issuer.", minimum, "Minimum you entered")
    return done("review", "unsure", "How is this card charged?",
                "Choose how this card is charged interest. If you aren't sure, your statement's interest section or the issuer can tell you.", minimum, "Minimum you entered")


def _with_due(payments: list[Payment], cards: list[Card], start: date, index: int, row: MonthRow | None = None) -> list[dict]:
    """Payments as plain data, each with its due date.

    `minimum` is the part of the payment that counts toward the statement minimum, which is capped at
    what the card owes; `statement_minimum` is the figure the person entered and is never changed.
    With a forecast row, each payment also reconciles: start_balance + interest - total = end_balance.
    """
    by_id = {c.id: c for c in cards}
    out = []
    for p in payments:
        if p.total <= 0:
            continue
        card = by_id[p.card_id]
        item = vars(p) | {
            "total": p.total,
            "due": due_date(start, index, card.due_day),
            "statement_minimum": round(card.minimum, 2),
            "start_balance": None, "interest": None, "end_balance": None, "payoff": False,
        }
        if row is not None:
            item["start_balance"] = row.start_balances.get(p.card_id)
            item["interest"] = row.card_interest.get(p.card_id)
            item["end_balance"] = row.balances.get(p.card_id)
            item["payoff"] = item["end_balance"] == 0  # this payment clears the card (estimated payoff amount)
        out.append(item)
    return out


def _limit_use(cards: list[Card], after: dict[str, float] | None, after_date: str | None) -> dict:
    """Share of each credit limit in use, today and after the next three payment cycles.

    Per-card figures are given for every card with a limit. The combined figure is total balances
    divided by total limits, and is only given when every card entered has a limit.
    """
    rows, missing = [], []
    for c in cards:
        if not c.limit:
            missing.append(c.name)
            continue
        later = None if after is None else after.get(c.id, 0.0)
        rows.append({
            "card_id": c.id, "limit": c.limit, "balance": round(c.balance, 2),
            "now_pct": round(c.balance / c.limit * 100, 1),
            "after_balance": None if later is None else round(later, 2),
            "after_pct": None if later is None else round(later / c.limit * 100, 1),
        })
    complete = bool(rows) and not missing
    total = sum(r["limit"] for r in rows)
    now = sum(r["balance"] for r in rows)
    later_total = None if after is None else sum(r["after_balance"] for r in rows)
    return {
        "cards": rows, "missing": missing, "complete": complete, "after_date": after_date,
        "total_limit": total if complete else None,
        "now_pct": round(now / total * 100, 1) if complete else None,
        "after_pct": round(later_total / total * 100, 1) if complete and later_total is not None else None,
    }


def build_plan(
    cards: list[Card],
    budget: float,
    strategy: Strategy = "avalanche",
    start: date | None = None,
    one_time: float = 0.0,
    budget_overrides: dict[int, float] | None = None,
) -> dict:
    """Everything the plan screens need, as plain data."""
    start = start or date.today()
    first_day, last_day = cycle_window(start, 1)
    support = [card_support(c, start) for c in cards]
    blocking = [x for x in support if x["kind"] in ("grace", "review")]
    if blocking:
        # At least one card with a balance is outside the ordinary revolving model. Nothing is
        # forecast for the portfolio: no combined payoff date, no savings claim, and the budget is
        # not quietly spent on the remaining cards.
        forecastable = [c for c, x in zip(cards, support) if x["kind"] == "revolving"]
        for x, c in zip(support, cards):
            if x["kind"] == "revolving" and not x["due"]:
                x["due"] = due_date(start, 1, c.due_day)
        return {
            "status": "pay_in_full" if all(x["kind"] in ("grace", "paid_off") for x in support) else "limited",
            "strategy": strategy,
            "budget": round(budget, 2),
            "start_month": month_label(start, 1),
            "cycle": {"index": 1, "period_start": first_day.isoformat(), "period_end": last_day.isoformat()},
            "cards": [vars(c) for c in cards],
            "card_status": support,
            "blocked_by": [x["name"] for x in blocking if x["kind"] == "review"],
            "total_debt": round(sum(c.balance for c in _owing(cards)), 2),
            "minimums_total": minimums_total(forecastable),
            "above_minimums": 0.0,
            "shortfall": shortfall(forecastable, budget),
            "this_cycle": [],
            "unallocated": 0.0,
            "missing_apr": [],
            "assumptions": ASSUMPTIONS,
            "missing": [],
            "forecast": None,
            "cycles": [],
            "comparison": [],
            "limit_use": _limit_use(cards, None, None),  # current use only: no projection without a forecast
        }
    first_need = round(sum(min(c.minimum, c.balance) for c in _owing(cards) if not c.min_paid), 2)
    first_budget = (budget_overrides or {}).get(1)
    main = simulate(cards, budget, strategy, start, one_time, budget_overrides)
    if main.status == "ok" and first_budget is not None and first_budget + one_time < first_need - EPS:
        # the money left for this month does not cover the minimums still due this month
        main = Forecast("shortfall", strategy, shortfall=round(first_need - first_budget - one_time, 2), minimums_total=first_need)
    out: dict = {
        "status": main.status,
        "strategy": strategy,
        "budget": round(budget, 2),
        "start_month": month_label(start, 1),
        "cycle": {"index": 1, "period_start": first_day.isoformat(), "period_end": last_day.isoformat()},
        "cards": [vars(c) for c in cards],
        "card_status": support,
        "blocked_by": [],
        "total_debt": round(sum(c.balance for c in _owing(cards)), 2),
        "minimums_total": minimums_total(cards),
        "above_minimums": round(max(0.0, budget - minimums_total(cards)), 2),
        "shortfall": main.shortfall if main.status == "shortfall" else shortfall(cards, budget),
        "this_cycle": [],  # filled below from one calculation
        "unallocated": 0.0,
        "missing_apr": [c.name for c in _owing(cards) if c.apr is None],
        "assumptions": ASSUMPTIONS,
        "missing": [f"{c.name}: APR not entered, no interest forecast" for c in _owing(cards) if c.apr is None],
        "forecast": None,
        "cycles": [],
        "comparison": [],
        "limit_use": _limit_use(cards, None, None),
    }
    if main.status == "apr_unknown":
        # No interest can be estimated, so the split is on today's balances. With an APR missing we
        # cannot know which card has the highest rate, so under avalanche only the minimums are
        # placed and the rest of the budget is reported as not yet allocated.
        split = "minimum" if strategy == "avalanche" else strategy
        out["this_cycle"] = _with_due(allocate(cards, budget + one_time, split), cards, start, 1)
        out["unallocated"] = round(budget + one_time - sum(p["total"] for p in out["this_cycle"]), 2)
    if main.status != "ok":
        return out
    out["forecast"] = {
        "months": main.months,  # number of payment cycles
        "debt_free_month": main.debt_free_month,
        "total_interest": main.total_interest,
        "payoff_month": main.payoff_month,
        "payoff_cycle": main.payoff_cycle,
        "balance_by_cycle": [out["total_debt"]] + [r.total_balance for r in main.schedule],
        "cycle_ends": [r.period_end for r in main.schedule],
        # every payment of the whole plan with its due date, for the calendar
        "due_dates": [
            {k: p[k] for k in ("due", "card_id", "total", "minimum", "extra", "end_balance", "payoff")}
            for r in main.schedule
            for p in _with_due(r.payments, cards, start, r.index, r)
            if p["due"]
        ],
    }
    out["cycles"] = [
        {
            "index": r.index,
            "period_start": r.period_start,
            "period_end": r.period_end,
            "payments": _with_due(r.payments, cards, start, r.index, r),
            "interest": r.interest,
            "balances": r.balances,
            "total_balance": r.total_balance,
        }
        for r in main.schedule[:3]
    ]
    # One authoritative first-cycle payment: the Plan shows exactly the first row of the schedule.
    out["this_cycle"] = out["cycles"][0]["payments"]
    # Credit limit use is always projected to the end of the third cycle; cards cleared sooner are at zero.
    third = main.schedule[min(2, len(main.schedule) - 1)]
    out["limit_use"] = _limit_use(cards, third.balances, cycle_window(start, 3)[1].isoformat())
    for s in ("avalanche", "snowball", "minimum"):
        f = main if s == strategy else simulate(cards, budget, s, start, one_time, budget_overrides)  # type: ignore[arg-type]
        first = min(f.payoff_cycle.items(), key=lambda kv: kv[1]) if f.payoff_cycle else None
        out["comparison"].append({
            "strategy": s, "status": f.status, "months": f.months, "debt_free_month": f.debt_free_month,
            "total_interest": f.total_interest, "payoff_month": f.payoff_month,
            # what this comparison pays each cycle: the budget, or only the minimums
            "payment_basis": minimums_total(cards) if s == "minimum" else round(budget, 2),
            "first_cleared": None if first is None else {"card_id": first[0], "month": f.payoff_month[first[0]]},
        })
    return out
