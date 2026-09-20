import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models import Appointment, Factuur, SubscriptionInvoice


async def test_uq_facturen_factuur_totaal_blocks_exact_repeat(db_session):
    db_session.add(Factuur(factuur="F-1", totaal=100.0))
    await db_session.commit()

    db_session.add(Factuur(factuur="F-1", totaal=100.0))
    with pytest.raises(IntegrityError):
        await db_session.commit()


async def test_uq_facturen_factuur_totaal_allows_same_factuur_different_totaal(db_session):
    """The original spreadsheet deliberately kept a second row when the amount on the same
    factuur number changed (a correction from Zoofy) — that's a discrepancy to flag, not an
    error, so the constraint must NOT block it."""
    db_session.add(Factuur(factuur="F-2", totaal=100.0))
    await db_session.commit()

    db_session.add(Factuur(factuur="F-2", totaal=200.0))
    await db_session.commit()  # must not raise

    rows = (await db_session.execute(select(Factuur).where(Factuur.factuur == "F-2"))).scalars().all()
    assert len(rows) == 2


async def test_subscription_invoices_factuur_is_unique(db_session):
    db_session.add(SubscriptionInvoice(factuur="S-1", kenmerk="k"))
    await db_session.commit()

    db_session.add(SubscriptionInvoice(factuur="S-1", kenmerk="different kenmerk"))
    with pytest.raises(IntegrityError):
        await db_session.commit()


async def test_appointments_klusnummer_is_unique(db_session):
    db_session.add(Appointment(klusnummer="K-1"))
    await db_session.commit()

    db_session.add(Appointment(klusnummer="K-1"))
    with pytest.raises(IntegrityError):
        await db_session.commit()
