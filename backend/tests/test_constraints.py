import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models import Appointment, BookkeepingEntry, Factuur, SubscriptionInvoice


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


async def test_bookkeeping_entries_exact_id_is_unique(db_session):
    """exact_id is Exact Online's own GUID for the invoice — the dedup key n8n's retry-safety
    hangs off, so the uniqueness has to live in the database, not just in the router's
    ON CONFLICT clause."""
    db_session.add(BookkeepingEntry(exact_id="E-1", invoice_number="INV-1"))
    await db_session.commit()

    db_session.add(BookkeepingEntry(exact_id="E-1", invoice_number="INV-DIFFERENT"))
    with pytest.raises(IntegrityError):
        await db_session.commit()


async def test_bookkeeping_entries_allow_duplicate_invoice_number_and_kenmerk(db_session):
    """invoice_number and kenmerk are only the two candidate fields Compare tries to match
    against `facturen` — it isn't confirmed which one the accountant fills in, and neither is
    guaranteed unique on Exact's side. Constraining either would reject legitimate syncs."""
    db_session.add(BookkeepingEntry(exact_id="E-2", invoice_number="INV-SAME", kenmerk="K-SAME"))
    await db_session.commit()

    db_session.add(BookkeepingEntry(exact_id="E-3", invoice_number="INV-SAME", kenmerk="K-SAME"))
    await db_session.commit()  # must not raise

    rows = (
        (await db_session.execute(select(BookkeepingEntry).where(BookkeepingEntry.invoice_number == "INV-SAME")))
        .scalars()
        .all()
    )
    assert len(rows) == 2


async def test_bookkeeping_entries_accept_only_exact_id(db_session):
    """Every column but exact_id is nullable: Exact's real field shapes are only confirmed once
    the sync is wired up, so an entry carrying nothing but the GUID must still store."""
    db_session.add(BookkeepingEntry(exact_id="E-4"))
    await db_session.commit()  # must not raise

    row = (
        await db_session.execute(select(BookkeepingEntry).where(BookkeepingEntry.exact_id == "E-4"))
    ).scalar_one()
    assert row.invoice_number is None
    assert row.kenmerk is None
    assert row.raw is None
