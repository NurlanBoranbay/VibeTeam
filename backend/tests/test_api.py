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
        {"name": "Card A", "balance": 1500, "minimum": 40, "apr": 29, "limit": 3000},
        {"name": "Card B", "balance": 2500, "minimum": 60, "apr": 24},
        {"name": "Card C", "balance": 600, "minimum": 30, "apr": 19},
    ],
}


class ApiTest(unittest.TestCase):
    def test_calculate(self):
        r = client.post("/api/plan/calculate", json=DEMO)
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual([p["total"] for p in body["this_month"]], [410, 60, 30])
        self.assertEqual(body["forecast"]["debt_free_month"], "2027-09")

    def test_shortfall_has_no_forecast(self):
        r = client.post("/api/plan/calculate", json={**DEMO, "budget": 100})
        self.assertEqual(r.json()["status"], "shortfall")
        self.assertEqual(r.json()["shortfall"], 30)
        self.assertIsNone(r.json()["forecast"])

    def test_scenario(self):
        r = client.post("/api/plan/scenario", json={**DEMO, "one_time": 1000})
        self.assertEqual(r.json()["baseline"]["months"], 11)
        self.assertEqual(r.json()["scenario"]["months"], 8)

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
