from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from app.auth import get_current_user
from app.config import settings
from app.models import User
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

UPLOADS_DIR = Path(__file__).resolve().parents[2] / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


# Uploaded invoice PDFs contain real customer addresses and amounts, so they are served through a
# logged-in route instead of a public StaticFiles mount (which let anyone download
# /uploads/gmail/facturen/<id>.pdf by counting up ids). Registered before the frontend catch-all
# mount below, otherwise "/" would swallow /uploads requests first.
@app.get("/uploads/{file_path:path}", include_in_schema=False)
async def serve_upload(file_path: str, _current_user: User = Depends(get_current_user)):
    root = UPLOADS_DIR.resolve()
    target = (root / file_path).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(target, headers={"Cache-Control": "private, no-store"})


FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
