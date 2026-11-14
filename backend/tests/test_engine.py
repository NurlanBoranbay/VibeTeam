"""Checks from the product brief's "what to verify before the demo" list."""
import unittest
from datetime import date

from app.engine import Card, allocate, build_plan, shortfall, simulate

START = date(2026, 11, 14)


def demo():
    return [
        Card("a", "Card A", 1500, 40, 29),
        Card("b", "Card B", 2500, 60, 24),
        Card("c", "Card C", 600, 30, 19),
    ]


class EngineTest(unittest.TestCase):
    def test_demo_split_is_410_60_30(self):
        pays = {p.card_id: p.total for p in allocate(demo(), 500)}
        self.assertEqual(pays, {"a": 410, "b": 60, "c": 30})
        self.assertEqual(sum(pays.values()), 500)

    def test_demo_forecast(self):
        f = simulate(demo(), 500, "avalanche", START)
        self.assertEqual(f.status, "ok")
        self.assertEqual(f.months, 11)
        self.assertEqual(f.debt_free_month, "2027-09")
        self.assertAlmostEqual(f.total_interest, 529.56, places=2)

    def test_every_month_stays_inside_budget_and_covers_minimums(self):
        f = simulate(demo(), 500, "avalanche", START)
        for row in f.schedule:
            self.assertLessEqual(round(sum(p.total for p in row.payments), 2), 500)
        first = {p.card_id: p.minimum for p in f.schedule[0].payments}
        self.assertEqual(first, {"a": 40, "b": 60, "c": 30})

    def test_freed_money_rolls_to_next_card(self):
        f = simulate(demo(), 500, "avalanche", START)
        self.assertEqual(f.payoff_month["a"], "2027-02")
        march = {p.card_id: p.total for p in f.schedule[4].payments}
        self.assertEqual(march, {"b": 470, "c": 30})

    def test_budget_change_recalculates(self):
        self.assertEqual(simulate(demo(), 600, start=START).months, 9)
        self.assertEqual(simulate(demo(), 400, start=START).months, 14)

    def test_one_time_payment_and_low_month(self):
        self.assertEqual(simulate(demo(), 500, start=START, one_time=1000).months, 8)
        low = simulate(demo(), 500, start=START, budget_overrides={2: 300})
        self.assertEqual(low.months, 11)
        self.assertGreater(low.total_interest, 529.56)

    def test_snowball_clears_smallest_first_and_costs_more(self):
        f = simulate(demo(), 500, "snowball", START)
        self.assertEqual(f.payoff_month["c"], "2026-12")
        self.assertAlmostEqual(f.total_interest, 559.28, places=2)

    def test_shortfall_gives_no_date(self):
        cards = [Card("a", "A", 3000, 150, 29), Card("b", "B", 2500, 120, 24), Card("c", "C", 1500, 80, 19)]
        self.assertEqual(shortfall(cards, 250), 100)
        f = simulate(cards, 250, start=START)
        self.assertEqual(f.status, "shortfall")
        self.assertIsNone(f.debt_free_month)
        self.assertEqual(allocate(cards, 250), [])
        plan = build_plan(cards, 250, start=START)
        self.assertIsNone(plan["forecast"])
        self.assertEqual(plan["shortfall"], 100)

    def test_unknown_apr_splits_but_gives_no_forecast(self):
        cards = demo()
        cards[1].apr = None
        self.assertEqual(simulate(cards, 500, start=START).status, "apr_unknown")
        plan = build_plan(cards, 500, start=START)
        self.assertIsNone(plan["forecast"])
        self.assertEqual(len(plan["missing"]), 1)
        # avalanche cannot rank cards with an APR missing: minimums only, the rest is left unallocated
        self.assertEqual([(p["minimum"], p["extra"]) for p in plan["this_cycle"]], [(40, 0), (60, 0), (30, 0)])
        self.assertEqual(plan["unallocated"], 370)
        self.assertEqual(plan["missing_apr"], ["Card B"])
        self.assertIsNone(plan["forecast"])
        # the unknown APR is not treated as 0%: no interest figure exists for that card
        self.assertIsNone(plan["this_cycle"][1]["interest"])
        # snowball needs no APR to choose a card, so it still places the whole budget
        snow = build_plan(cards, 500, "snowball", start=START)
        self.assertEqual(sum(p["total"] for p in snow["this_cycle"]), 500)
        self.assertEqual(snow["unallocated"], 0)
        # entering the APR restores the normal split and forecast
        cards[1].apr = 24
        fixed = build_plan(cards, 500, start=START)
        self.assertEqual([p["total"] for p in fixed["this_cycle"]], [410, 60, 30])
        self.assertEqual(fixed["forecast"]["months"], 11)
        self.assertEqual((fixed["unallocated"], fixed["missing_apr"]), (0.0, []))

    def test_zero_balance_and_zero_apr(self):
        cards = [Card("a", "A", 0, 40, 29), Card("b", "B", 600, 50, 0)]
        f = simulate(cards, 200, start=START)
        self.assertEqual(f.status, "ok")
        self.assertEqual(f.months, 3)
        self.assertEqual(f.total_interest, 0)
        self.assertNotIn("a", f.payoff_month)
        self.assertEqual(simulate([Card("a", "A", 0, 40, 29)], 100, start=START).status, "no_debt")

    def test_payment_never_exceeds_payoff_amount(self):
        f = simulate([Card("a", "A", 100, 25, 12)], 500, start=START)
        self.assertEqual(f.months, 1)
        self.assertEqual(f.schedule[0].payments[0].total, 101)

    def test_minimum_only_is_reported_separately(self):
        plan = build_plan(demo(), 500, start=START)
        by = {c["strategy"]: c for c in plan["comparison"]}
        self.assertEqual(by["minimum"]["months"], 100)
        self.assertEqual(len(plan["cycles"]), 3)
        self.assertEqual(plan["cycles"][2]["total_balance"], 3358.35)

    def test_cycles_are_rolling_months_with_real_due_dates(self):
        cards = demo()
        for c, day in zip(cards, (22, 28, 5)):
            c.due_day = day
        plan = build_plan(cards, 500, start=START)
        first = plan["cycles"][0]
        self.assertEqual((first["period_start"], first["period_end"]), ("2026-11-14", "2026-12-13"))
        self.assertEqual([p["due"] for p in first["payments"]], ["2026-11-22", "2026-11-28", "2026-12-05"])
        for row in plan["cycles"]:  # every payment falls inside its own cycle, once
            for p in row["payments"]:
                self.assertTrue(row["period_start"] <= p["due"] <= row["period_end"])
            self.assertEqual(len({p["card_id"] for p in row["payments"]}), len(row["payments"]))
        self.assertEqual(plan["cycles"][2]["period_end"], "2027-02-13")
        # Card C is cleared last, and its final payment is due Oct 5, so that is the debt-free month
        self.assertEqual(plan["forecast"]["months"], 11)
        self.assertEqual(plan["forecast"]["payoff_month"], {"a": "2027-02", "b": "2027-08", "c": "2027-10"})
        self.assertEqual(plan["forecast"]["debt_free_month"], "2027-10")
        self.assertAlmostEqual(plan["forecast"]["total_interest"], 529.56, places=2)

    def test_combined_limit_use_needs_every_limit(self):
        cards = demo()
        cards[0].limit, cards[1].limit = 3000, 5000
        use = build_plan(cards, 500, start=START)["limit_use"]
        self.assertFalse(use["complete"])
        self.assertIsNone(use["now_pct"])
        self.assertEqual([c["after_pct"] for c in use["cards"]], [11.7, 49.4])
        cards[2].limit = 2000
        use = build_plan(cards, 500, start=START)["limit_use"]
        self.assertTrue(use["complete"])
        self.assertEqual(use["now_pct"], 46.0)  # 4,600 / 10,000, not the average of 50, 50 and 30
        self.assertEqual(use["after_date"], "2027-02-13")
        self.assertEqual(build_plan(cards, 600, start=START)["limit_use"]["cards"][0]["after_pct"], 1.5)
        for c in cards:
            c.limit = None
        plan = build_plan(cards, 500, start=START)
        self.assertEqual(plan["forecast"]["months"], 11)
        self.assertEqual(plan["limit_use"]["cards"], [])

    def test_plan_and_schedule_give_the_same_first_payment(self):
        # review case: $10 owed, $40 statement minimum, 29% APR, $500 budget
        plan = build_plan([Card("a", "Card A", 10, 40, 29, due_day=22)], 500, start=START)
        self.assertEqual(plan["this_cycle"], plan["cycles"][0]["payments"])
        pay = plan["this_cycle"][0]
        self.assertEqual((pay["total"], pay["due"], pay["payoff"]), (10.24, "2026-11-22", True))
        self.assertEqual(pay["statement_minimum"], 40)  # the entered minimum is reported unchanged
        self.assertEqual(plan["forecast"]["total_interest"], 0.24)
        self.assertEqual(plan["limit_use"]["after_date"], "2027-02-13")  # end of cycle 3, not cycle 1

    def test_every_scheduled_payment_reconciles(self):
        cards = demo() + []
        cards[2] = Card("c", "Card C", 25, 30, 19)  # below its minimum: paid off in the first cycle
        for budget in (500, 135):
            plan = build_plan(cards, budget, start=START)
            self.assertEqual(plan["this_cycle"], plan["cycles"][0]["payments"])
            for row in plan["cycles"]:
                for p in row["payments"]:
                    self.assertAlmostEqual(p["start_balance"] + p["interest"] - p["total"], p["end_balance"], delta=0.011)
                    self.assertLessEqual(p["minimum"], p["statement_minimum"] + 0.001)
                self.assertLessEqual(round(sum(p["total"] for p in row["payments"]), 2), budget)
        first = {p["card_id"]: p for p in build_plan(cards, 500, start=START)["this_cycle"]}
        self.assertEqual((first["c"]["total"], first["c"]["payoff"]), (25.4, True))  # 25 + 0.40 interest

    def test_paid_off_card_stays_in_the_plan(self):
        cards = demo()
        cards[0].limit, cards[1].limit, cards[2].limit = 3000, 5000, 2000
        cards[0].balance, cards[0].minimum = 0, 0
        plan = build_plan(cards, 500, start=START)
        self.assertEqual(plan["status"], "ok")
        self.assertNotIn("a", [p["card_id"] for p in plan["this_cycle"]])
        use = plan["limit_use"]
        self.assertTrue(use["complete"])
        self.assertEqual(use["cards"][0]["now_pct"], 0.0)
        self.assertEqual(use["now_pct"], 31.0)  # 3,100 / 10,000: the paid-off card's limit still counts
        for c in cards:
            c.balance, c.minimum = 0, 0
        done = build_plan(cards, 500, start=START)
        self.assertEqual((done["status"], done["this_cycle"], done["forecast"]), ("no_debt", [], None))

    def test_comparison_states_its_payment_basis(self):
        by = {c["strategy"]: c["payment_basis"] for c in build_plan(demo(), 500, start=START)["comparison"]}
        self.assertEqual(by, {"avalanche": 500, "snowball": 500, "minimum": 130})


if __name__ == "__main__":
    unittest.main()
