# Database schema

Source of truth: [`backend/db/schema.sql`](../backend/db/schema.sql) (PostgreSQL) and
[`backend/app/models.py`](../backend/app/models.py) (ORM, also runs on SQLite for local work).

## Rules

- **No personal data.** There is no users table. A plan is anonymous and is opened with an
  edit token that is shown once; only its SHA-256 hash is stored.
- **Money is integer cents, rates are basis points** (29.00% = 2900). Nothing is rounded in storage.
- **Saving is optional.** `POST /api/plan/calculate` stores nothing. Rows exist only if the
  person chooses to save.
- **Deleting a plan deletes everything under it** (`ON DELETE CASCADE`).
- **Unknown stays unknown.** `apr_bps` and `credit_limit_cents` are nullable on purpose: a
  missing APR means no interest forecast, a missing limit means no limit-use figure.

## Diagram

```mermaid
erDiagram
    plans ||--o{ cards : has
    plans ||--o{ scenarios : "what-ifs"
    plans ||--o{ plan_snapshots : "forecast history"
    cards ||--o{ balance_updates : "statement updates"
    cards ||--o{ payment_marks : "paid ticks"
    cards ||--o{ bank_offers : "confirmed terms"
    cards ||--o{ call_scripts : "bank call text"
    cards |o--o{ scenarios : "APR what-if"

    plans {
        uuid id PK
        char64 edit_token_hash
        varchar goal "less_interest | faster_payoff | future_loan | tight_budget"
        varchar strategy "avalanche | snowball"
        int monthly_budget_cents "includes minimums"
        char3 currency
        date start_month
        timestamptz created_at
        timestamptz updated_at
    }
    cards {
        uuid id PK
        uuid plan_id FK
        smallint position
        varchar nickname "never a card number"
        int current_balance_cents
        int statement_balance_cents "nullable"
        int apr_bps "nullable = unknown"
        int minimum_payment_cents
        smallint due_day
        smallint statement_close_day
        int credit_limit_cents "nullable"
        varchar minimum_rule
        int promo_apr_bps
        date promo_ends_on
    }
    balance_updates {
        uuid id PK
        uuid card_id FK
        int statement_balance_cents
        int minimum_payment_cents
        date due_date
        int estimated_balance_cents "what the plan expected"
        timestamptz recorded_at
    }
    payment_marks {
        uuid id PK
        uuid card_id FK
        date period_month "unique with card_id"
        int planned_cents
        int paid_cents
        date paid_on
    }
    scenarios {
        uuid id PK
        uuid plan_id FK
        varchar name
        int budget_cents
        int one_time_cents
        date low_month
        int low_month_budget_cents
        uuid card_id FK "nullable"
        int new_apr_bps
        jsonb result
    }
    bank_offers {
        uuid id PK
        uuid card_id FK
        varchar outcome "accepted | declined | pending"
        int new_apr_bps
        date starts_on
        date ends_on "null = permanent"
        int fee_cents
        date call_date
        varchar reference_note
        boolean applied
    }
    call_scripts {
        uuid id PK
        uuid card_id FK
        varchar purpose "lower_apr | hardship"
        varchar source "template | ai"
        varchar model
        text body
    }
    plan_snapshots {
        uuid id PK
        uuid plan_id FK
        varchar strategy
        varchar status "ok | shortfall | apr_unknown | ..."
        date debt_free_month "null unless ok"
        int total_interest_cents
        jsonb payload
        timestamptz computed_at
    }
```

## Which screen writes which table

| Screen | Table |
|---|---|
| Setup: goal, budget | `plans` |
| Setup: add cards | `cards` |
| Plan, 90 days, Forecast | `plan_snapshots` (cache only; always recomputable) |
| Update balances | `balance_updates`, `payment_marks` |
| What if | `scenarios` |
| Bank call: script | `call_scripts` |
| Bank call: enter the offer | `bank_offers`, then `cards.apr_bps` when applied |
| Your data: delete | deletes the `plans` row and everything under it |

## Not in the schema yet

These belong to the extended concept, outside the hackathon scope: other debts and regular
bills (hub), paydays and a checking balance (bills shield), the Credit Health Index, and
refinance offers.
