# The demo account reads the owner's rows through app/demo.py. Everything here is a pure function
# (no HTTP, no database) except the column-default check, so a regression in the anonymiser shows
# up before any endpoint test has to run.
from datetime import date, datetime, timezone

from sqlalchemy import select

from app import demo
from app.models import User
from app.schemas import AppointmentOut, BookkeepingEntryOut, FactuurOut, SubscriptionInvoiceOut

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _factuur(**overrides) -> FactuurOut:
    base = dict(
        id=7, factuur="2026-1", klant="ZixyAero", afzender_naam=None, afzender_email=None, kenmerk="k",
        klusnummer="1", klusomschrijving="Lamp", klusadres="Mortelstraat 117 1019VE Amsterdam",
        factuurdatum=date(2026, 3, 4), vervaldatum=None, totaal=999.99,
        thread_link="https://mail.google.com/mail/u/0/#inbox/REAL", pdf_url="/uploads/gmail/facturen/7.pdf",
        lat=52.3702, lng=4.9007, created_at=NOW,
    )
    base.update(overrides)
    return FactuurOut(**base)


def test_demo_price_is_always_within_30_and_40():
    prices = [demo.demo_price("factuur", i) for i in range(1, 2001)]
    assert all(30.0 <= p <= 40.0 for p in prices)


def test_demo_price_looks_random_not_constant():
    prices = {demo.demo_price("factuur", i) for i in range(1, 501)}
    assert len(prices) > 300


def test_demo_price_is_stable_per_row_and_differs_per_kind():
    assert demo.demo_price("factuur", 42) == demo.demo_price("factuur", 42)
    assert demo.demo_price("factuur", 42) != demo.demo_price("bookkeeping", 42)


def test_mask_address_keeps_street_postcode_area_and_city_only():
    assert demo.mask_address("Mortelstraat 117 1019VE Amsterdam") == "Mortelstraat, 1019 Amsterdam"
    assert demo.mask_address("Hiraistraat 3 C 5 1101DA Amsterdam") == "Hiraistraat, 1101 Amsterdam"
    assert demo.mask_address("Carolina MacGillavrylaan 1058 1098 1098XC Amsterdam") == "Carolina MacGillavrylaan, 1098 Amsterdam"


def test_mask_address_does_not_cut_streets_that_start_with_a_digit():
    assert demo.mask_address("2e Oosterparkstraat 12 3 1091GR Amsterdam") == "2e Oosterparkstraat, 1091 Amsterdam"


def test_mask_address_handles_missing_city_missing_postcode_and_none():
    assert demo.mask_address("Eerste Jacob van Campenstraat 57 3 1072BD") == "Eerste Jacob van Campenstraat, 1072"
    assert demo.mask_address("Somewhere 5") == "Somewhere"
    assert demo.mask_address(None) is None
    assert demo.mask_address("") == ""


def test_masked_address_never_contains_the_house_number_or_postcode_letters():
    masked = demo.mask_address("Mortelstraat 117 1019VE Amsterdam")
    assert "117" not in masked and "VE" not in masked


def test_jitter_is_small_stable_and_passes_none_through():
    lat, lng = demo.jitter(52.3702, 4.9007, 7)
    assert (lat, lng) == demo.jitter(52.3702, 4.9007, 7)
    assert abs(lat - 52.3702) <= 0.0019 and abs(lng - 4.9007) <= 0.0027
    assert (lat, lng) != (52.3702, 4.9007)
    assert demo.jitter(None, None, 7) == (None, None)


def test_demo_factuur_replaces_every_sensitive_field():
    out = demo.demo_factuur(_factuur())
    assert 30.0 <= out.totaal <= 40.0
    assert out.thread_link.startswith("https://example.com/demo/") and "google" not in out.thread_link
    assert out.pdf_url.startswith("https://example.com/demo/") and "/uploads/" not in out.pdf_url
    assert "117" not in out.klusadres and "1019VE" not in out.klusadres
    assert (out.lat, out.lng) != (52.3702, 4.9007)
    # untouched, non-sensitive fields keep the real shape
    assert out.factuur == "2026-1" and out.klusomschrijving == "Lamp" and out.factuurdatum == date(2026, 3, 4)


def test_demo_factuur_keeps_empty_links_empty():
    out = demo.demo_factuur(_factuur(thread_link=None, pdf_url=None, lat=None, lng=None, klusadres=None))
    assert out.thread_link is None and out.pdf_url is None and out.lat is None and out.klusadres is None


def test_demo_subscription_and_appointment_get_dummy_links():
    sub = demo.demo_subscription(SubscriptionInvoiceOut(
        id=3, factuur="s", kenmerk="k", factuurdatum=None, vervaldatum=None, amount=24.14,
        thread_link="https://mail.google.com/x", pdf_url="/uploads/gmail/subscriptions/s.pdf", created_at=NOW))
    assert 30.0 <= sub.amount <= 40.0 and sub.thread_link.startswith("https://example.com/demo/")
    appt = demo.demo_appointment(AppointmentOut(
        id=4, klusnummer="1", klus=None, appointment_date=None, start_time=None, end_time=None,
        thread_link="https://mail.google.com/a", cancelled_at=None,
        cancelled_thread_link="https://mail.google.com/b", created_at=NOW))
    assert appt.thread_link.startswith("https://example.com/demo/")
    assert appt.cancelled_thread_link.startswith("https://example.com/demo/")
    assert appt.thread_link != appt.cancelled_thread_link


def test_demo_bookkeeping_entry_drops_the_raw_kees_payload():
    out = demo.demo_bookkeeping_entry(BookkeepingEntryOut(
        id=9, kees_id=123, invoice_number="n", file_name="f", description="d", customer_name="c",
        amount_incl=1540.0, state="UNPAID", invoice_date=None, raw={"invoiceRows": [{"amount": 1540.0}]}, created_at=NOW))
    assert out.raw is None and 30.0 <= out.amount_incl <= 40.0


def test_demo_revenue_by_week_sums_the_same_prices_the_invoices_tab_shows():
    # Monday 2026-03-02 .. Sunday 2026-03-08 holds ids 1 and 2; the next Monday holds id 3.
    rows = [(1, date(2026, 3, 2)), (2, date(2026, 3, 8)), (3, date(2026, 3, 9))]
    weeks = demo.demo_revenue_by_week(rows)
    assert [w.week_start for w in weeks] == [date(2026, 3, 9), date(2026, 3, 2)]  # most recent first
    first = weeks[1]
    assert (first.week_end, first.week_number, first.invoice_count) == (date(2026, 3, 8), 10, 2)
    assert first.total == round(demo.demo_price("factuur", 1) + demo.demo_price("factuur", 2), 2)
    assert 60.0 <= first.total <= 80.0


async def test_new_users_are_not_demo_by_default(db_session):
    db_session.add(User(email="owner@example.nl", password_hash="x", name="Owner"))
    await db_session.commit()
    user = (await db_session.execute(select(User).where(User.email == "owner@example.nl"))).scalar_one()
    assert user.is_demo is False
    await db_session.delete(user)
    await db_session.commit()
