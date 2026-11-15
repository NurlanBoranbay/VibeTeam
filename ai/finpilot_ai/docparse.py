"""Read any document through the docparse service: PDF, photo, scan, Word, Excel -> Markdown.

docparse renders every format to pages and reads them with a layout OCR model, so a phone photo of
a statement and its PDF come back as the same text. This module only sends the file and returns the
text; what the figures mean is decided afterwards by statement.read_statement.

Configuration (environment): DOCPARSE_URL (for example http://10.205.205.27:8097) and
DOCPARSE_API_KEY (sent as X-API-Key; the service ignores it while it runs without auth).
"""
from __future__ import annotations

import os
import re

import httpx


class DocparseUnavailable(RuntimeError):
    """The service is not configured or did not answer; the caller falls back to local reading."""


class DocparseProblem(ValueError):
    """The service answered, and this file could not be read. The message can be shown as-is."""


def configured() -> bool:
    return bool(os.environ.get("DOCPARSE_URL"))


def to_text(markdown: str) -> str:
    """Markdown with HTML tables -> plain text lines, one table row per line, so figures keep their labels."""
    text = re.sub(r"</tr\s*>", "\n", markdown, flags=re.I)
    text = re.sub(r"</t[dh]\s*>", "   ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"<!--.*?-->", " ", text, flags=re.S)
    return re.sub(r"[ \t]+", " ", text).strip()


def parse(filename: str, data: bytes, timeout: float = 240.0) -> str:
    url = os.environ.get("DOCPARSE_URL", "").rstrip("/")
    if not url:
        raise DocparseUnavailable("DOCPARSE_URL is not set")
    key = os.environ.get("DOCPARSE_API_KEY", "")
    try:
        r = httpx.post(f"{url}/v1/extract", files={"files": (filename or "statement", data)}, data={"describe_images": "false"},
                       headers={"X-API-Key": key} if key else {}, timeout=httpx.Timeout(timeout, connect=5.0))
    except httpx.HTTPError as exc:
        raise DocparseUnavailable(type(exc).__name__) from exc
    if r.status_code in (401, 403):
        raise DocparseUnavailable("docparse refused the key")
    if r.status_code >= 500:
        raise DocparseUnavailable(f"docparse answered {r.status_code}")
    if r.status_code >= 400:
        raise DocparseProblem("This file could not be read. Try a PDF, a clear photo or a Word file.")
    try:
        out = r.json()
        first = (out.get("files") or [{}])[0]
    except ValueError as exc:
        raise DocparseUnavailable("docparse sent an unreadable answer") from exc
    if first.get("status") == "error":
        raise DocparseProblem("This file could not be read: it may be damaged or password-protected.")
    text = to_text(first.get("markdown") or out.get("markdown") or "")
    if len(text) < 40:
        raise DocparseProblem("No readable text was found in this file. Make sure the statement summary is sharp and fully in frame.")
    return text
