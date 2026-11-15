"""ORM models. Mirrors backend/db/schema.sql.

Money is stored as integer cents and rates as basis points (29.00% = 2900), so nothing
is rounded in storage. Plans hold no names or card numbers. An account is optional: it is an email, a
password hash and the person's saved plan as JSON (the tables at the end of this file).
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import JSON, Boolean, Date, DateTime, ForeignKey, Integer, SmallInteger, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _id() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Plan(Base):
    __tablename__ = "plans"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    edit_token_hash: Mapped[str] = mapped_column(String(64))
    goal: Mapped[str] = mapped_column(String(20), default="less_interest")
    strategy: Mapped[str] = mapped_column(String(12), default="avalanche")
    monthly_budget_cents: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3), default="USD")
    start_month: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)

    cards: Mapped[list["Card"]] = relationship(back_populates="plan", cascade="all, delete-orphan", order_by="Card.position")
    scenarios: Mapped[list["Scenario"]] = relationship(back_populates="plan", cascade="all, delete-orphan")
    snapshots: Mapped[list["PlanSnapshot"]] = relationship(back_populates="plan", cascade="all, delete-orphan")


class Card(Base):
    __tablename__ = "cards"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    plan_id: Mapped[str] = mapped_column(ForeignKey("plans.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(SmallInteger, default=0)
    nickname: Mapped[str] = mapped_column(String(40))
    current_balance_cents: Mapped[int] = mapped_column(Integer)
    statement_balance_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    apr_bps: Mapped[int | None] = mapped_column(Integer, nullable=True)
    minimum_payment_cents: Mapped[int] = mapped_column(Integer)
    due_day: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    statement_close_day: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    credit_limit_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    minimum_rule: Mapped[str | None] = mapped_column(String(120), nullable=True)
    promo_apr_bps: Mapped[int | None] = mapped_column(Integer, nullable=True)
    promo_ends_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)

    plan: Mapped[Plan] = relationship(back_populates="cards")
    balance_updates: Mapped[list["BalanceUpdate"]] = relationship(back_populates="card", cascade="all, delete-orphan")
    payment_marks: Mapped[list["PaymentMark"]] = relationship(back_populates="card", cascade="all, delete-orphan")
    bank_offers: Mapped[list["BankOffer"]] = relationship(back_populates="card", cascade="all, delete-orphan")
    call_scripts: Mapped[list["CallScript"]] = relationship(back_populates="card", cascade="all, delete-orphan")


class BalanceUpdate(Base):
    """What a new statement really said. The plan is rebuilt from the latest row."""

    __tablename__ = "balance_updates"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    card_id: Mapped[str] = mapped_column(ForeignKey("cards.id", ondelete="CASCADE"), index=True)
    statement_balance_cents: Mapped[int] = mapped_column(Integer)
    minimum_payment_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    estimated_balance_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    card: Mapped[Card] = relationship(back_populates="balance_updates")


class PaymentMark(Base):
    """The user's own tick that a payment was made. Not a transfer or a bank confirmation."""

    __tablename__ = "payment_marks"
    __table_args__ = (UniqueConstraint("card_id", "period_month"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    card_id: Mapped[str] = mapped_column(ForeignKey("cards.id", ondelete="CASCADE"), index=True)
    period_month: Mapped[date] = mapped_column(Date)
    planned_cents: Mapped[int] = mapped_column(Integer)
    paid_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    paid_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    card: Mapped[Card] = relationship(back_populates="payment_marks")


class Scenario(Base):
    """A saved what-if. `result` caches the engine output for quick display."""

    __tablename__ = "scenarios"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    plan_id: Mapped[str] = mapped_column(ForeignKey("plans.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(60))
    budget_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    one_time_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    low_month: Mapped[date | None] = mapped_column(Date, nullable=True)
    low_month_budget_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    card_id: Mapped[str | None] = mapped_column(ForeignKey("cards.id", ondelete="SET NULL"), nullable=True)
    new_apr_bps: Mapped[int | None] = mapped_column(Integer, nullable=True)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    plan: Mapped[Plan] = relationship(back_populates="scenarios")


class BankOffer(Base):
    """Terms a bank confirmed on a call. Applied to the card only when `applied` is true."""

    __tablename__ = "bank_offers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    card_id: Mapped[str] = mapped_column(ForeignKey("cards.id", ondelete="CASCADE"), index=True)
    outcome: Mapped[str] = mapped_column(String(12), default="accepted")  # accepted | declined | pending
    new_apr_bps: Mapped[int | None] = mapped_column(Integer, nullable=True)
    starts_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    ends_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    fee_cents: Mapped[int] = mapped_column(Integer, default=0)
    call_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    reference_note: Mapped[str | None] = mapped_column(String(120), nullable=True)
    applied: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    card: Mapped[Card] = relationship(back_populates="bank_offers")


class CallScript(Base):
    """Text of a bank-call script. `source` says whether AI wording or the fixed template was used."""

    __tablename__ = "call_scripts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    card_id: Mapped[str] = mapped_column(ForeignKey("cards.id", ondelete="CASCADE"), index=True)
    purpose: Mapped[str] = mapped_column(String(20), default="lower_apr")  # lower_apr | hardship
    source: Mapped[str] = mapped_column(String(12), default="template")  # template | ai
    model: Mapped[str | None] = mapped_column(String(40), nullable=True)
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    card: Mapped[Card] = relationship(back_populates="call_scripts")


class PlanSnapshot(Base):
    """A computed forecast kept for history ("what did the plan say in November?")."""

    __tablename__ = "plan_snapshots"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    plan_id: Mapped[str] = mapped_column(ForeignKey("plans.id", ondelete="CASCADE"), index=True)
    strategy: Mapped[str] = mapped_column(String(12))
    status: Mapped[str] = mapped_column(String(16))
    debt_free_month: Mapped[date | None] = mapped_column(Date, nullable=True)
    total_interest_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    payload: Mapped[dict] = mapped_column(JSON)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    plan: Mapped[Plan] = relationship(back_populates="snapshots")


class User(Base):
    """An optional account. Only an email and a password hash; no name, address or card number."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    salt: Mapped[str] = mapped_column(String(32))
    password_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class UserSession(Base):
    """A signed-in browser. The token itself is never stored, only its hash."""

    __tablename__ = "user_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class UserPlan(Base):
    """What the person entered, exactly as the web app holds it: cards, budget, payments, progress."""

    __tablename__ = "user_plans"

    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), primary_key=True)
    data: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
