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

    def test_calendar_leaves_out_what_is_already_paid(self):
        cards = [dict(c) for c in DEMO["cards"]]
        for c, day in zip(cards, (22, 28, 5)):
            c["due_day"] = day
        full = client.post("/api/plan/calendar", json={**DEMO, "cards": cards}).text
        cards[0].update(balance=1090, paid=410)
        paid = client.post("/api/plan/calendar", json={**DEMO, "cards": cards}).text
        self.assertIn("DTSTART;VALUE=DATE:20261122", full)
        self.assertNotIn("DTSTART;VALUE=DATE:20261122", paid)  # Card A is already paid for this due date
        self.assertIn("DTSTART;VALUE=DATE:20261128", paid)
        self.assertIn("DTSTART;VALUE=DATE:20261222", paid)  # and is due again next cycle

    def test_account_keeps_a_plan_and_can_be_deleted(self):
        import uuid

        who = {"email": f"t{uuid.uuid4().hex[:8]}@example.com", "password": "correct horse"}
        self.assertEqual(client.post("/api/auth/register", json={**who, "password": "short"}).status_code, 422)
        self.assertEqual(client.post("/api/auth/register", json={"email": "not-an-email", "password": "long enough"}).status_code, 422)
        token = client.post("/api/auth/register", json=who).json()["token"]
        self.assertEqual(client.post("/api/auth/register", json=who).status_code, 409)
        auth = {"Authorization": f"Bearer {token}"}
        self.assertEqual(client.get("/api/me", headers=auth).json()["plan"], None)
        self.assertEqual(client.get("/api/me").status_code, 401)
        client.put("/api/me/plan", headers=auth, json={"data": {"inputs": {"budget": 500}}})
        # another device: sign in with the password and the same plan is there
        self.assertEqual(client.post("/api/auth/login", json={**who, "password": "wrong password"}).status_code, 401)
        other = {"Authorization": "Bearer " + client.post("/api/auth/login", json=who).json()["token"]}
        self.assertEqual(client.get("/api/me", headers=other).json()["plan"], {"inputs": {"budget": 500}})
        client.post("/api/auth/logout", headers=other)
        self.assertEqual(client.get("/api/me", headers=other).status_code, 401)
        # deleting removes everything: the first session stops working and the email is free again
        self.assertEqual(client.delete("/api/me", headers=auth).status_code, 204)
        self.assertEqual(client.get("/api/me", headers=auth).status_code, 401)
        self.assertEqual(client.post("/api/auth/login", json=who).status_code, 401)

    def test_ai_use_by_an_account_is_metered(self):
        import uuid

        from app import accounts

        allow = lambda auth, kind: client.post("/api/ai/allow", headers=auth, json={"kind": kind})  # noqa: E731
        self.assertEqual(client.post("/api/ai/allow", json={"kind": "chat"}).status_code, 401)
        who = {"email": f"a{uuid.uuid4().hex[:8]}@example.com", "password": "correct horse"}
        auth = {"Authorization": "Bearer " + client.post("/api/auth/register", json=who).json()["token"]}
        self.assertEqual(allow(auth, "other").status_code, 422)
        self.assertEqual(client.get("/api/me", headers=auth).json()["tier"], "free")
        # for the demo period the Free quotas are off: only the per-minute limits apply, ten of each kind
        for _ in range(accounts.AI_CALLS_PER_MINUTE):
            self.assertEqual(allow(auth, "doc").json()["docs_left"], None)
        limited = allow(auth, "doc")
        self.assertEqual(limited.status_code, 429)
        self.assertIn("Retry-After", limited.headers)
        for _ in range(accounts.AI_CALLS_PER_MINUTE - 1):
            self.assertEqual(allow(auth, "chat").status_code, 200)
        self.assertEqual(allow(auth, "script").status_code, 200)
        self.assertEqual(allow(auth, "chat").status_code, 429)
        client.delete("/api/me", headers=auth)

    def test_free_plan_quotas_and_the_trial(self):
        import uuid

        from app import accounts

        allow = lambda auth, kind: client.post("/api/ai/allow", headers=auth, json={"kind": kind})  # noqa: E731
        who = {"email": f"q{uuid.uuid4().hex[:8]}@example.com", "password": "correct horse"}
        auth = {"Authorization": "Bearer " + client.post("/api/auth/register", json=who).json()["token"]}
        accounts.FREE_LIMITS_ON = True
        try:
            # Free: one test scan (a failed read is given back), and five questions a month
            first = allow(auth, "doc").json()
            self.assertEqual(first["docs_left"], 0)
            self.assertEqual(client.delete(f"/api/ai/use/{first['id']}", headers=auth).status_code, 204)
            self.assertEqual(allow(auth, "doc").status_code, 200)
            self.assertEqual(allow(auth, "doc").status_code, 403)
            for left in range(accounts.FREE_CHATS_PER_MONTH - 1, -1, -1):
                self.assertEqual(allow(auth, "chat").json()["chats_left"], left)
            self.assertEqual(allow(auth, "chat").status_code, 403)
            # the trial lifts both limits, once
            self.assertEqual(client.post("/api/me/trial").status_code, 401)
            self.assertEqual(client.post("/api/me/trial", headers=auth).json()["tier"], "plus")
            self.assertEqual(client.post("/api/me/trial", headers=auth).status_code, 409)
            self.assertEqual(allow(auth, "doc").json()["docs_left"], None)
        finally:
            accounts.FREE_LIMITS_ON = False
        client.delete("/api/me", headers=auth)

    def test_many_cards_are_planned_up_to_a_guard(self):
        six = [{**c, "name": f"{c['name']} {n}"} for n in (1, 2) for c in DEMO["cards"]]
        plan = client.post("/api/plan/calculate", json={**DEMO, "budget": 900, "cards": six})
        self.assertEqual(plan.status_code, 200)
        self.assertEqual(plan.json()["status"], "ok")
        self.assertEqual(len(plan.json()["this_cycle"]), 6)
        r = client.post("/api/plan/calculate", json={**DEMO, "cards": DEMO["cards"] * 7})
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
