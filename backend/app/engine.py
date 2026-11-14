"""FinPilot payoff engine.

Pure functions, no I/O. All money is in dollars as floats rounded to cents at the edges.

Model (shown to the user as assumptions):
- Interest is estimated monthly: balance * APR / 12, added before that month's payment.
- Minimum payments stay at today's dollar amount unless a card's balance is lower.
- No new purchases.
- Minimums are reserved first; what is left goes to one target card at a time
  (highest APR first, or smallest balance first). A cleared card's money rolls to the next.
- A payment never exceeds what is needed to clear the card.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
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
    index: int  # 1 = first payment month
    month: str  # "2026-11"
    payments: list[Payment]
    interest: float
    balances: dict[str, float]
    total_balance: float


@dataclass
class Forecast:
    status: Literal["ok", "shortfall", "no_debt", "apr_unknown", "not_converging"]
    strategy: Strategy
    months: int | None = None
    debt_free_month: str | None = None
    total_interest: float | None = None
    schedule: list[MonthRow] = field(default_factory=list)
    payoff_month: dict[str, str] = field(default_factory=dict)
    shortfall: float = 0.0
    minimums_total: float = 0.0


def month_label(start: date, index: int) -> str:
    """Label of the index-th payment month, where index 1 is the start month."""
    m = start.month - 1 + (index - 1)
    return f"{start.year + m // 12:04d}-{m % 12 + 1:02d}"


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
        for c in work:
            i = c.balance * (c.apr or 0.0) / 1200
            c.balance += i
            month_interest += i
        pool = overrides.get(m, budget) + (one_time if m == 1 else 0.0)
        if strategy == "minimum":
            pool = float("inf")  # only minimums are paid; budget above them is unused
        pays = _pay_month(work, pool, strategy)
        total_interest += month_interest
        label = month_label(start, m)
        for c in work:
            if c.balance == 0.0 and c.id not in fc.payoff_month:
                fc.payoff_month[c.id] = label
        fc.schedule.append(
            MonthRow(
                index=m,
                month=label,
                payments=[p for p in pays if p.total > 0],
                interest=round(month_interest, 2),
                balances={c.id: round(c.balance, 2) for c in work},
                total_balance=round(sum(c.balance for c in work), 2),
            )
        )
    if any(c.balance > EPS for c in work):
        return Forecast("not_converging", strategy, minimums_total=mins)
    fc.months = m
    fc.debt_free_month = month_label(start, m)
    fc.total_interest = round(total_interest, 2)
    return fc


ASSUMPTIONS = [
    "You pay the full budget every month and make no new purchases.",
    "APRs stay as entered.",
    "Minimum payments stay at today's amounts; your bank may lower them as balances fall.",
    "Interest is estimated monthly (balance x APR / 12); banks often calculate daily.",
]


def build_plan(cards: list[Card], budget: float, strategy: Strategy = "avalanche", start: date | None = None) -> dict:
    """Everything the plan screen needs, as plain data."""
    start = start or date.today()
    main = simulate(cards, budget, strategy, start)
    out: dict = {
        "status": main.status,
        "strategy": strategy,
        "budget": round(budget, 2),
        "total_debt": round(sum(c.balance for c in _owing(cards)), 2),
        "minimums_total": minimums_total(cards),
        "above_minimums": round(max(0.0, budget - minimums_total(cards)), 2),
        "shortfall": shortfall(cards, budget),
        "this_month": [vars(p) | {"total": p.total} for p in allocate(cards, budget, strategy)],
        "assumptions": ASSUMPTIONS,
        "missing": [f"{c.name}: APR not entered, no interest forecast" for c in _owing(cards) if c.apr is None],
        "forecast": None,
        "ninety_days": [],
        "comparison": [],
    }
    if main.status != "ok":
        return out
    out["forecast"] = {
        "months": main.months,
        "debt_free_month": main.debt_free_month,
        "total_interest": main.total_interest,
        "payoff_month": main.payoff_month,
        "balance_by_month": [out["total_debt"]] + [r.total_balance for r in main.schedule],
    }
    out["ninety_days"] = [
        {
            "month": r.month,
            "payments": [vars(p) | {"total": p.total} for p in r.payments],
            "interest": r.interest,
            "balances": r.balances,
            "total_balance": r.total_balance,
        }
        for r in main.schedule[:3]
    ]
    for s in ("avalanche", "snowball", "minimum"):
        f = main if s == strategy else simulate(cards, budget, s, start)  # type: ignore[arg-type]
        out["comparison"].append(
            {"strategy": s, "status": f.status, "months": f.months, "debt_free_month": f.debt_free_month, "total_interest": f.total_interest}
        )
    return out
