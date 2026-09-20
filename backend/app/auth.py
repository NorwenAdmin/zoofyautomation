import hmac

import bcrypt
from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_db
from app.models import User


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))


async def get_current_user(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not logged in")

    user = await db.get(User, user_id)
    if user is None:
        request.session.clear()
        raise HTTPException(status_code=401, detail="Not logged in")

    return user


async def require_n8n_api_key(x_api_key: str = Header(default="")) -> None:
    if not hmac.compare_digest(x_api_key, settings.n8n_api_key):
        raise HTTPException(status_code=401, detail="Invalid API key")
