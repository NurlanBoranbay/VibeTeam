import json
import unittest
from datetime import date

from finpilot_ai import assistant

TODAY = date(2026, 11, 14)
INPUTS = {
    "goal": "less_interest", "budget": 500, "strategy": "avalanche",
    "cards": [
        {"id": "card-a", "name": "Card A", "balance": 1500, "minimum": 40, "apr": 29, "due_day": 22, "limit": 3000, "treatment": "revolving"},
        {"id": "card-b", "name": "Card B", "balance": 2500, "minimum": 60, "apr": 24, "due_day": 28, "limit": 5000, "treatment": "revolving"},
    ],
}


def calc(inputs):
    """A stand-in for the plan API: enough for the assistant to summarise."""
    paid = sum(c.get("paid", 0) for c in inputs["cards"])
    return {"status": "ok", "budget": inputs["budget"], "strategy": inputs["strategy"], "total_debt": sum(c["balance"] for c in inputs["cards"]),
            "minimums_total": 100, "shortfall": 0, "paid_this_cycle": paid, "this_cycle": [], "cards": inputs["cards"], "blocked_by": [],
            "forecast": {"debt_free_month": "2027-10", "months": 11, "total_interest": 529.56}}


def scripted(*steps):
    """A model that answers with the given steps in order: a list of (tool, args) calls, or a final string."""
    seen = []

    def chat(messages, tools=None, **kwargs):
        seen.append(messages)
        step = steps[len(seen) - 1]
        if isinstance(step, str):
            return {"content": step, "tool_calls": [], "model": "test"}
        return {"content": "", "model": "test", "tool_calls": [{"id": f"c{i}", "type": "function", "function": {"name": n, "arguments": json.dumps(a)}} for i, (n, a) in enumerate(step)]}

    chat.seen = seen
    return chat


def run(chat, text="hi", inputs=INPUTS):
    return assistant.run([{"role": "user", "content": text}], inputs, calc=calc, scenario=lambda i, p: {"baseline": calc(i), "scenario": calc({**i, "budget": p.get("scenario_budget", i["budget"])})}, chat=chat, today=TODAY)


class AssistantTest(unittest.TestCase):
    def test_changes_the_budget_and_reports_it(self):
        out = run(scripted([("set_budget", {"amount": 550})], "Your budget is now $550."))
        self.assertEqual(out["inputs"]["budget"], 550)
        self.assertEqual(out["actions"], [{"summary": "Monthly budget $500 → $550"}])
        self.assertEqual(out["reply"], "Your budget is now $550.")
        self.assertEqual(INPUTS["budget"], 500)  # the inputs passed in are never changed in place

    def test_reading_changes_nothing(self):
        out = run(scripted([("get_plan", {})], "You pay..."))
        self.assertIsNone(out["inputs"])
        self.assertEqual(out["actions"], [])

    def test_mark_paid_lowers_the_balance_and_is_counted_for_this_month(self):
        chat = scripted([("mark_paid", {"card": "card a", "amount": 410})], "Marked.")
        out = run(chat)
        card = out["inputs"]["cards"][0]
        self.assertEqual(card["balance"], 1090)
        self.assertEqual([(p["card_id"], p["amount"], p["date"]) for p in out["inputs"]["payments"]], [("card-a", 410, "2026-11-14")])
        result = json.loads(chat.seen[1][-1]["content"])
        self.assertEqual(result["already_paid_this_month"], 410)  # the plan the model saw already reflects the payment

    def test_bad_requests_are_refused_and_explained_to_the_model(self):
        chat = scripted([("update_card", {"card": "Card A", "apr": -5}), ("mark_paid", {"card": "Card Z", "amount": 10}), ("mark_paid", {"card": "Card A", "amount": 9000})], "I could not do that.")
        out = run(chat)
        self.assertIsNone(out["inputs"])
        errors = [json.loads(m["content"])["error"] for m in chat.seen[1] if m["role"] == "tool"]
        self.assertEqual(len(errors), 3)
        self.assertIn("between 0 and 100", errors[0])
        self.assertIn("No card called", errors[1])

    def test_card_tools(self):
        out = run(scripted([("update_card", {"card": "Card A", "name": "Chase", "balance": 1400}), ("add_card", {"name": "Store", "balance": 300, "minimum": 25, "apr": 27}), ("remove_card", {"card": "Card B"})], "Done."))
        self.assertEqual([c["name"] for c in out["inputs"]["cards"]], ["Chase", "Store"])
        self.assertEqual(out["inputs"]["cards"][0]["balance"], 1400)
        self.assertEqual(out["inputs"]["cards"][1]["treatment"], "revolving")
        self.assertEqual(len(out["actions"]), 3)

    def test_preview_and_navigation_change_nothing(self):
        out = run(scripted([("preview_budget", {"amount": 700}), ("open_page", {"page": "compare"})], "Here it is."))
        self.assertIsNone(out["inputs"])
        self.assertEqual(out["navigate"], "forecast")

    def test_expert_is_asked_once_on_the_hard_tier(self):
        tiers = []

        def chat(messages, tools=None, tier="fast", **kwargs):
            tiers.append(tier)
            if tier == "hard":
                return {"content": "Pay the 29% card first.", "tool_calls": [], "model": "deepseek-chat"}
            if len(tiers) == 1:
                return {"content": "", "model": "test", "tool_calls": [{"id": "1", "function": {"name": "ask_expert", "arguments": json.dumps({"question": "q"})}}, {"id": "2", "function": {"name": "ask_expert", "arguments": json.dumps({"question": "again"})}}]}
            return {"content": "The expert says so.", "tool_calls": [], "model": "test"}

        run(chat)
        self.assertEqual(tiers.count("hard"), 1)

    def test_stops_after_too_many_rounds(self):
        out = run(scripted(*[[("get_plan", {})]] * assistant.MAX_ROUNDS))
        self.assertIn("stopped", out["reply"])

    def test_wire_matches_the_web_app_rule_for_recorded_payments(self):
        inputs = {**INPUTS, "payments": [{"card_id": "card-a", "amount": 100, "date": "2026-11-10"}, {"card_id": "card-a", "amount": 50, "date": "2026-10-01"}]}
        cards = assistant.wire(inputs, TODAY)["cards"]
        self.assertEqual(cards[0]["paid"], 100)  # only the payment made in the month before the Nov 22 due date
        self.assertEqual(cards[1]["paid"], 0)
        self.assertNotIn("payments", assistant.wire(inputs, TODAY))


if __name__ == "__main__":
    unittest.main()
