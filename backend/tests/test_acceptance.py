"""Acceptance tests for the financial scope: which cards are forecast, and which are only recognised.

These test the model and its routing. Nothing here is hardcoded into the interface.
"""
import unittest
from datetime import date

from app.engine import Card, build_plan, card_support, simulate

START = date(2026, 11, 14)


def rev(cid="a", balance=1000.0, minimum=25.0, apr=24.0, **more):
    return Card(cid, f"Card {cid.upper()}", balance, minimum, apr, **more)


class ScopeTest(unittest.TestCase):
    def assertNoForecast(self, plan):
        self.assertIsNone(plan["forecast"])
        self.assertEqual((plan["this_cycle"], plan["cycles"], plan["comparison"]), ([], [], []))
        self.assertIsNone(plan["limit_use"]["after_pct"])

    def test_pay_in_full_with_grace_gets_a_reminder_not_interest(self):
        card = Card("a", "Card A", 1300, 35, 29, treatment="pay_in_full", grace="yes", statement_due=1000, next_due="2026-12-05", limit=5000)
        plan = build_plan([card], 500, start=START)
        self.assertEqual(plan["status"], "pay_in_full")
        self.assertNoForecast(plan)
        status = plan["card_status"][0]
        # the statement amount is the obligation; the $1,300 current balance is never presented as due
        self.assertEqual((status["kind"], status["amount"], status["due"]), ("grace", 1000, "2026-12-05"))
        self.assertIn("may be able to avoid purchase interest", status["message"])
        self.assertEqual(plan["limit_use"]["cards"][0]["now_pct"], 26.0)  # current usage is still shown

    def test_statement_amount_is_never_derived_from_balances(self):
        card = Card("a", "Card A", 1300, 35, 29, treatment="pay_in_full", grace="yes")
        self.assertIsNone(card_support(card, START)["amount"])

    def test_zero_interest_charged_with_unknown_treatment_asks(self):
        plan = build_plan([Card("a", "Card A", 800, 25, 29, treatment="unsure")], 500, start=START)
        self.assertEqual((plan["status"], plan["card_status"][0]["code"], plan["blocked_by"]), ("limited", "unsure", ["Card A"]))
        self.assertNoForecast(plan)

    def test_pay_in_full_without_confirmed_grace_or_ability_needs_review(self):
        for more in ({"grace": "unsure"}, {"grace": "no"}, {"grace": "yes", "can_pay_full": False}, {}):
            card = Card("a", "Card A", 1300, 35, 29, treatment="pay_in_full", **more)
            self.assertEqual(card_support(card, START)["code"], "grace_review", more)

    def test_monthly_model_adds_interest_before_the_payment(self):
        row = build_plan([rev(minimum=25)], 100, start=START)["cycles"][0]["payments"][0]
        self.assertEqual((row["interest"], row["total"], row["end_balance"]), (20, 100, 920))
        more = build_plan([rev(minimum=25)], 150, start=START)
        self.assertEqual(more["cycles"][0]["payments"][0]["end_balance"], 870)
        self.assertEqual(more["this_cycle"], more["cycles"][0]["payments"])  # plan and schedule agree

    def test_small_balance_final_payment_includes_modelled_interest(self):
        plan = build_plan([Card("a", "Card A", 10, 40, 29, due_day=22)], 500, start=START)
        self.assertEqual(plan["this_cycle"], plan["cycles"][0]["payments"])
        self.assertEqual((plan["this_cycle"][0]["total"], plan["this_cycle"][0]["payoff"]), (10.24, True))

    def test_missing_apr_gives_no_confident_avalanche(self):
        plan = build_plan([rev("a", apr=None), rev("b", 500, 25, 19)], 300, start=START)
        self.assertEqual((plan["status"], plan["forecast"]), ("apr_unknown", None))
        self.assertTrue(all(p["extra"] == 0 for p in plan["this_cycle"]))
        self.assertEqual((plan["unallocated"], plan["missing_apr"]), (250, ["Card A"]))

    def test_zero_percent_offer_is_not_extended_forever(self):
        card = Card("a", "Card A", 2000, 40, 0, treatment="promo", promo_kind="intro_zero", promo_end="2027-03-01")
        plan = build_plan([card], 500, start=START)
        self.assertEqual((plan["status"], plan["card_status"][0]["code"]), ("limited", "promo_zero"))
        self.assertNoForecast(plan)
        self.assertIn("Mar 1, 2027", plan["card_status"][0]["message"])

    def test_deferred_interest_is_not_ordinary_zero_percent(self):
        card = Card("a", "Card A", 1, 25, 0, treatment="promo", promo_kind="deferred", promo_end="2026-12-01")
        plan = build_plan([card], 500, start=START)
        status = plan["card_status"][0]
        self.assertEqual((plan["status"], status["code"]), ("limited", "promo_deferred"))
        self.assertIn("interest for the entire period", status["message"])  # not just interest on the $1 left
        self.assertNoForecast(plan)

    def test_cash_advance_or_transfer_blocks_the_whole_card_forecast(self):
        mixed = build_plan([rev(mixed=True)], 500, start=START)
        self.assertEqual((mixed["status"], mixed["card_status"][0]["code"]), ("limited", "mixed"))
        transfer = build_plan([Card("a", "Card A", 900, 25, 0, treatment="promo", promo_kind="transfer")], 500, start=START)
        self.assertEqual(transfer["card_status"][0]["code"], "promo_transfer")
        self.assertNoForecast(mixed)
        self.assertNoForecast(transfer)

    def test_budget_below_minimums_is_a_shortfall(self):
        plan = build_plan([rev("a", 1500, 40, 29), rev("b", 2500, 60, 24), rev("c", 600, 30, 19)], 100, start=START)
        self.assertEqual((plan["status"], plan["shortfall"], plan["forecast"]), ("shortfall", 30, None))

    def test_confirmed_zero_minimum_is_accepted(self):
        plan = build_plan([rev(minimum=0)], 100, start=START)
        self.assertEqual(plan["status"], "ok")
        self.assertEqual(plan["this_cycle"][0]["total"], 100)
        self.assertEqual(plan["minimums_total"], 0)

    def test_minimum_already_paid_is_not_scheduled_again(self):
        cards = [rev("a", 1000, 25, 24, min_paid=True), rev("b", 1000, 30, 29)]
        plan = build_plan(cards, 55, start=START, budget_overrides={1: 30})  # only Card B's minimum is still due this month
        first = {p["card_id"]: p for p in plan["cycles"][0]["payments"]}
        self.assertEqual(plan["status"], "ok")
        self.assertNotIn("a", first)
        self.assertEqual(first["b"]["total"], 30)
        second = {p["card_id"]: p["minimum"] for p in plan["cycles"][1]["payments"]}
        self.assertEqual(second, {"a": 25, "b": 30})  # the usual minimum is back from the next month

    def test_recorded_payment_leaves_only_the_rest_of_the_cycle(self):
        # demo: $410 was paid on Card A, and its balance was entered as $1,090
        cards = [Card("a", "Card A", 1090, 40, 29, due_day=22, paid=410), Card("b", "Card B", 2500, 60, 24, due_day=28), Card("c", "Card C", 600, 30, 19, due_day=5)]
        plan = build_plan(cards, 500, start=START)
        self.assertEqual((plan["status"], plan["paid_this_cycle"], plan["left_this_cycle"]), ("ok", 410, 90))
        self.assertEqual({p["card_id"]: p["total"] for p in plan["this_cycle"]}, {"b": 60, "c": 30})  # no second $410 on Card A
        self.assertEqual(round(sum(p["total"] for p in plan["cycles"][1]["payments"]), 2), 500)  # next cycle is the full budget
        self.assertEqual(plan["cycles"][0]["payments"][0]["start_balance"], 2500)
        # the balance is used as entered: the $410 is not subtracted a second time
        self.assertEqual(plan["cards"][0]["balance"], 1090)

    def test_partial_payment_leaves_the_rest_of_the_minimum(self):
        cards = [Card("a", "Card A", 1480, 40, 29, paid=20), Card("b", "Card B", 2500, 60, 24)]
        plan = build_plan(cards, 500, start=START)
        first = {p["card_id"]: p for p in plan["this_cycle"]}
        self.assertEqual(first["a"]["minimum"], 20)  # $20 of the $40 minimum is still due
        self.assertEqual(round(sum(p["total"] for p in plan["this_cycle"]), 2), 480)  # $500 less the $20 already paid
        # more was paid than the whole budget: nothing is left to place, and nothing goes negative
        over = build_plan([Card("a", "Card A", 900, 40, 29, paid=600), Card("b", "Card B", 2500, 60, 24, min_paid=True)], 500, start=START)
        self.assertEqual((over["status"], over["left_this_cycle"], over["this_cycle"]), ("ok", 0, []))

    def test_entered_balance_is_a_snapshot_not_reduced_again(self):
        # the balance already reflects a $100 payment or a posted credit: it is used as entered
        plan = build_plan([rev(balance=900)], 100, start=START)
        self.assertEqual((plan["total_debt"], plan["cycles"][0]["payments"][0]["start_balance"]), (900, 900))

    def test_money_left_this_month_limits_only_the_first_cycle(self):
        plan = build_plan([rev(minimum=25)], 300, start=START, budget_overrides={1: 120})
        self.assertEqual([round(sum(p["total"] for p in row["payments"]), 2) for row in plan["cycles"][:2]], [120, 300])
        short = build_plan([rev(minimum=25)], 300, start=START, budget_overrides={1: 10})
        self.assertEqual((short["status"], short["shortfall"], short["forecast"]), ("shortfall", 15, None))

    def test_paid_off_card_gets_no_payment_and_keeps_its_limit(self):
        cards = [Card("a", "Card A", 0, 0, 29, limit=3000), rev("b", 1000, 25, 24, limit=2000)]
        plan = build_plan(cards, 200, start=START)
        self.assertEqual(plan["status"], "ok")
        self.assertEqual([p["card_id"] for p in plan["this_cycle"]], ["b"])
        self.assertEqual((plan["card_status"][0]["kind"], plan["limit_use"]["total_limit"], plan["limit_use"]["now_pct"]), ("paid_off", 5000, 20.0))

    def test_unsupported_card_blocks_a_complete_portfolio_forecast(self):
        cards = [rev("a", 1500, 40, 29), Card("b", "Card B", 900, 25, 0, treatment="promo", promo_kind="intro_zero", promo_end="2027-06-01")]
        plan = build_plan(cards, 500, start=START)
        self.assertEqual((plan["status"], plan["blocked_by"]), ("limited", ["Card B"]))
        self.assertNoForecast(plan)
        self.assertEqual(len(plan["cards"]), 2)  # entered information is preserved
        known = {x["name"]: (x["kind"], x["amount"]) for x in plan["card_status"]}
        self.assertEqual(known["Card A"], ("revolving", 40))  # its known obligation is still shown
        # a pay-in-full card next to a revolving one also withholds the combined forecast
        mix = build_plan([rev("a"), Card("b", "Card B", 300, 25, 29, treatment="pay_in_full", grace="yes", statement_due=300)], 500, start=START)
        self.assertEqual((mix["status"], mix["blocked_by"]), ("limited", []))
        self.assertNoForecast(mix)

    def test_past_due_is_flagged_not_moved_forward(self):
        flagged = build_plan([rev(past_due=True)], 500, start=START)
        self.assertEqual(flagged["card_status"][0]["code"], "past_due")
        passed = build_plan([rev(next_due="2026-11-05")], 500, start=START)
        self.assertEqual((passed["status"], passed["card_status"][0]["code"]), ("limited", "due_passed"))
        self.assertNoForecast(passed)
        ok = build_plan([rev(next_due="2026-11-22", due_day=22)], 500, start=START)
        self.assertEqual((ok["status"], ok["this_cycle"][0]["due"]), ("ok", "2026-11-22"))

    def test_changed_budget_is_one_simulation_for_every_screen(self):
        cards = [rev("a", 1500, 40, 29, limit=3000, due_day=22), rev("b", 2500, 60, 24, limit=5000, due_day=28)]
        plan = build_plan(cards, 600, start=START)
        f = plan["forecast"]
        self.assertEqual(plan["this_cycle"], plan["cycles"][0]["payments"])
        self.assertEqual(f["balance_by_cycle"][1], plan["cycles"][0]["total_balance"])
        self.assertEqual([(d["card_id"], d["total"]) for d in f["due_dates"][:2]], [(p["card_id"], p["total"]) for p in plan["this_cycle"]])
        mine = next(c for c in plan["comparison"] if c["strategy"] == "avalanche")
        self.assertEqual((mine["months"], mine["total_interest"]), (f["months"], f["total_interest"]))
        third = {p["card_id"]: p["end_balance"] for p in plan["cycles"][2]["payments"]}
        self.assertEqual(plan["limit_use"]["cards"][0]["after_balance"], third["a"])

    def test_boundaries_and_non_converging_debt(self):
        # a minimum below the monthly interest never clears the balance: no payoff date is given
        stuck = simulate([rev(balance=10000, minimum=50, apr=29)], 50, "minimum", START)
        self.assertEqual((stuck.status, stuck.debt_free_month), ("not_converging", None))
        # month-end start: the due date stays inside the first cycle
        plan = build_plan([rev(due_day=31)], 200, start=date(2027, 1, 31))
        self.assertTrue(plan["cycle"]["period_start"] <= plan["this_cycle"][0]["due"] <= plan["cycle"]["period_end"])
        # cents: every row reconciles to the cent
        for row in build_plan([rev(balance=333.33, minimum=11.11, apr=19.99)], 77.77, start=START)["cycles"]:
            for p in row["payments"]:
                self.assertAlmostEqual(p["start_balance"] + p["interest"] - p["total"], p["end_balance"], delta=0.011)
        # repeated updates: the same inputs always give the same plan
        self.assertEqual(build_plan([rev()], 100, start=START), build_plan([rev()], 100, start=START))


if __name__ == "__main__":
    unittest.main()
