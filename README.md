# FinPilot

A credit card payoff plan. Enter your cards and the amount you can put toward them each
month; FinPilot says what to pay on each card, lays out the next 90 days and estimates the
debt-free month. No sign-up, no card numbers, no bank connection.

Demo example: three cards, $4,600 owed, $500 a month → $410 / $60 / $30 this month,
estimated debt-free month September 2027, about $530 in interest.

## Layout

| Folder | What it is | Stack |
|---|---|---|
| [`backend/`](backend) | Payoff engine, HTTP API, database models | Python, FastAPI, SQLAlchemy |
| [`frontend/`](frontend) | Web app | React, TypeScript, Vite |
| [`ai/`](ai) | Bank-call script wording | Python, FastAPI, Claude API |
| [`docs/`](docs) | [Database schema and diagram](docs/db-schema.md) | |

The calculator, the payment split and the what-if scenarios are plain code in
`backend/app/engine.py`. AI is used only to reword the bank-call script, and its output is
rejected if it contains a number that is not in the plan.

## Run it

Backend (port 8000):

```bash
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
```

AI service (port 8001). Without `ANTHROPIC_API_KEY` it still works and returns the standard script:

```bash
cd ai
python -m pip install -r requirements.txt
python -m uvicorn service:app --reload --port 8001
```

Frontend (port 5173, needs Node 18+):

```bash
cd frontend
npm install
npm run dev
```

Interactive API docs: http://localhost:8000/docs

## Tests

```bash
cd backend && python -m unittest discover -s tests -t .
cd ai && python -m unittest discover -s tests -t .
```

The backend tests cover the brief's pre-demo checklist: payments stay inside the budget,
minimums are covered, freed money rolls to the next card, zero balance and 0% APR work, and
no debt-free month is returned when the budget is short or an APR is missing.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/plan/calculate` | Split, 90-day schedule, forecast, strategy comparison. Stores nothing. |
| POST | `/api/plan/scenario` | What-if: one-time payment and/or one lower month, against the baseline. |
| POST | `/api/plans` | Optional save. Returns an edit token once. |
| GET | `/api/plans/{id}` | Load a saved plan (header `X-Plan-Token`). |
| DELETE | `/api/plans/{id}` | Delete a saved plan and everything under it. |
| POST | `:8001/call-script` | Bank-call script for one card. |

## How the forecast is calculated

- Interest is estimated monthly: balance × APR ÷ 12, added before that month's payment.
- Minimums are reserved first. The rest goes to the highest APR (or the smallest balance).
- Minimum payments stay at today's dollar amounts; there are no new purchases.
- Results are estimates. FinPilot does not move money or confirm payments with a bank.
