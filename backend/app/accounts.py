"""Optional accounts: an email and a password, and the person's plan kept on the server.

The app works fully without an account. Creating one only adds a saved copy of what the person
entered (cards, budget, recorded payments, progress), so it follows them to another device.
Passwords are stored as scrypt hashes with a per-user salt; session tokens are stored hashed.
Deleting the account removes the user, their sessions and their saved plan.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from . import models
from .db import get_session

router = APIRouter(prefix="/api")
SESSION_DAYS = 60
MAX_PLAN_BYTES = 200_000
# AI features are for signed-in people only, and metered per account.
AI_CALLS_PER_MINUTE = 10
FREE_DOCS = 1  # one test scan, ever
FREE_CHATS_PER_MONTH = 5
TRIAL_DAYS = 7
_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,180}\.[^@\s]{2,}$")


class Credentials(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=8, max_length=200)


class PlanBody(BaseModel):
    data: dict


class AiUseBody(BaseModel):
    kind: str = Field(pattern="^(chat|script|doc)$")


def _hash_password(password: str, salt: bytes) -> str:
    return hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32).hex()


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _open_session(db: Session, user: models.User) -> str:
    token = secrets.token_urlsafe(32)
    db.add(models.UserSession(token_hash=_token_hash(token), user_id=user.id, expires_at=_now() + timedelta(days=SESSION_DAYS)))
    db.commit()
    return token


def current_user(authorization: str | None = Header(default=None), db: Session = Depends(get_session)) -> models.User:
    token = (authorization or "").removeprefix("Bearer ").strip()
    row = db.get(models.UserSession, _token_hash(token)) if token else None
    expires = row.expires_at if row else None
    if expires is not None and expires.tzinfo is None:  # SQLite returns naive datetimes
        expires = expires.replace(tzinfo=timezone.utc)
    if row is None or expires is None or expires < _now():
        raise HTTPException(status_code=401, detail="Please sign in again.")
    user = db.get(models.User, row.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Please sign in again.")
    return user


@router.post("/auth/register", status_code=201)
def register(body: Credentials, db: Session = Depends(get_session)) -> dict:
    email = body.email.strip().lower()
    if not _EMAIL.match(email):
        raise HTTPException(status_code=422, detail="Enter a valid email address.")
    if db.query(models.User).filter_by(email=email).first():
        raise HTTPException(status_code=409, detail="There is already an account with this email. Sign in instead.")
    salt = secrets.token_bytes(16)
    user = models.User(email=email, salt=salt.hex(), password_hash=_hash_password(body.password, salt))
    db.add(user)
    db.commit()
    return {"token": _open_session(db, user), "email": email}


@router.post("/auth/login")
def login(body: Credentials, db: Session = Depends(get_session)) -> dict:
    email = body.email.strip().lower()
    user = db.query(models.User).filter_by(email=email).first()
    # the same work and the same answer whether or not the email exists
    salt = bytes.fromhex(user.salt) if user else b"\0" * 16
    ok = hmac.compare_digest(_hash_password(body.password, salt), user.password_hash if user else "")
    if not user or not ok:
        raise HTTPException(status_code=401, detail="The email or password is not right.")
    return {"token": _open_session(db, user), "email": email}


@router.post("/auth/logout", status_code=204)
def logout(authorization: str | None = Header(default=None), db: Session = Depends(get_session)) -> Response:
    token = (authorization or "").removeprefix("Bearer ").strip()
    row = db.get(models.UserSession, _token_hash(token)) if token else None
    if row:
        db.delete(row)
        db.commit()
    return Response(status_code=204)


def _aware(when: datetime) -> datetime:
    return when if when.tzinfo else when.replace(tzinfo=timezone.utc)  # SQLite returns naive datetimes


def _tier(db: Session, user: models.User) -> tuple[str, models.UserTier | None]:
    row = db.get(models.UserTier, user.id)
    plus = bool(row and row.plus_until and _aware(row.plus_until) > _now())
    return ("plus" if plus else "free"), row


def _used(db: Session, user: models.User, kind: str, since: datetime | None = None) -> int:
    q = db.query(models.AiUse).filter(models.AiUse.user_id == user.id, models.AiUse.kind == kind)
    return (q.filter(models.AiUse.at >= since) if since else q).count()


def _month_start() -> datetime:
    return _now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _account(db: Session, user: models.User) -> dict:
    tier, row = _tier(db, user)
    return {
        "tier": tier,
        "plus_until": _aware(row.plus_until).isoformat() if tier == "plus" and row and row.plus_until else None,
        "trial_used": bool(row and row.trial_used),
        "usage": {"docs_used": _used(db, user, "doc"), "docs_limit": FREE_DOCS, "chats_used": _used(db, user, "chat", _month_start()),
                  "chats_limit": FREE_CHATS_PER_MONTH, "calls_per_minute": AI_CALLS_PER_MINUTE},
    }


@router.get("/me")
def me(user: models.User = Depends(current_user), db: Session = Depends(get_session)) -> dict:
    saved = db.get(models.UserPlan, user.id)
    return {"email": user.email, "plan": json.loads(saved.data) if saved else None, "updated_at": saved.updated_at.isoformat() if saved else None,
            **_account(db, user)}


@router.post("/me/trial")
def start_trial(user: models.User = Depends(current_user), db: Session = Depends(get_session)) -> dict:
    """Seven days of Plus, once per account. No payment details are asked for and nothing is charged afterwards."""
    tier, row = _tier(db, user)
    if row and row.trial_used:
        raise HTTPException(status_code=409, detail="This account has already used its free trial.")
    if row is None:
        row = models.UserTier(user_id=user.id)
        db.add(row)
    row.plus_until = _now() + timedelta(days=TRIAL_DAYS)
    row.trial_used = True
    db.commit()
    return _account(db, user)


@router.put("/me/plan")
def save_plan(body: PlanBody, user: models.User = Depends(current_user), db: Session = Depends(get_session)) -> dict:
    raw = json.dumps(body.data, separators=(",", ":"))
    if len(raw) > MAX_PLAN_BYTES:
        raise HTTPException(status_code=413, detail="This plan is too large to save.")
    saved = db.get(models.UserPlan, user.id)
    if saved:
        saved.data = raw
        saved.updated_at = _now()
    else:
        db.add(models.UserPlan(user_id=user.id, data=raw, updated_at=_now()))
    db.commit()
    return {"saved": True}


@router.post("/ai/allow")
def ai_allow(body: AiUseBody, user: models.User = Depends(current_user), db: Session = Depends(get_session)) -> dict:
    """Asked by the AI service before it does any work. Says no with 401 (not signed in), 429 (too many
    requests this minute) or 403 (the Free allowance is used up); otherwise records the use."""
    now = _now()
    recent = db.query(models.AiUse).filter(models.AiUse.user_id == user.id, models.AiUse.at >= now - timedelta(seconds=60)).order_by(models.AiUse.at).all()
    if len(recent) >= AI_CALLS_PER_MINUTE:
        wait = max(1, 60 - int((now - _aware(recent[0].at)).total_seconds()))
        raise HTTPException(status_code=429, detail=f"That is {AI_CALLS_PER_MINUTE} AI requests in a minute, which is the limit. Try again in {wait} seconds.",
                            headers={"Retry-After": str(wait)})
    tier, _ = _tier(db, user)
    docs, chats = _used(db, user, "doc"), _used(db, user, "chat", _month_start())
    if tier == "free" and body.kind == "doc" and docs >= FREE_DOCS:
        raise HTTPException(status_code=403, detail="The Free plan reads one statement so you can try it, and you have used it. Plus reads them without a limit. "
                                                    "You can still type the numbers in, or import a spreadsheet.")
    if tier == "free" and body.kind == "chat" and chats >= FREE_CHATS_PER_MONTH:
        raise HTTPException(status_code=403, detail=f"The Free plan includes {FREE_CHATS_PER_MONTH} assistant questions a month and you have used them. Plus has no limit.")
    # keep the table small: scripts only matter for the per-minute limit, questions for the month
    db.query(models.AiUse).filter(models.AiUse.user_id == user.id, models.AiUse.kind.in_(["script", "failed"]), models.AiUse.at < now - timedelta(hours=1)).delete(synchronize_session=False)
    db.query(models.AiUse).filter(models.AiUse.user_id == user.id, models.AiUse.kind == "chat", models.AiUse.at < now - timedelta(days=62)).delete(synchronize_session=False)
    use = models.AiUse(user_id=user.id, kind=body.kind, at=now)
    db.add(use)
    db.commit()
    return {"id": use.id, "tier": tier,
            "docs_left": None if tier == "plus" else max(0, FREE_DOCS - docs - (body.kind == "doc")),
            "chats_left": None if tier == "plus" else max(0, FREE_CHATS_PER_MONTH - chats - (body.kind == "chat"))}


@router.delete("/ai/use/{use_id}", status_code=204)
def ai_refund(use_id: str, user: models.User = Depends(current_user), db: Session = Depends(get_session)) -> Response:
    """A document that could not be read does not count against the month."""
    use = db.get(models.AiUse, use_id)
    if use and use.user_id == user.id and use.kind == "doc":
        use.kind = "failed"  # still counts toward the per-minute limit
        db.commit()
    return Response(status_code=204)


@router.put("/me/plan")
def save_plan(body: PlanBody, user: models.User = Depends(current_user), db: Session = Depends(get_session)) -> dict:
    raw = json.dumps(body.data, separators=(",", ":"))
    if len(raw) > MAX_PLAN_BYTES:
        raise HTTPException(status_code=413, detail="This plan is too large to save.")
    saved = db.get(models.UserPlan, user.id)
    if saved:
        saved.data = raw
        saved.updated_at = _now()
    else:
        db.add(models.UserPlan(user_id=user.id, data=raw, updated_at=_now()))
    db.commit()
    return {"saved": True}


@router.delete("/me", status_code=204)
def delete_me(user: models.User = Depends(current_user), db: Session = Depends(get_session)) -> Response:
    """Removes the account and everything stored for it. There is no copy kept."""
    db.query(models.UserSession).filter_by(user_id=user.id).delete()
    db.query(models.AiUse).filter_by(user_id=user.id).delete()
    db.query(models.UserTier).filter_by(user_id=user.id).delete()
    saved = db.get(models.UserPlan, user.id)
    if saved:
        db.delete(saved)
    db.delete(user)
    db.commit()
    return Response(status_code=204)
