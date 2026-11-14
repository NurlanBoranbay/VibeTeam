# FinPilot financial model and scope

FinPilot forecasts one thing: **ordinary purchase balances that are already charged interest**. Every
other situation is recognised and explained, and is never pushed through the APR calculator.

Who it is for: a US consumer who already carries interest-bearing credit-card purchase debt and wants
to spread an affordable monthly budget across cards.

## How a card is classified

Each card carries a `treatment` that the person chooses ("Which best describes this card?"). It is
never inferred, by the app or by AI. An "Interest charged: $0" line, an APR of 0, or a positive
balance does not decide anything. A card that has not been classified (including every imported card)
is treated as "not sure".

The decision is made in one place, `card_support()` in `backend/app/engine.py`, and every entry route
(manual entry, CSV/Excel, PDF, photo, pasted text) goes through the same setup screen and the same
function.

## Scenario-support matrix

| Situation | How it is recognised | What the app does | Forecast |
|---|---|---|---|
| Ordinary revolving purchase debt | "I carry a balance and pay regular purchase interest", APR known, not mixed, not past due | Minimums, extra allocation, schedule, interest, comparisons, credit usage | **Yes** |
| Same, APR missing | APR left empty | Minimums only; the extra budget is shown as not yet placed (avalanche); asks for the APR | No interest forecast |
| Pays statements in full, grace period confirmed | "I normally pay my statement in full" + "Yes" + can pay in full | Reminder: statement amount to pay and its due date, if entered. No interest, no savings claim, no minimum-only advice | No (none needed) |
| Pays in full, grace not confirmed, or can't pay in full this time | Answer "No" / "Not sure" / "can't pay it in full" | "Terms need review". Losing a grace period is not calculated from one balance | No |
| 0% introductory APR | Promotional offer → "0% introductory APR" + end date | Shows the offer and its end date. 0% is never assumed to continue | No |
| Deferred interest ("no interest if paid in full by …") | Promotional offer → "No interest if paid in full by a deadline" | Shows the deadline and that interest for the whole period can be charged at once. The liability is not calculated | No |
| Balance transfer / special arrangement | Promotional offer → "balance transfer or another special arrangement" | Says it needs a more detailed model (fees, own rate, own end date) | No |
| Cash advance, transfer, deferred-interest or installment part on a revolving card | Checkbox on a revolving card | "More than one rate on this card": the purchase APR is not applied to the whole balance | No |
| Past due, hardship or special repayment arrangement | Checkbox on any card, or a due date already passed and not marked paid | Flagged; the date is not moved forward; asks to confirm amount and terms with the issuer | No |
| Not sure | "I'm not sure", or unanswered | Asks for the classification; nothing is assumed | No |
| Paid-off card | Balance 0 | No payment; its limit still counts toward credit usage | n/a |
| Budget below the minimums still due | Arithmetic | Shortfall amount and issuer-contact steps; no payoff date | No |

**Mixed portfolios.** If any card with a balance is outside the first row, the plan status is
`limited` (or `pay_in_full` when every card is paid in full). All entered information is kept, each
card shows what is known and what to check, the blocking cards are named, and there is no combined
debt-free date, interest figure, savings claim or projected credit usage. The budget is not quietly
spent on the remaining cards. There is no "supported cards only" partial plan yet.

**Credit usage** is separate from interest. Current usage is shown from balances and limits whenever
limits are entered; projected usage only exists when there is a forecast. Combined usage is total
balances ÷ total limits and needs every limit. No score prediction.

## Amounts are kept apart

| Field | Meaning | Used for |
|---|---|---|
| `balance` | Current posted balance, as shown by the issuer | Revolving forecast; current credit usage |
| `statement_due` | Issuer-confirmed amount still to pay toward the latest statement | Pay-in-full reminder only. Never derived from the current balance |
| `minimum` | Minimum still due for the upcoming due date | Revolving forecast. An empty field is not $0 |
| `min_paid` | The minimum for the upcoming due date is already paid | That minimum is not scheduled again in the first month |
| `apr` | Purchase APR | Revolving forecast. Unknown never becomes 0% |
| `limit` | Full credit limit | Credit usage |
| `next_due` | Actual next due date | First due date; later ones are estimated from its day of month |
| `paid` | Dollars already paid toward the upcoming due date (from payments the person recorded) | Lowers that card's minimum still due and this cycle's remaining budget; the balance is used as entered |
| `first_month_budget` | A different total for the current cycle only (a one-off bonus or a short month) | First cycle only |

Not collected yet: the balance as-of date (the plan uses the day it is calculated), and the statement
balance as its own field in manual entry (imports report which label the balance was read from).

## Calculation convention (supported cards only)

- **Start:** the day the plan is calculated.
- **Period:** a rolling month from the start date (start Nov 14 → Nov 14–Dec 13). Each card is paid
  once per period, on its due day inside it.
- **Interest:** `balance × APR ÷ 12`, added to each card **before** that period's payment. Payment
  dates inside a period do not change interest in this model.
- **Minimums first:** each card gets `min(minimum, balance after interest)`. If the budget cannot
  cover them, the result is a shortfall and nothing else.
- **Extra:** what is left goes to one card at a time, highest APR first (or smallest balance first),
  and rolls to the next card when one is cleared.
- **Caps:** a payment never exceeds the card's balance after interest. The period's total never
  exceeds the budget.
- **Final payment:** the remaining balance plus that period's modelled interest.
- **Rounding:** calculated in floating-point dollars, rounded to cents in what is returned; balances
  under half a cent are treated as zero.
- **One simulation:** Plan, Schedule, Compare, credit usage, calendar and What-if all read the same
  result. The plan's first payment is the schedule's first row.
- "Keep paying today's minimums" holds the entered minimums constant. It is an approximation, not the
  issuer's future minimum schedule.

Shown to users as: "Estimated with a monthly interest model. Your issuer may calculate interest daily,
so actual charges and payoff amounts can differ."

## Import and AI

AI is used only to read a statement and to word the bank-call script. Classification, eligibility and
all arithmetic are deterministic.

After any read (AI or pattern), fixed rules run on the statement text and can only remove certainty:

- Every rate is kept with its own label (Purchases, Cash advances, Balance transfers, promotional).
- The purchase APR is only the rate printed next to "Purchases", and only when no promotional or
  introductory rate is listed; otherwise it is left empty for the person to confirm.
- Promotional or deferred-interest wording adds a note to mark the card as a promotional offer.
- "Interest charged $0" adds a note that it proves neither a grace period nor a 0% offer.
- The label the balance was read from ("New Balance", "Statement Balance", …) is reported.
- Imported cards arrive unclassified and must be confirmed in setup before any forecast.

## Assumptions that remain in the engine

1. Interest is monthly (`APR ÷ 12`), not daily, and ignores when in the period a payment lands.
2. No new purchases, fees or credits during the forecast.
3. APRs stay as entered.
4. Minimum payments are held at today's dollar amounts.
5. The person can fund each payment by its due date; income dates are not collected.
6. Later due dates repeat on the same day of the month.
7. The balance is taken as of the day the plan is calculated.
8. The classification is the person's own answer; the app does not verify issuer terms.
9. A recorded payment lowers the stored balance by exactly that amount (no interest added) until the person enters the balance from their banking app.
10. A recorded payment counts toward a card's upcoming due date when it was made in the month before that date.

## Tests

`backend/tests/test_acceptance.py` holds the scope and routing tests; `ai/tests/test_statement.py`
holds the import rules.

```bash
cd backend && python -m unittest discover -s tests -t .
```

```bash
cd ai && python -m unittest discover -s tests -t .
```
