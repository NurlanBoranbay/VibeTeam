"""FinPilot API.

Run from the backend folder:  python -m uvicorn app.main:app --reload --port 8000
"""
from __future__ import annotations

import base64
import hashlib
import os
import secrets
from datetime import date

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from . import engine as calc
from . import importer, models
from .db import Base, engine, get_session
from .schemas import CardIn, PlanIn, SavedPlan, ScenarioIn, TableIn

app = FastAPI(title="FinPilot API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "http://localhost:5173").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)
Base.metadata.create_all(engine)


def _cards(cards: list[CardIn]) -> list[calc.Card]:
    return [
        calc.Card(id=c.id or f"card-{i + 1}", name=c.name, balance=c.balance, minimum=c.minimum, apr=c.apr, due_day=c.due_day, limit=c.limit)
        for i, c in enumerate(cards)
    ]


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _cents(v: float | None) -> int | None:
    return None if v is None else round(v * 100)


def _bps(v: float | None) -> int | None:
    return None if v is None else round(v * 100)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.post("/api/plan/calculate")
def calculate(body: PlanIn) -> dict:
    """Stateless: nothing is stored. This is what the no-sign-up flow uses."""
    return calc.build_plan(_cards(body.cards), body.budget, body.strategy, body.start or date.today())


@app.post("/api/plan/scenario")
def scenario(body: ScenarioIn) -> dict:
    """What-if: a different budget, a one-time payment, one lower month, or a bank-confirmed APR.

    Returns the unchanged plan as `baseline` and the changed one as `scenario`.
    """
    start = body.start or date.today()
    alt_cards = _cards(body.cards)
    for c in alt_cards:
        if c.id in body.apr_overrides:
            c.apr = body.apr_overrides[c.id]
    overrides = {body.low_month_index: body.low_month_budget} if body.low_month_index and body.low_month_budget is not None else None
    budget = body.budget if body.scenario_budget is None else body.scenario_budget
    return {
        "baseline": calc.build_plan(_cards(body.cards), body.budget, body.strategy, start),
        "scenario": calc.build_plan(alt_cards, budget, body.strategy, start, body.one_time, overrides),
    }


@app.post("/api/plan/calendar")
def calendar(body: PlanIn) -> Response:
    """Due dates for the next three payment cycles as an .ics file. Each payment appears once. Reminders only; nothing is paid."""
    start = body.start or date.today()
    plan = calc.build_plan(_cards(body.cards), body.budget, body.strategy, start)
    if plan["status"] != "ok":
        raise HTTPException(status_code=409, detail="No schedule to export: the plan has no forecast yet.")
    by_id = {c["id"]: c for c in plan["cards"]}
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//FinPilot//Payoff plan//EN"]
    for row in plan["cycles"]:
        for p in row["payments"]:
            card = by_id[p["card_id"]]
            when = (p["due"] or row["period_start"]).replace("-", "")
            lines += [
                "BEGIN:VEVENT",
                f"UID:cycle{row['index']}-{p['card_id']}@finpilot",
                f"DTSTAMP:{start:%Y%m%d}T000000Z",
                f"DTSTART;VALUE=DATE:{when}",
                f"SUMMARY:Pay ${p['total']:,.2f} to {card['name']}",
                f"DESCRIPTION:${p['minimum']:,.2f} minimum + ${p['extra']:,.2f} extra. From your FinPilot plan. Pay in your bank or card app.",
                "END:VEVENT",
            ]
    lines.append("END:VCALENDAR")
    return Response(
        "\r\n".join(lines) + "\r\n",
        media_type="text/calendar",
        headers={"Content-Disposition": 'attachment; filename="finpilot-due-dates.ics"'},
    )


@app.post("/api/import/table")
def import_table(body: TableIn) -> dict:
    """Read cards from an uploaded CSV or Excel sheet. Plain code, no AI; nothing is stored."""
    try:
        data = base64.b64decode(body.content_base64, validate=True)
    except ValueError:
        raise HTTPException(status_code=400, detail="We couldn't read this file. Please try again.") from None
    try:
        return importer.read_cards(body.filename, data)
    except importer.ImportProblem as problem:
        raise HTTPException(status_code=422, detail=str(problem)) from None


@app.post("/api/plans", response_model=SavedPlan, status_code=201)
def save_plan(body: PlanIn, db: Session = Depends(get_session)) -> SavedPlan:
    """Optional saving. Returns an edit token once; only its hash is stored."""
    token = secrets.token_urlsafe(24)
    plan = models.Plan(
        edit_token_hash=_hash(token), goal=body.goal, strategy=body.strategy,
        monthly_budget_cents=round(body.budget * 100), start_month=body.start,
    )
    for i, c in enumerate(body.cards):
        plan.cards.append(
            models.Card(
                position=i, nickname=c.name, current_balance_cents=round(c.balance * 100),
                statement_balance_cents=_cents(c.statement_balance), apr_bps=_bps(c.apr),
                minimum_payment_cents=round(c.minimum * 100), due_day=c.due_day,
                statement_close_day=c.statement_close_day, credit_limit_cents=_cents(c.limit),
                promo_apr_bps=_bps(c.promo_apr), promo_ends_on=c.promo_ends_on,
            )
        )
    db.add(plan)
    db.commit()
    return SavedPlan(id=plan.id, edit_token=token, plan=body)


def _load(plan_id: str, token: str | None, db: Session) -> models.Plan:
    plan = db.get(models.Plan, plan_id)
    if plan is None or token is None or not secrets.compare_digest(plan.edit_token_hash, _hash(token)):
        raise HTTPException(status_code=404, detail="Plan not found. Check the plan link and its token.")
    return plan


@app.get("/api/plans/{plan_id}", response_model=SavedPlan)
def get_plan(plan_id: str, x_plan_token: str | None = Header(default=None), db: Session = Depends(get_session)) -> SavedPlan:
    plan = _load(plan_id, x_plan_token, db)
    cards = [
        CardIn(
            id=c.id, name=c.nickname, balance=c.current_balance_cents / 100, minimum=c.minimum_payment_cents / 100,
            apr=None if c.apr_bps is None else c.apr_bps / 100,
            statement_balance=None if c.statement_balance_cents is None else c.statement_balance_cents / 100,
            due_day=c.due_day, limit=None if c.credit_limit_cents is None else c.credit_limit_cents / 100,
            statement_close_day=c.statement_close_day,
            promo_apr=None if c.promo_apr_bps is None else c.promo_apr_bps / 100, promo_ends_on=c.promo_ends_on,
        )
        for c in plan.cards
    ]
    return SavedPlan(id=plan.id, plan=PlanIn(goal=plan.goal, budget=plan.monthly_budget_cents / 100, strategy=plan.strategy, start=plan.start_month, cards=cards))


@app.delete("/api/plans/{plan_id}", status_code=204)
def delete_plan(plan_id: str, x_plan_token: str | None = Header(default=None), db: Session = Depends(get_session)) -> None:
    """Deletes the plan and everything under it. There is no other copy."""
    db.delete(_load(plan_id, x_plan_token, db))
    db.commit()
