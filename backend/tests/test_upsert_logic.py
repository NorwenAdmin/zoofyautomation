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
from app.schemas import AppointmentCancelIn, AppointmentIn, BookkeepingEntryIn, FactuurIn, SubscriptionInvoiceIn


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
    payload = BookkeepingEntryIn(
        exact_id="EX-RETRY",
        invoice_number="INV-RETRY",
        kenmerk="k",
        amount_incl=121.0,
        raw={"Description": "Zoofy klus"},
    )

    first = await create_bookkeeping_entry(payload, db_session)
    second = await create_bookkeeping_entry(payload, db_session)

    assert first.id == second.id
    rows = (
        (await db_session.execute(select(BookkeepingEntry).where(BookkeepingEntry.exact_id == "EX-RETRY")))
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert rows[0].raw == {"Description": "Zoofy klus"}


async def test_create_bookkeeping_entry_conflict_keeps_the_stored_row(db_session):
    """The router upserts ON CONFLICT DO NOTHING, so a re-sync of the same Exact invoice — even
    one carrying changed values — must return the row already stored rather than overwrite it
    or raise. First write wins, unlike facturen where a changed amount is a new row."""
    await create_bookkeeping_entry(
        BookkeepingEntryIn(exact_id="EX-NOOVERWRITE", invoice_number="INV-FIRST", amount_incl=100.0), db_session
    )
    second = await create_bookkeeping_entry(
        BookkeepingEntryIn(exact_id="EX-NOOVERWRITE", invoice_number="INV-SECOND", amount_incl=200.0), db_session
    )

    assert second.invoice_number == "INV-FIRST"

    # Same reason as the appointments stub test above: the insert ran as a Core statement, so a
    # plain select() could hand back the session's cached instance instead of re-reading Postgres.
    db_session.expire_all()
    rows = (
        (await db_session.execute(select(BookkeepingEntry).where(BookkeepingEntry.exact_id == "EX-NOOVERWRITE")))
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert rows[0].invoice_number == "INV-FIRST"
    assert float(rows[0].amount_incl) == 100.0


async def test_create_bookkeeping_entry_dedups_on_exact_id_not_invoice_number(db_session):
    """Two Exact invoices can legitimately share an invoice_number (or a kenmerk) — only the
    GUID identifies the record, so these must stay two rows."""
    await create_bookkeeping_entry(
        BookkeepingEntryIn(exact_id="EX-A", invoice_number="INV-SHARED", kenmerk="K-SHARED"), db_session
    )
    await create_bookkeeping_entry(
        BookkeepingEntryIn(exact_id="EX-B", invoice_number="INV-SHARED", kenmerk="K-SHARED"), db_session
    )

    rows = (
        (await db_session.execute(select(BookkeepingEntry).where(BookkeepingEntry.invoice_number == "INV-SHARED")))
        .scalars()
        .all()
    )
    assert len(rows) == 2
    assert {r.exact_id for r in rows} == {"EX-A", "EX-B"}
