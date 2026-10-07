"""Create or refresh the demo account:  DEMO_PASSWORD=... python -m app.create_demo_user

Reads DEMO_PASSWORD (required) and DEMO_EMAIL (default demo@zoofyautomation.norwen.nl) from the
environment. Registration is closed, so accounts are created here instead of over HTTP.
"""

import asyncio
import os
import sys

from sqlalchemy import select

from app.auth import hash_password
from app.db import async_session, engine
from app.models import User

DEFAULT_EMAIL = "demo@zoofyautomation.norwen.nl"


async def main() -> None:
    password = os.environ.get("DEMO_PASSWORD")
    if not password:
        sys.exit("DEMO_PASSWORD is required")
    email = os.environ.get("DEMO_EMAIL", DEFAULT_EMAIL)

    async with async_session() as db:
        user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
        if user is None:
            db.add(User(email=email, name="Demo", password_hash=hash_password(password), is_demo=True))
            action = "created"
        elif user.is_demo:
            user.password_hash = hash_password(password)
            action = "password reset"
        else:
            # A typo'd DEMO_EMAIL must never quietly downgrade the real owner to the anonymised view.
            sys.exit(f"{email} is a regular account; refusing to turn it into a demo account")
        await db.commit()
    await engine.dispose()
    print(f"Demo account {email}: {action}")


if __name__ == "__main__":
    asyncio.run(main())
