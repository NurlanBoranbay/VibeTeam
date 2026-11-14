import os
import tempfile
import unittest

os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(tempfile.mkdtemp(), "test.db").replace("\\", "/")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

client = TestClient(app)
DEMO = {
    "budget": 500,
    "start": "2026-11-14",
    "cards": [
        {"name": "Card A", "treatment": "revolving", "balance": 1500, "minimum": 40, "apr": 29, "limit": 3000},
        {"name": "Card B", "treatment": "revolving", "balance": 2500, "minimum": 60, "apr": 24},
        {"name": "Card C", "treatment": "revolving", "balance": 600, "minimum": 30, "apr": 19},
    ],
}


class ApiTest(unittest.TestCase):
    def test_calculate(self):
        r = client.post("/api/plan/calculate", json=DEMO)
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual([p["total"] for p in body["this_cycle"]], [410, 60, 30])
        self.assertEqual(body["forecast"]["debt_free_month"], "2027-09")

    def test_shortfall_has_no_forecast(self):
        r = client.post("/api/plan/calculate", json={**DEMO, "budget": 100})
        self.assertEqual(r.json()["status"], "shortfall")
        self.assertEqual(r.json()["shortfall"], 30)
        self.assertIsNone(r.json()["forecast"])

    def test_scenario(self):
        r = client.post("/api/plan/scenario", json={**DEMO, "one_time": 1000}).json()
        self.assertEqual(r["baseline"]["forecast"]["months"], 11)
        self.assertEqual(r["scenario"]["forecast"]["months"], 8)
        self.assertEqual(r["scenario"]["this_cycle"][0]["total"], 1410)

    def test_scenario_purchase_costs_interest(self):
        cards = [{**c, "id": f"c{i}"} for i, c in enumerate(DEMO["cards"])]
        r = client.post("/api/plan/scenario", json={**DEMO, "cards": cards, "balance_add": {"c0": 400}}).json()
        base, alt = r["baseline"], r["scenario"]
        self.assertEqual(alt["total_debt"], base["total_debt"] + 400)
        self.assertGreater(alt["forecast"]["total_interest"], base["forecast"]["total_interest"])
        self.assertGreaterEqual(alt["forecast"]["months"], base["forecast"]["months"])

    def test_scenario_budget_and_bank_apr(self):
        r = client.post("/api/plan/scenario", json={**DEMO, "scenario_budget": 600}).json()
        self.assertEqual(r["scenario"]["forecast"]["debt_free_month"], "2027-07")
        r = client.post("/api/plan/scenario", json={**DEMO, "apr_overrides": {"card-1": 21.9}}).json()
        self.assertEqual([p["total"] for p in r["scenario"]["this_cycle"]], [40, 430, 30])
        self.assertAlmostEqual(r["scenario"]["forecast"]["total_interest"], 487.14, places=2)
        r = client.post("/api/plan/scenario", json={**DEMO, "scenario_budget": 100}).json()
        self.assertEqual(r["scenario"]["status"], "shortfall")
        self.assertIsNone(r["scenario"]["forecast"])

    def test_limit_use_skips_cards_without_a_limit(self):
        use = client.post("/api/plan/calculate", json=DEMO).json()["limit_use"]
        self.assertEqual([c["card_id"] for c in use["cards"]], ["card-1"])
        self.assertEqual(use["cards"][0]["now_pct"], 50.0)
        self.assertEqual(use["cards"][0]["after_pct"], 11.7)
        self.assertEqual(use["missing"], ["Card B", "Card C"])
        self.assertIsNone(use["now_pct"])  # no combined figure while a limit is missing

    def test_calendar(self):
        body = {**DEMO, "cards": [{**c, "due_day": d} for c, d in zip(DEMO["cards"], (22, 31, 5))]}
        r = client.post("/api/plan/calendar", json=body)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.text.count("BEGIN:VEVENT"), 9)
        self.assertIn("DTSTART;VALUE=DATE:20261122", r.text)
        self.assertIn("DTSTART;VALUE=DATE:20261130", r.text)  # day 31 clamped to November
        self.assertIn("DTSTART;VALUE=DATE:20261205", r.text)  # day 5 already passed on Nov 14
        self.assertNotIn("DTSTART;VALUE=DATE:20261105", r.text)
        self.assertEqual(client.post("/api/plan/calendar", json={**DEMO, "budget": 100}).status_code, 409)

    def test_more_than_three_cards_is_rejected(self):
        r = client.post("/api/plan/calculate", json={**DEMO, "cards": DEMO["cards"] * 2})
        self.assertEqual(r.status_code, 422)

    def test_save_load_delete(self):
        saved = client.post("/api/plans", json=DEMO).json()
        url, headers = f"/api/plans/{saved['id']}", {"X-Plan-Token": saved["edit_token"]}
        self.assertEqual(client.get(url).status_code, 404)
        self.assertEqual(client.get(url, headers={"X-Plan-Token": "wrong"}).status_code, 404)
        got = client.get(url, headers=headers).json()
        self.assertEqual(got["plan"]["cards"][0]["apr"], 29)
        self.assertIsNone(got["edit_token"])
        self.assertEqual(client.delete(url, headers=headers).status_code, 204)
        self.assertEqual(client.get(url, headers=headers).status_code, 404)


if __name__ == "__main__":
    unittest.main()
