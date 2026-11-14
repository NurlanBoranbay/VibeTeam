import unittest
from types import SimpleNamespace

from finpilot_ai.statement import StatementProblem, keep_grounded, read_by_patterns, read_statement

TEXT = """SUMMIT REWARDS VISA  Account ending in 4821
Account Summary
Previous Balance $1,380.22   Payments -$200.00   Purchases +$283.74   Interest Charged +$36.04
New Balance $1,500.00
Credit Limit $3,000.00   Available Credit $1,500.00
Payment Information
Minimum Payment Due $40.00
Payment Due Date December 22, 2026
Interest Charge Calculation
Type of Balance   Annual Percentage Rate (APR)   Balance Subject to Interest Rate
Purchases   29.00% (v)   $1,490.12
Cash Advances   31.99% (v)   $0.00
"""


def fake_client(text, stop_reason="end_turn"):
    response = SimpleNamespace(stop_reason=stop_reason, content=[SimpleNamespace(type="text", text=text)])
    return SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=lambda **kwargs: response)))


class StatementTest(unittest.TestCase):
    def test_patterns(self):
        found = read_by_patterns(TEXT)
        self.assertEqual((found["balance"], found["minimum"], found["limit"], found["apr"], found["due_day"]), (1500.0, 40.0, 3000.0, 29.0, 22))

    def test_without_ai_uses_patterns(self):
        out = read_statement(TEXT, use_ai=False)
        self.assertEqual(out["source"], "patterns")
        self.assertEqual(out["card"], {"name": "Card", "balance": 1500.0, "minimum": 40.0, "apr": 29.0, "due_day": 22, "limit": 3000.0})
        self.assertEqual(out["notes"], [])

    def test_ai_answer_is_used_when_grounded(self):
        ai = '{"name": "Summit Rewards Visa", "balance": 1500.00, "apr": 29.0, "minimum": 40.0, "due_day": 22, "limit": 3000}'
        out = read_statement(TEXT, client=fake_client(ai))
        self.assertEqual(out["source"], "ai")
        self.assertEqual(out["card"]["name"], "Summit Rewards Visa")
        self.assertEqual(out["card"]["apr"], 29.0)

    def test_invented_figures_are_dropped(self):
        ai = '{"name": "Visa 4821 0000 1111 2222", "balance": 1500.00, "apr": 24.99, "minimum": 40.0, "due_day": 22, "limit": 9000}'
        out = read_statement(TEXT, client=fake_client(ai))
        self.assertIsNone(out["card"]["apr"])
        self.assertIsNone(out["card"]["limit"])
        self.assertEqual(out["card"]["name"], "Card")  # anything that looks like a card number is not kept
        self.assertTrue(any("left empty" in n for n in out["notes"]))

    def test_bad_ai_answer_falls_back_to_patterns(self):
        for answer, stop in (("Sure, here you go!", "end_turn"), ('{"balance": 777}', "end_turn"), ("{}", "refusal")):
            out = read_statement(TEXT, client=fake_client(answer, stop))
            self.assertEqual(out["source"], "patterns")
            self.assertEqual(out["card"]["balance"], 1500.0)

    def test_problems_are_readable(self):
        with self.assertRaises(StatementProblem):
            read_statement("too short", use_ai=False)
        with self.assertRaises(StatementProblem):
            read_statement("Thank you for being a valued customer. " * 5, use_ai=False)

    def test_grounding_helper(self):
        found, dropped = keep_grounded({"name": None, "balance": 12.0, "apr": None, "minimum": None, "due_day": 40, "limit": None}, "balance 12.00 due 40")
        self.assertEqual((found["balance"], found["due_day"]), (12.0, None))
        self.assertEqual(dropped, ["due_day"])


if __name__ == "__main__":
    unittest.main()
