from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from app.config import settings
from app.routers import appointments, auth, bookkeeping, facturen, subscriptions

app = FastAPI(title="Zoofy Automation")

app.add_middleware(SessionMiddleware, secret_key=settings.session_secret, same_site="lax")


@app.middleware("http")
async def no_cache_static(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.startswith(("/js/", "/css/")) or path.endswith(".html") or path == "/":
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/api/health")
async def health():
    return {"ok": True}


app.include_router(auth.router)
app.include_router(subscriptions.router)
app.include_router(appointments.router)
app.include_router(facturen.router)
app.include_router(bookkeeping.router)

# Mounted before the frontend catch-all below, otherwise "/" would swallow /uploads requests first.
UPLOADS_DIR = Path(__file__).resolve().parents[2] / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
