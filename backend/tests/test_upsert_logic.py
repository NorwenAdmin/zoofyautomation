# US-5: calls the actual FastAPI route functions directly (bypassing HTTP entirely) against a
# real Postgres. This is the retry-safety guarantee n8n actually relies on — if a workflow's
# HTTP Request node times out after the server already committed, n8n just re-sends the same
# payload, and none of these must create a second row.
from sqlalchemy import select

from app.models import Appointment, BookkeepingEntry, Factuur, SubscriptionInvoice
from app.routers.appointments import cancel_appointment, create_appointment
from app.routers.bookkeeping import create_bookkeeping_entry
from app.routers.facturen import create_factuur
from app.routers.subscriptions import create_subscription_invoice
from app.schemas import (
    AppointmentCancelIn,
    AppointmentIn,
    BookkeepingEntryIn,
    FactuurIn,
    SubscriptionInvoiceIn,
)


async def test_create_factuur_retry_does_not_duplicate(db_session):
    payload = FactuurIn(factuur="F-RETRY", totaal=42.0, kenmerk="k")

    first = await create_factuur(payload, db_session)
    second = await create_factuur(payload, db_session)

    assert first.id == second.id
    rows = (await db_session.execute(select(Factuur).where(Factuur.factuur == "F-RETRY"))).scalars().all()
    assert len(rows) == 1


async def test_create_subscription_invoice_retry_does_not_duplicate(db_session):
    payload = SubscriptionInvoiceIn(factuur="S-RETRY", kenmerk="lidmaatschap")

    first = await create_subscription_invoice(payload, db_session)
    second = await create_subscription_invoice(payload, db_session)

    assert first.id == second.id
    rows = (
        (await db_session.execute(select(SubscriptionInvoice).where(SubscriptionInvoice.factuur == "S-RETRY")))
        .scalars()
        .all()
    )
    assert len(rows) == 1


async def test_create_appointment_fills_only_null_fields_not_overwrite(db_session):
    """Confirmation and cancellation emails can arrive in either order. If the confirmation
    (create_appointment) lands twice — the second time with different Klus text, e.g. a
    Zoofy-side edit — the already-set fields must NOT flip on every retry."""
    first = AppointmentIn(klusnummer="K-RETRY", klus="Lamp ophangen", appointment_date="2026-01-01")
    await create_appointment(first, db_session)

    second = AppointmentIn(klusnummer="K-RETRY", klus="Different description", appointment_date="2026-02-02")
    await create_appointment(second, db_session)

    rows = (await db_session.execute(select(Appointment).where(Appointment.klusnummer == "K-RETRY"))).scalars().all()
    assert len(rows) == 1
    assert rows[0].klus == "Lamp ophangen"  # first write wins, matches router's WHERE guard


async def test_cancel_appointment_creates_stub_then_confirmation_fills_it_in(db_session):
    """A cancellation can arrive before Zoofy ever sends a confirmation for the same klusnummer
    — cancel_appointment must create a bare stub rather than error, and a later
    create_appointment call must fill in the visit details onto that same row."""
    await cancel_appointment("K-STUB", AppointmentCancelIn(klus="Lamp ophangen"), db_session)

    stub_rows = (await db_session.execute(select(Appointment).where(Appointment.klusnummer == "K-STUB"))).scalars().all()
    assert len(stub_rows) == 1
    assert stub_rows[0].cancelled_at is not None
    assert stub_rows[0].appointment_date is None

    await create_appointment(
        AppointmentIn(klusnummer="K-STUB", klus="Lamp ophangen", appointment_date="2026-03-03"), db_session
    )

    # The ON CONFLICT DO UPDATE above ran as a Core statement, not through the ORM's own
    # instance tracking — the session's identity map still holds the stub object loaded by the
    # `stub_rows` query above, so a plain select() here would silently return that stale cached
    # instance instead of re-reading Postgres. Force a fresh read, exactly like a real second
    # HTTP request would get (each gets its own brand-new session with an empty identity map).
    db_session.expire_all()
    rows = (await db_session.execute(select(Appointment).where(Appointment.klusnummer == "K-STUB"))).scalars().all()
    assert len(rows) == 1  # still one row, not a second one
    assert rows[0].appointment_date is not None
    assert rows[0].cancelled_at is not None  # the earlier cancellation is preserved


async def test_create_bookkeeping_entry_retry_does_not_duplicate(db_session):
    payload = BookkeepingEntryIn(kees_id=9001, invoice_number="2026-42", amount_incl=121.0)

    first = await create_bookkeeping_entry(payload, db_session)
    second = await create_bookkeeping_entry(payload, db_session)

    assert first.id == second.id
    rows = (
        (await db_session.execute(select(BookkeepingEntry).where(BookkeepingEntry.kees_id == 9001)))
        .scalars()
        .all()
    )
    assert len(rows) == 1


async def test_create_bookkeeping_entry_conflict_keeps_the_first_values(db_session):
    """The router upserts with ON CONFLICT DO NOTHING (not DO UPDATE) and then re-reads the
    existing row — so a re-sync of the same kees_id carrying edited values hands back what is
    already stored instead of overwriting it."""
    await create_bookkeeping_entry(
        BookkeepingEntryIn(kees_id=9002, invoice_number="2026-7", state="open", amount_incl=100.0),
        db_session,
    )

    returned = await create_bookkeeping_entry(
        BookkeepingEntryIn(kees_id=9002, invoice_number="CHANGED", state="paid", amount_incl=250.0),
        db_session,
    )

    assert returned.invoice_number == "2026-7"
    assert returned.state == "open"

    # Same identity-map caveat as the appointments test above: the ON CONFLICT statement ran as
    # a Core statement, so force a re-read rather than trusting the session's cached instance.
    db_session.expire_all()
    rows = (
        (await db_session.execute(select(BookkeepingEntry).where(BookkeepingEntry.kees_id == 9002)))
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert rows[0].invoice_number == "2026-7"
    assert rows[0].state == "open"
    assert float(rows[0].amount_incl) == 100.0


async def test_create_bookkeeping_entry_round_trips_kees_raw_payload(db_session):
    """`raw` holds Kees's full API response as JSONB for anything not otherwise mapped — it has
    to survive the round trip with its nesting intact, not get flattened or stringified."""
    raw = {"invoiceNr": "2026-9", "lines": [{"desc": "Reparatie", "amount": 60.5}], "meta": {"paid": True}}
    await create_bookkeeping_entry(BookkeepingEntryIn(kees_id=9003, raw=raw), db_session)

    db_session.expire_all()
    row = (
        (await db_session.execute(select(BookkeepingEntry).where(BookkeepingEntry.kees_id == 9003)))
        .scalars()
        .one()
    )
    assert row.raw == raw
