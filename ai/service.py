"""FinPilot AI service. Wording only; no calculations happen here.

Run from the ai folder:  python -m uvicorn service:app --reload --port 8001
Credentials: set ANTHROPIC_API_KEY (or log in with `ant auth login`). Without them the
service still answers, using the fixed template.
"""
from __future__ import annotations

import base64
import os
from datetime import date

import httpx

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from finpilot_ai import assistant, docparse, llm
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


_BACKEND = os.environ.get("BACKEND_URL", "http://127.0.0.1:8000").rstrip("/")


def _allow(authorization: str | None, kind: str) -> dict:
    """AI is for signed-in people and is metered. The backend owns accounts, so it decides: this raises its
    answer (401 not signed in, 429 too many requests this minute, 403 free documents used up) or returns the use."""
    if not authorization:
        raise HTTPException(status_code=401, detail="Sign in to use the AI features. A free account is enough.")
    try:
        r = httpx.post(f"{_BACKEND}/api/ai/allow", json={"kind": kind}, headers={"Authorization": authorization}, timeout=10)
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="The AI features are not available right now. Please try again.") from None
    if r.status_code >= 400:
        try:
            detail = r.json().get("detail")
        except ValueError:
            detail = None
        raise HTTPException(status_code=r.status_code if r.status_code in (401, 403, 429) else 503,
                            detail=detail if isinstance(detail, str) else "The AI features are not available right now.")
    return r.json()


def _refund(authorization: str | None, use: dict) -> None:
    try:
        httpx.delete(f"{_BACKEND}/api/ai/use/{use['id']}", headers={"Authorization": authorization or ""}, timeout=10)
    except httpx.HTTPError:
        pass


@app.post("/call-script")
def post_call_script(body: CallScriptIn, authorization: str | None = Header(default=None)) -> dict:
    facts = CallFacts(body.card_name, body.balance, body.apr, body.minimum, body.planned_payment)
    use_ai = body.use_ai
    if use_ai:
        # the script always works: without an account, or over the limit, it is the standard wording
        try:
            _allow(authorization, "script")
        except HTTPException:
            use_ai = False
    return call_script(facts, body.tone, use_ai)


class StatementIn(BaseModel):
    """One statement: its text, or a PDF or Word file read in the browser and sent as base64."""

    text: str | None = Field(default=None, max_length=200_000)
    pdf_base64: str | None = Field(default=None, max_length=14_000_000)
    docx_base64: str | None = Field(default=None, max_length=14_000_000)
    image_base64: str | None = Field(default=None, max_length=14_000_000)
    image_type: str = Field(default="image/jpeg", max_length=20)
    # any document, read through the docparse service when it is configured
    file_base64: str | None = Field(default=None, max_length=28_000_000)
    filename: str = Field(default="statement", max_length=200)
    use_ai: bool = True


@app.post("/extract-statement")
def post_extract_statement(body: StatementIn, authorization: str | None = Header(default=None)) -> dict:
    """Pull balance, APR, minimum, due day and limit out of one statement. Nothing is stored."""
    use = _allow(authorization, "doc")
    try:
        out = _extract(body)
    except HTTPException:
        _refund(authorization, use)  # a document that could not be read does not count
        raise
    if use.get("tier") == "free":
        out["notes"].append("That was the one statement the Free plan reads. Plus reads them without a limit.")
    return out


def _extract(body: StatementIn) -> dict:
    try:
        if body.file_base64:
            try:
                raw = base64.b64decode(body.file_base64, validate=True)
            except ValueError:
                raise HTTPException(status_code=400, detail="We couldn't read this file. Please try again.") from None
            text = _document_text(body.filename, raw)
            out = read_statement(text, body.use_ai)
            out["notes"].insert(0, "Read from your document. Check every number against the statement.")
            return out
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
    except (StatementProblem, docparse.DocparseProblem) as problem:
        raise HTTPException(status_code=422, detail=str(problem)) from None


def _document_text(filename: str, raw: bytes) -> str:
    """The text of any document: docparse first (PDF, photo, scan, Word, Excel); local readers if it is down."""
    name = filename.lower()
    if docparse.configured():
        try:
            return docparse.parse(filename, raw)
        except docparse.DocparseUnavailable:
            pass  # fall through to what this service can read on its own
    if name.endswith(".pdf"):
        return pdf_text(raw)
    if name.endswith(".docx"):
        return docx_text(raw)
    if name.endswith((".jpg", ".jpeg", ".png", ".webp")):
        kind = "image/png" if name.endswith(".png") else "image/webp" if name.endswith(".webp") else "image/jpeg"
        return photo_text(raw, kind)
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        raise StatementProblem("This file type can't be read right now. Try a PDF or paste the statement text.") from None


@app.get("/status")
def status() -> dict:
    """Which AI parts are switched on. No secrets, only yes or no."""
    return {"assistant": llm.available(), "expert": bool(os.environ.get("DEEPSEEK_API_KEY")), "docparse": docparse.configured()}


class ChatIn(BaseModel):
    messages: list[dict] = Field(min_length=1, max_length=40)
    inputs: dict


def _post(path: str, body: dict) -> dict:
    r = httpx.post(f"{_BACKEND}{path}", json=body, timeout=30)
    if r.status_code >= 400:
        raise ValueError(f"{path} answered {r.status_code}")
    return r.json()


@app.post("/assistant/chat")
def post_assistant(body: ChatIn, authorization: str | None = Header(default=None)) -> dict:
    """One assistant turn. Returns the reply, the inputs if they changed, and what was done."""
    if not llm.available():
        raise HTTPException(status_code=503, detail="The assistant isn't switched on for this server.")
    if not isinstance(body.inputs.get("cards"), list) or not body.inputs["cards"]:
        raise HTTPException(status_code=422, detail="Add at least one card before using the assistant.")
    use = _allow(authorization, "chat")
    try:
        out = assistant.run(
            body.messages, body.inputs,
            calc=lambda inputs: _post("/api/plan/calculate", inputs),
            scenario=lambda inputs, params: _post("/api/plan/scenario", {**inputs, **params}),
            today=date.today(),
        )
        return {**out, "free_left": use.get("chats_left")}  # questions left this month on Free; null on Plus
    except llm.LLMUnavailable:
        raise HTTPException(status_code=503, detail="The assistant is busy right now. Please try again in a moment.") from None
    except ValueError:
        raise HTTPException(status_code=502, detail="The assistant couldn't read your plan. Please try again.") from None
