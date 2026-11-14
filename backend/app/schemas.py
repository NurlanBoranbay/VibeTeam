"""Request and response shapes for the HTTP API."""
from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field

Goal = Literal["less_interest", "faster_payoff", "future_loan", "tight_budget"]
Strategy = Literal["avalanche", "snowball"]


class CardIn(BaseModel):
    id: str | None = None
    name: str = Field(min_length=1, max_length=40, description="Nickname only. Never a card number.")
    balance: float = Field(ge=0)
    minimum: float = Field(ge=0)
    apr: float | None = Field(default=None, ge=0, le=100, description="Percent. Omit when unknown.")
    statement_balance: float | None = Field(default=None, ge=0)
    due_day: int | None = Field(default=None, ge=1, le=31)
    limit: float | None = Field(default=None, gt=0)
    statement_close_day: int | None = Field(default=None, ge=1, le=31)
    promo_apr: float | None = Field(default=None, ge=0, le=100)
    promo_ends_on: date | None = None


class PlanIn(BaseModel):
    goal: Goal = "less_interest"
    budget: float = Field(ge=0, description="Monthly total for all cards, minimums included.")
    strategy: Strategy = "avalanche"
    start: date | None = Field(default=None, description="First payment month. Defaults to today.")
    cards: list[CardIn] = Field(min_length=1, max_length=3)


class ScenarioIn(PlanIn):
    """A what-if on top of the plan. Every field is optional; omitted ones keep the plan's value."""

    scenario_budget: float | None = Field(default=None, ge=0)
    one_time: float = Field(default=0, ge=0)
    low_month_index: int | None = Field(default=None, ge=1)
    low_month_budget: float | None = Field(default=None, ge=0)
    apr_overrides: dict[str, float] = Field(default_factory=dict, description="card id -> APR confirmed by the bank")


class SavedPlan(BaseModel):
    id: str
    edit_token: str | None = Field(default=None, description="Returned once, on create. Keep it to edit or delete.")
    plan: PlanIn


class TableIn(BaseModel):
    """A CSV or Excel file read in the browser and sent as base64, so no upload is kept on disk."""

    filename: str = Field(min_length=1, max_length=200)
    content_base64: str = Field(max_length=3_000_000)
