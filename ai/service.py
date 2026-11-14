"""FinPilot AI service. Wording only; no calculations happen here.

Run from the ai folder:  python -m uvicorn service:app --reload --port 8001
Credentials: set ANTHROPIC_API_KEY (or log in with `ant auth login`). Without them the
service still answers, using the fixed template.
"""
from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from finpilot_ai.call_script import CallFacts, call_script

app = FastAPI(title="FinPilot AI", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "http://localhost:5173").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


class CallScriptIn(BaseModel):
    card_name: str = Field(min_length=1, max_length=40)
    balance: float = Field(gt=0)
    apr: float = Field(gt=0, le=100)
    minimum: float = Field(ge=0)
    planned_payment: float = Field(gt=0)
    tone: str = Field(default="polite and direct", max_length=60)
    use_ai: bool = True


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/call-script")
def post_call_script(body: CallScriptIn) -> dict:
    facts = CallFacts(body.card_name, body.balance, body.apr, body.minimum, body.planned_payment)
    return call_script(facts, body.tone, body.use_ai)
