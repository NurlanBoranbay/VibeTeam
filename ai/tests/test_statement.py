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
        card = out["card"]
        self.assertEqual({k: card[k] for k in ("name", "balance", "minimum", "apr", "due_day", "limit")}, {"name": "Card", "balance": 1500.0, "minimum": 40.0, "apr": 29.0, "due_day": 22, "limit": 3000.0})
        # both printed rates are kept under their own labels; only the one labelled Purchases is the purchase APR
        self.assertEqual(card["rates"], [{"label": "Purchases", "apr": 29.0}, {"label": "Cash advances", "apr": 31.99}])
        self.assertEqual((card["interest_charged"], card["balance_label"], card["promo_wording"]), (36.04, "New Balance", False))
        self.assertTrue(any("Only the purchase rate was used" in n for n in out["notes"]))

    def test_ai_answer_is_used_when_grounded(self):
        ai = '{"name": "Summit Rewards Visa", "balance": 1500.00, "apr": 29.0, "minimum": 40.0, "due_day": 22, "limit": 3000}'
        out = read_statement(TEXT, client=fake_client(ai))
        self.assertEqual(out["source"], "ai")
        self.assertEqual(out["card"]["name"], "Summit Rewards Visa")
        self.assertEqual(out["card"]["apr"], 29.0)

    def test_invented_figures_are_dropped(self):
        ai = '{"name": "Visa 4821 0000 1111 2222", "balance": 1500.00, "apr": 24.99, "minimum": 40.0, "due_day": 22, "limit": 9000}'
        out = read_statement(TEXT, client=fake_client(ai))
        self.assertEqual(out["card"]["apr"], 29.0)  # the invented 24.99 is gone; the rate printed next to Purchases is used
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

    def test_word_document_is_read_like_text(self):
        import io
        import zipfile

        from finpilot_ai.statement import docx_text

        body = "".join(f"<w:p><w:r><w:t>{line}</w:t></w:r></w:p>" for line in (
            "SUMMIT REWARDS VISA", "New Balance $1,500.00", "Credit Limit $3,000.00",
            "Minimum Payment Due $40.00", "Payment Due Date December 22, 2026", "Purchases 29.00% (v)"))
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("word/document.xml", f"<w:document><w:body>{body}</w:body></w:document>")
        card = read_statement(docx_text(buf.getvalue()), use_ai=False)["card"]
        self.assertEqual((card["balance"], card["minimum"], card["apr"], card["due_day"], card["limit"]), (1500, 40, 29, 22, 3000))
        with self.assertRaises(StatementProblem):
            docx_text(b"not a zip")

    def test_photo_is_transcribed_then_read_like_text(self):
        from finpilot_ai.statement import photo_text

        text = photo_text(b"\xff\xd8fake", "image/jpeg", client=fake_client(TEXT))
        card = read_statement(text, use_ai=False)["card"]
        self.assertEqual(card["balance"], read_by_patterns(TEXT)["balance"])
        for answer, stop in (("UNREADABLE", "end_turn"), (TEXT, "refusal")):
            with self.assertRaises(StatementProblem):
                photo_text(b"x", "image/png", client=fake_client(answer, stop))
        with self.assertRaises(StatementProblem):
            photo_text(b"x", "image/gif", client=fake_client(TEXT))
        with self.assertRaises(StatementProblem):
            photo_text(b"x" * 4_000_000, "image/png", client=fake_client(TEXT))

    def test_several_rates_are_kept_apart_and_none_is_chosen(self):
        text = TEXT + "\nCash Advances 31.99% (v) $0.00\nPromotional Balance Transfer 0.00% until 03/01/2027"
        out = read_statement(text, use_ai=False)
        card = out["card"]
        self.assertIsNone(card["apr"])
        self.assertEqual({r["apr"] for r in card["rates"]}, {29.0, 31.99, 0.0})
        self.assertTrue(any("None was chosen" in n for n in out["notes"]))
        self.assertTrue(card["promo_wording"])
        # the AI cannot override this: its single APR is dropped when the text shows several
        ai = '{"name": "Summit", "balance": 1500, "apr": 29, "minimum": 40, "due_day": 22, "limit": 3000}'
        self.assertIsNone(read_statement(text, client=fake_client(ai))["card"]["apr"])

    def test_zero_interest_and_deferred_wording_are_not_turned_into_a_grace_period_or_zero_percent(self):
        text = "STORE CARD\nNew Balance $800.00\nMinimum Payment Due $27.00\nPayment Due Date December 22, 2026\nInterest Charged $0.00\nNo interest if paid in full by 06/30/2027\nPurchases 29.99% (v)"
        out = read_statement(text, use_ai=False)
        card = out["card"]
        self.assertEqual((card["interest_charged"], card["promo_wording"], card["apr"], card["balance_label"]), (0.0, True, 29.99, "New Balance"))
        self.assertNotIn("treatment", card)  # classification is the person's answer, never the import's
        self.assertTrue(any("does not prove a grace period" in n for n in out["notes"]))
        self.assertTrue(any("promotional or deferred-interest" in n for n in out["notes"]))


if __name__ == "__main__":
    unittest.main()
