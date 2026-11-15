"""Run the whole app on one port: frontend, backend and the AI service.

When `frontend/dist` exists and is newer than the source (`npm run build` in frontend/, which
type-checks first), that build is served. Otherwise the source is compiled in the browser
(React and Babel from a CDN), which needs no Node but does no type checking.

Run from the repo root:  python scripts/preview.py   then open http://localhost:8765
"""
import os
import re
import sys
import tempfile

REPO = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Settings live in .env at the repo root (never committed): model endpoints, keys, the database.
_env = os.path.join(REPO, ".env")
if os.path.exists(_env):
    for _line in open(_env, encoding="utf-8"):
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())

PORT = int(os.environ.get("PORT", "8765"))
HOST = os.environ.get("HOST", "127.0.0.1")
# Without DATABASE_URL the data lives in a temporary folder and is gone on restart.
os.environ.setdefault("DATABASE_URL", "sqlite:///" + os.path.join(tempfile.mkdtemp(), "preview.db").replace("\\", "/"))
os.environ.setdefault("BACKEND_URL", f"http://127.0.0.1:{PORT}")  # the assistant reads plans from the API on this same server
sys.path.insert(0, os.path.join(REPO, "backend"))
sys.path.insert(1, os.path.join(REPO, "ai"))

from fastapi.responses import HTMLResponse, PlainTextResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from app.main import app  # noqa: E402
import service as ai_service  # noqa: E402

SRC = os.path.join(REPO, "frontend", "src")
ORDER = ["format.ts", "api.ts", "store.tsx", "ui.tsx", "pages/Landing.tsx", "pages/Import.tsx", "pages/Setup.tsx", "pages/PlanPages.tsx", "pages/ToolPages.tsx", "pages/Extras.tsx", "App.tsx", "main.tsx"]


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
<link rel="stylesheet" href="/src/styles.css?v=__V__"></head><body><div id="root"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js"></script>
<script>
// The compiled app is kept in this browser per source version, so a repeat visit skips the download,
// the 3 MB compiler and the ~1 s compile. A new version (any source edit) compiles once, then is kept.
(function () {
  const KEY = 'finpilot.compiled', V = '__V__';
  const fail = e => { document.body.innerHTML = '<pre style="color:#f88;padding:24px">' + String(e && e.stack || e) + '</pre>'; console.error(e); };
  let cached = null;
  try { const c = JSON.parse(localStorage.getItem(KEY) || 'null'); if (c && c.v === V) cached = c.js; } catch (e) {}
  if (cached) { try { (0, eval)(cached); return; } catch (e) { console.warn('cached build failed, recompiling', e); } }
  const babel = new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.26.4/babel.min.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
  Promise.all([fetch('/bundle.tsx?v=' + V).then(r => r.text()), babel]).then(([src]) => {
    const js = Babel.transform(src, { presets: [['typescript', { isTSX: true, allExtensions: true }], 'react'], filename: 'bundle.tsx' }).code;
    (0, eval)(js);
    try { localStorage.setItem(KEY, JSON.stringify({ v: V, js })); } catch (e) {}
  }).catch(fail);
})();
</script></body></html>"""


def version() -> str:
    """A fingerprint of exactly what is served: the bundle and the stylesheet. It changes when either does
    (including a change to ORDER above), so a browser never reuses an old compiled copy or stylesheet."""
    import hashlib

    h = hashlib.sha1(bundle().encode("utf-8"))
    h.update(open(os.path.join(SRC, "styles.css"), "rb").read())
    return h.hexdigest()[:12]


DIST = os.path.join(REPO, "frontend", "dist")


def built() -> bool:
    """True when `npm run build` output exists and is newer than every source file, so it is what the source says."""
    page = os.path.join(DIST, "index.html")
    if not os.path.exists(page):
        return False
    newest = max(os.path.getmtime(os.path.join(d, f)) for d, _, fs in os.walk(SRC) for f in fs)
    return os.path.getmtime(page) >= newest


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    # The type-checked production build when it is up to date; otherwise the source, compiled in the browser.
    if built():
        return HTMLResponse(open(os.path.join(DIST, "index.html"), encoding="utf-8").read(), headers={"Cache-Control": "no-store"})
    return HTMLResponse(PAGE.replace("__V__", version()), headers={"Cache-Control": "no-store"})


@app.get("/bundle.tsx", response_class=PlainTextResponse)
def bundle_route() -> str:
    return bundle()


app.mount("/ai", ai_service.app)
app.mount("/src", StaticFiles(directory=SRC), name="src")
if os.path.isdir(os.path.join(DIST, "assets")):
    app.mount("/assets", StaticFiles(directory=os.path.join(DIST, "assets")), name="assets")
app.mount("/img", StaticFiles(directory=os.path.join(REPO, "frontend", "public", "img")), name="img")

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
