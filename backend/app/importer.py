"""Read credit cards from a spreadsheet the person uploads (CSV or Excel).

Plain code, no AI: column headings are matched against known names. Nothing is stored; the
result goes to the "check your inputs" screen so the person confirms every number.
"""
from __future__ import annotations

import csv
import io
import re
from datetime import date, datetime

MAX_BYTES = 2_000_000
MAX_CARDS = 3

# our field -> words that may appear in a column heading (lower-case, compared after cleaning)
COLUMNS: dict[str, tuple[str, ...]] = {
    "name": ("card", "name", "nickname", "account", "issuer"),
    "balance": ("balance", "owed", "debt", "amount owed", "current balance", "statement balance"),
    "apr": ("apr", "rate", "interest", "interest rate", "purchase apr"),
    "minimum": ("minimum", "min", "minimum payment", "min payment", "minimum due", "minimum payment due"),
    "due_day": ("due", "due day", "due date", "payment due", "payment due date"),
    "limit": ("limit", "credit limit", "credit line"),
}


class ImportProblem(ValueError):
    """A message that can be shown to the person as-is."""


def _clean(heading: object) -> str:
    return re.sub(r"[^a-z ]+", " ", str(heading or "").lower()).strip()


def _match(heading: str) -> str | None:
    """Which of our fields a column heading names, preferring the longest matching phrase."""
    best: tuple[int, str] | None = None
    for field_name, words in COLUMNS.items():
        for w in words:
            if heading == w or re.search(rf"\b{re.escape(w)}\b", heading):
                if best is None or len(w) > best[0]:
                    best = (len(w), field_name)
    return best[1] if best else None


def _number(value: object) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = re.sub(r"[^0-9.\-]", "", str(value).replace(",", ""))
    try:
        return float(text) if text not in ("", "-", ".") else None
    except ValueError:
        return None


def _due_day(value: object) -> int | None:
    if isinstance(value, (datetime, date)):
        return value.day
    text = str(value or "").strip()
    # formats without a year are parsed with a fixed leap year, so "Feb 29" is accepted
    for candidate, fmt in ((text, "%Y-%m-%d"), (text, "%m/%d/%Y"), (text, "%m/%d/%y"), (text, "%d.%m.%Y"), (text, "%b %d, %Y"), (text, "%B %d, %Y"),
                           (text + " 2000", "%b %d %Y"), (text + " 2000", "%B %d %Y")):
        try:
            return datetime.strptime(candidate, fmt).day
        except ValueError:
            pass
    n = _number(text)
    return int(n) if n is not None and 1 <= n <= 31 and float(n).is_integer() else None


def _rows(filename: str, data: bytes) -> list[list[object]]:
    lower = filename.lower()
    if lower.endswith((".xlsx", ".xlsm")):
        from openpyxl import load_workbook

        try:
            sheet = load_workbook(io.BytesIO(data), read_only=True, data_only=True).worksheets[0]
        except Exception as exc:  # corrupt or not really an Excel file
            raise ImportProblem("We couldn't open this Excel file. Save it again as .xlsx or .csv and retry.") from exc
        return [list(r) for r in sheet.iter_rows(values_only=True)]
    if lower.endswith(".xls"):
        raise ImportProblem("Old .xls files aren't supported. Save the file as .xlsx or .csv and try again.")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("latin-1")
    try:
        dialect = csv.Sniffer().sniff(text[:4000], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    return [list(r) for r in csv.reader(io.StringIO(text), dialect)]


def read_cards(filename: str, data: bytes) -> dict:
    """Returns {"cards": [...], "notes": [...]}; cards use the API's CardIn field names."""
    if len(data) > MAX_BYTES:
        raise ImportProblem("This file is larger than 2 MB. Upload a smaller sheet with just your cards.")
    rows = [r for r in _rows(filename, data) if any(str(c or "").strip() for c in r)]
    # the heading row is the first one that names at least a balance column
    header_at, mapping = None, {}
    for i, row in enumerate(rows[:15]):
        found: dict[str, int] = {}
        for col, heading in enumerate(row):
            field_name = _match(_clean(heading))
            if field_name and field_name not in found:
                found[field_name] = col
        if "balance" in found:
            header_at, mapping = i, found
            break
    if header_at is None:
        raise ImportProblem('We couldn\'t find a "Balance" column. Add a heading row such as: Card, Balance, APR, Minimum, Due day, Limit.')

    def cell(row: list[object], field_name: str) -> object:
        col = mapping.get(field_name)
        return row[col] if col is not None and col < len(row) else None

    cards, notes = [], []
    for n, row in enumerate(rows[header_at + 1:], start=1):
        balance = _number(cell(row, "balance"))
        if balance is None or balance < 0:
            continue
        name = str(cell(row, "name") or "").strip()[:40] or f"Card {'ABC'[len(cards)] if len(cards) < 3 else len(cards) + 1}"
        apr = _number(cell(row, "apr"))
        if apr is not None and 0 < apr < 1:  # 0.29 entered as a fraction
            apr = round(apr * 100, 2)
        if apr is not None and not 0 <= apr <= 100:
            notes.append(f"{name}: the APR in the file ({apr:g}) doesn't look like a percentage, so it was left empty.")
            apr = None
        limit = _number(cell(row, "limit"))
        card = {
            "name": name,
            "balance": round(balance, 2),
            "minimum": round(_number(cell(row, "minimum")) or 0, 2),
            "apr": apr,
            "due_day": _due_day(cell(row, "due_day")),
            "limit": limit if limit and limit > 0 else None,
        }
        if not card["minimum"]:
            notes.append(f"{name}: no minimum payment found. Add it before calculating.")
        if card["apr"] is None:
            notes.append(f"{name}: no APR found. Without it there is no interest forecast.")
        cards.append(card)
    if not cards:
        raise ImportProblem("We found the headings but no rows with a balance under them.")
    if len(cards) > MAX_CARDS:
        notes.append(f"The file has {len(cards)} cards. This version plans up to {MAX_CARDS}, so the first {MAX_CARDS} were used.")
        cards = cards[:MAX_CARDS]
    missing = [f for f in ("apr", "minimum", "due_day", "limit") if f not in mapping]
    if missing:
        labels = {"apr": "APR", "minimum": "minimum payment", "due_day": "due day", "limit": "credit limit"}
        notes.append("No column found for: " + ", ".join(labels[f] for f in missing) + ".")
    return {"cards": cards, "notes": notes}
