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
        self.assertEqual(sum(p["total"] for p in plan["this_cycle"]), 500)
        self.assertEqual(len(plan["missing"]), 1)

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


if __name__ == "__main__":
    unittest.main()
