import unittest
from types import SimpleNamespace

from finpilot_ai.call_script import CallFacts, call_script, is_grounded, parse, template_script

FACTS = CallFacts("Card A", 1500, 29, 40, 410)
GOOD = """open: Hello, I'd like to talk about the interest rate on my card.
ask: My APR is 29%, and I'd like to ask whether you can lower it.
case: I pay $410 a month, well over the $40 minimum, and plan to clear the $1,500 balance.
pushback: Is anything available, even for a few months?
close: Could you confirm the rate, when it starts, how long it lasts, and give me a reference number?"""


def fake_client(text, stop_reason="end_turn"):
    response = SimpleNamespace(stop_reason=stop_reason, content=[SimpleNamespace(type="text", text=text)])
    return SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=lambda **kwargs: response)))


class CallScriptTest(unittest.TestCase):
    def test_template_uses_plan_figures_only(self):
        lines = template_script(FACTS)
        self.assertEqual([line["step"] for line in lines], ["open", "ask", "case", "pushback", "close"])
        self.assertTrue(is_grounded(lines, FACTS))
        self.assertIn("$410", lines[2]["say"])

    def test_ai_wording_is_accepted_when_grounded(self):
        out = call_script(FACTS, client=fake_client(GOOD))
        self.assertEqual(out["source"], "ai")
        self.assertEqual(len(out["lines"]), 5)

    def test_invented_number_falls_back_to_template(self):
        bad = GOOD.replace("My APR is 29%", "My APR is 29% and competitors offer 18%")
        out = call_script(FACTS, client=fake_client(bad))
        self.assertEqual(out["source"], "template")

    def test_wrong_shape_or_refusal_falls_back(self):
        self.assertIsNone(parse("Sure! Here is your script..."))
        self.assertEqual(call_script(FACTS, client=fake_client("nonsense"))["source"], "template")
        self.assertEqual(call_script(FACTS, client=fake_client(GOOD, "refusal"))["source"], "template")

    def test_no_credentials_falls_back_instead_of_crashing(self):
        import os
        from unittest import mock

        import anthropic

        with mock.patch.dict(os.environ, {}, clear=True):
            out = call_script(FACTS, client=anthropic.Anthropic(api_key=None))
        self.assertEqual(out["source"], "template")

    def test_ai_can_be_turned_off(self):
        self.assertEqual(call_script(FACTS, use_ai=False)["source"], "template")


if __name__ == "__main__":
    unittest.main()
