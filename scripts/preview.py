"""Preview the whole app without Node.

Serves the frontend source compiled in the browser (React and Babel from a CDN), with the
backend and the AI service mounted on the same origin. For a quick look only: it does no
type checking. The real frontend build is `npm run dev` in frontend/.

Run from the repo root:  python scripts/preview.py   then open http://localhost:8765
"""
import os
import re
import sys
import tempfile

REPO = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(tempfile.mkdtemp(), "preview.db").replace("\\", "/")
sys.path.insert(0, os.path.join(REPO, "backend"))
sys.path.insert(1, os.path.join(REPO, "ai"))

from fastapi.responses import HTMLResponse, PlainTextResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from app.main import app  # noqa: E402
import service as ai_service  # noqa: E402

SRC = os.path.join(REPO, "frontend", "src")
ORDER = ["format.ts", "api.ts", "store.tsx", "ui.tsx", "pages/Landing.tsx", "pages/Setup.tsx", "pages/PlanPages.tsx", "pages/ToolPages.tsx", "App.tsx", "main.tsx"]


def bundle() -> str:
    out = ["const { createContext, useContext, useEffect, useMemo, useState } = React; const { createRoot } = ReactDOM;"]
    for rel in ORDER:
        code = open(os.path.join(SRC, rel), encoding="utf-8").read()
        code = re.sub(r"^import [^;]*;\s*$", "", code, flags=re.M)
        code = re.sub(r"^export default function", "function", code, flags=re.M)
        code = re.sub(r"^export ", "", code, flags=re.M)
        out.append(f"// ---- {rel}\n{code}")
    return "\n".join(out)


PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>FinPilot (preview)</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/src/styles.css"></head><body><div id="root"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.development.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.development.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.26.4/babel.min.js"></script>
<script>
fetch('/bundle.tsx').then(r => r.text()).then(src => {
  const js = Babel.transform(src, { presets: [['typescript', { isTSX: true, allExtensions: true }], 'react'], filename: 'bundle.tsx' }).code;
  (0, eval)(js);
}).catch(e => { document.body.innerHTML = '<pre style="color:#f88;padding:24px">' + String(e && e.stack || e) + '</pre>'; console.error(e); });
</script></body></html>"""


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return PAGE


@app.get("/bundle.tsx", response_class=PlainTextResponse)
def bundle_route() -> str:
    return bundle()


app.mount("/ai", ai_service.app)
app.mount("/src", StaticFiles(directory=SRC), name="src")
app.mount("/img", StaticFiles(directory=os.path.join(REPO, "frontend", "public", "img")), name="img")

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765)
