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
_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,180}\.[^@\s]{2,}$")


class Credentials(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=8, max_length=200)


class PlanBody(BaseModel):
    data: dict


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


@router.get("/me")
def me(user: models.User = Depends(current_user), db: Session = Depends(get_session)) -> dict:
    saved = db.get(models.UserPlan, user.id)
    return {"email": user.email, "plan": json.loads(saved.data) if saved else None, "updated_at": saved.updated_at.isoformat() if saved else None}


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
    saved = db.get(models.UserPlan, user.id)
    if saved:
        db.delete(saved)
    db.delete(user)
    db.commit()
    return Response(status_code=204)
