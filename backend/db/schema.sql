-- FinPilot schema (PostgreSQL). Mirrors backend/app/models.py.
-- Money: integer cents. Rates: basis points (29.00% = 2900).
-- No names, emails, card numbers or bank logins are stored anywhere.

CREATE TABLE plans (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    edit_token_hash       CHAR(64)    NOT NULL,              -- sha256 of the token shown once on create
    goal                  VARCHAR(20) NOT NULL DEFAULT 'less_interest'
                          CHECK (goal IN ('less_interest', 'faster_payoff', 'future_loan', 'tight_budget')),
    strategy              VARCHAR(12) NOT NULL DEFAULT 'avalanche'
                          CHECK (strategy IN ('avalanche', 'snowball')),
    monthly_budget_cents  INTEGER     NOT NULL CHECK (monthly_budget_cents >= 0),  -- includes minimums
    currency              CHAR(3)     NOT NULL DEFAULT 'USD',
    start_month           DATE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cards (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id                  UUID        NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    position                 SMALLINT    NOT NULL DEFAULT 0,
    nickname                 VARCHAR(40) NOT NULL,            -- "Card A". Never a card number
    current_balance_cents    INTEGER     NOT NULL CHECK (current_balance_cents >= 0),
    statement_balance_cents  INTEGER     CHECK (statement_balance_cents >= 0),
    apr_bps                  INTEGER     CHECK (apr_bps BETWEEN 0 AND 10000),  -- NULL = unknown, no interest forecast
    minimum_payment_cents    INTEGER     NOT NULL CHECK (minimum_payment_cents >= 0),
    due_day                  SMALLINT    CHECK (due_day BETWEEN 1 AND 31),
    statement_close_day      SMALLINT    CHECK (statement_close_day BETWEEN 1 AND 31),
    credit_limit_cents       INTEGER     CHECK (credit_limit_cents > 0),       -- NULL = limit use not calculated
    minimum_rule             VARCHAR(120),                    -- issuer's rule if known, else the assumption applies
    promo_apr_bps            INTEGER     CHECK (promo_apr_bps BETWEEN 0 AND 10000),
    promo_ends_on            DATE,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cards_plan_idx ON cards(plan_id);

-- What a new statement really said. The plan is rebuilt from the latest row per card.
CREATE TABLE balance_updates (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id                  UUID        NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    statement_balance_cents  INTEGER     NOT NULL CHECK (statement_balance_cents >= 0),
    minimum_payment_cents    INTEGER     CHECK (minimum_payment_cents >= 0),
    due_date                 DATE,
    estimated_balance_cents  INTEGER,                         -- what the plan expected, for the "differs by" note
    recorded_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX balance_updates_card_idx ON balance_updates(card_id, recorded_at DESC);

-- The user's own tick that a payment was made. Not a transfer and not a bank confirmation.
CREATE TABLE payment_marks (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id        UUID        NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    period_month   DATE        NOT NULL,                      -- first day of the month the payment belongs to
    planned_cents  INTEGER     NOT NULL CHECK (planned_cents >= 0),
    paid_cents     INTEGER     CHECK (paid_cents >= 0),
    paid_on        DATE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (card_id, period_month)
);

-- A saved what-if. result caches the engine output.
CREATE TABLE scenarios (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id                 UUID        NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    name                    VARCHAR(60) NOT NULL,
    budget_cents            INTEGER     CHECK (budget_cents >= 0),
    one_time_cents          INTEGER     CHECK (one_time_cents >= 0),
    low_month               DATE,
    low_month_budget_cents  INTEGER     CHECK (low_month_budget_cents >= 0),
    card_id                 UUID        REFERENCES cards(id) ON DELETE SET NULL,
    new_apr_bps             INTEGER     CHECK (new_apr_bps BETWEEN 0 AND 10000),
    result                  JSONB,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scenarios_plan_idx ON scenarios(plan_id);

-- Terms a bank confirmed on a call. Changes the card only when applied is true.
CREATE TABLE bank_offers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id         UUID        NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    outcome         VARCHAR(12) NOT NULL DEFAULT 'accepted' CHECK (outcome IN ('accepted', 'declined', 'pending')),
    new_apr_bps     INTEGER     CHECK (new_apr_bps BETWEEN 0 AND 10000),
    starts_on       DATE,
    ends_on         DATE,                                     -- NULL = permanent
    fee_cents       INTEGER     NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
    call_date       DATE,
    reference_note  VARCHAR(120),
    applied         BOOLEAN     NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bank_offers_card_idx ON bank_offers(card_id);

-- Bank-call script text. source says whether AI wording or the fixed template was used.
CREATE TABLE call_scripts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id     UUID        NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    purpose     VARCHAR(20) NOT NULL DEFAULT 'lower_apr' CHECK (purpose IN ('lower_apr', 'hardship')),
    source      VARCHAR(12) NOT NULL DEFAULT 'template' CHECK (source IN ('template', 'ai')),
    model       VARCHAR(40),
    body        TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX call_scripts_card_idx ON call_scripts(card_id);

-- A computed forecast kept for history.
CREATE TABLE plan_snapshots (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id               UUID        NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    strategy              VARCHAR(12) NOT NULL,
    status                VARCHAR(16) NOT NULL,               -- ok | shortfall | apr_unknown | no_debt | not_converging
    debt_free_month       DATE,                               -- NULL unless status = ok
    total_interest_cents  INTEGER,
    payload               JSONB       NOT NULL,
    computed_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX plan_snapshots_plan_idx ON plan_snapshots(plan_id, computed_at DESC);
