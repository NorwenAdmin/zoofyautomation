# US-5: these tests talk to a real Postgres directly through the same SQLAlchemy models and
# router functions the app uses — not through HTTP. That's the point: a Playwright test hitting
# POST /api/facturen can't tell you whether the *database constraint* still exists after a
# migration change, only whether the endpoint currently behaves as expected. These tests would
# catch a migration that accidentally dropped `uq_facturen_factuur_totaal` even if nobody
# touched the endpoint code.
import os

import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+asyncpg://zoofyautomation:zoofyautomation@localhost:5437/zoofyautomation"
)


@pytest_asyncio.fixture
async def db_session():
    # A fresh engine (and connection) per test, not a shared pool — a test that deliberately
    # triggers an IntegrityError leaves Postgres's transaction aborted, and reusing a pooled
    # connection across tests after that turned out to corrupt asyncpg's internal state
    # ("another operation is in progress") rather than cleanly resetting.
    engine = create_async_engine(TEST_DATABASE_URL, echo=False)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        try:
            yield session
        finally:
            await session.rollback()
            for table in ["subscription_invoices", "appointments", "facturen"]:
                await session.execute(text(f"DELETE FROM {table}"))
            await session.commit()
    await engine.dispose()
