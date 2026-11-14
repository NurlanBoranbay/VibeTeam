"""FinPilot AI service. Wording only; no calculations happen here.

Run from the ai folder:  python -m uvicorn service:app --reload --port 8001
Credentials: set ANTHROPIC_API_KEY (or log in with `ant auth login`). Without them the
service still answers, using the fixed template.
"""
from __future__ import annotations

import base64
import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from finpilot_ai.call_script import CallFacts, call_script
from finpilot_ai.statement import StatementProblem, docx_text, pdf_text, photo_text, read_statement

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


class StatementIn(BaseModel):
    """One statement: its text, or a PDF or Word file read in the browser and sent as base64."""

    text: str | None = Field(default=None, max_length=200_000)
    pdf_base64: str | None = Field(default=None, max_length=14_000_000)
    docx_base64: str | None = Field(default=None, max_length=14_000_000)
    image_base64: str | None = Field(default=None, max_length=14_000_000)
    image_type: str = Field(default="image/jpeg", max_length=20)
    use_ai: bool = True


@app.post("/extract-statement")
def post_extract_statement(body: StatementIn) -> dict:
    """Pull balance, APR, minimum, due day and limit out of one statement. Nothing is stored."""
    try:
        encoded = body.pdf_base64 or body.docx_base64 or body.image_base64
        if encoded:
            try:
                data = base64.b64decode(encoded, validate=True)
            except ValueError:
                raise HTTPException(status_code=400, detail="We couldn't read this file. Please try again.") from None
            # both raise StatementProblem with a readable message
            if body.pdf_base64:
                text = pdf_text(data)
            elif body.docx_base64:
                text = docx_text(data)
            else:
                text = photo_text(data, body.image_type)
        else:
            text = body.text or ""
        out = read_statement(text, body.use_ai)
        if body.image_base64 and not body.pdf_base64 and not body.docx_base64:
            out["notes"].insert(0, "Read from a photo by AI. Photos are easier to misread than files, so check every number.")
        return out
    except StatementProblem as problem:
        raise HTTPException(status_code=422, detail=str(problem)) from None
