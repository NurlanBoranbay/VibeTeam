import base64
import io
import os
import tempfile
import unittest

os.environ.setdefault("DATABASE_URL", "sqlite:///" + os.path.join(tempfile.mkdtemp(), "test.db").replace("\\", "/"))

from fastapi.testclient import TestClient  # noqa: E402
from openpyxl import Workbook  # noqa: E402

from app.importer import ImportProblem, read_cards  # noqa: E402
from app.main import app  # noqa: E402

CSV = b"""Card,Current balance,Purchase APR,Minimum payment,Due day,Credit limit
Card A,"$1,500.00",29%,$40,22,"$3,000"
Card B,2500,24,60,28,5000
Card C,600,0.19,30,12/05/2026,
"""


class ImporterTest(unittest.TestCase):
    def test_csv(self):
        out = read_cards("cards.csv", CSV)
        self.assertEqual([c["name"] for c in out["cards"]], ["Card A", "Card B", "Card C"])
        self.assertEqual(out["cards"][0], {"name": "Card A", "balance": 1500.0, "minimum": 40.0, "apr": 29.0, "due_day": 22, "limit": 3000.0})
        self.assertEqual(out["cards"][2]["apr"], 19.0)  # 0.19 read as 19%
        self.assertEqual(out["cards"][2]["due_day"], 5)  # a date becomes its day
        self.assertIsNone(out["cards"][2]["limit"])

    def test_excel_with_title_row_and_extra_cards(self):
        wb = Workbook()
        ws = wb.active
        ws.append(["My cards"])
        ws.append(["Name", "Balance", "Rate", "Min", "Due"])
        for i in range(22):
            ws.append([f"Card {i}", 1000 + i, 20 + i, 25, 10 + i])
        buf = io.BytesIO()
        wb.save(buf)
        out = read_cards("cards.xlsx", buf.getvalue())
        self.assertEqual(len(out["cards"]), 20)
        self.assertEqual(out["cards"][1], {"name": "Card 1", "balance": 1001.0, "minimum": 25.0, "apr": 21.0, "due_day": 11, "limit": None})
        self.assertTrue(any("first 20" in n for n in out["notes"]))
        self.assertTrue(any("credit limit" in n for n in out["notes"]))

    def test_semicolon_csv_with_only_a_balance(self):
        out = read_cards("x.csv", "Name;Balance\nVisa;1200\n".encode())
        self.assertEqual(out["cards"][0]["balance"], 1200.0)
        self.assertIsNone(out["cards"][0]["apr"])
        self.assertTrue(any("no APR" in n for n in out["notes"]))

    def test_problems_are_readable(self):
        with self.assertRaises(ImportProblem):
            read_cards("x.csv", b"a,b\n1,2\n")
        with self.assertRaises(ImportProblem):
            read_cards("x.xls", b"whatever")

    def test_endpoint_then_plan(self):
        client = TestClient(app)
        r = client.post("/api/import/table", json={"filename": "cards.csv", "content_base64": base64.b64encode(CSV).decode()})
        self.assertEqual(r.status_code, 200)
        cards = r.json()["cards"]
        # imported cards are not classified, so nothing is forecast until the person confirms each one
        raw = client.post("/api/plan/calculate", json={"budget": 500, "start": "2026-11-14", "cards": cards}).json()
        self.assertEqual((raw["status"], raw["forecast"], raw["this_cycle"]), ("limited", None, []))
        self.assertEqual({x["code"] for x in raw["card_status"]}, {"unsure"})
        confirmed = [{**c, "treatment": "revolving"} for c in cards]
        plan = client.post("/api/plan/calculate", json={"budget": 500, "start": "2026-11-14", "cards": confirmed}).json()
        self.assertEqual([p["total"] for p in plan["this_cycle"]], [410, 60, 30])
        bad = client.post("/api/import/table", json={"filename": "x.csv", "content_base64": base64.b64encode(b"a,b\n1,2\n").decode()})
        self.assertEqual(bad.status_code, 422)
        self.assertIn("Balance", bad.json()["detail"])


if __name__ == "__main__":
    unittest.main()
