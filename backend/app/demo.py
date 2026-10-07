"""Anonymised view of the data for the demo account.

The demo user sees the same rows as the owner, but every amount is replaced by a pseudo-random
30-40 EUR, every link points at a dummy URL, house numbers and postcode letters are dropped from
addresses, and coordinates are nudged by roughly 100-200 m. Values are derived from a hash of the
row id, so they are stable across requests and agree between tabs: the same invoice shows the same
price on the Invoices tab, in the map popup and inside the weekly revenue totals.
"""

import hashlib
import re
from datetime import date, timedelta

from app.schemas import (
    AppointmentOut,
    BookkeepingEntryOut,
    FactuurOut,
    RevenueByWeekOut,
    SubscriptionInvoiceOut,
)

PRICE_MIN = 30.0
PRICE_MAX = 40.0
DUMMY_BASE = "https://example.com/demo"

# Roughly +-200 m north/south and +-180 m east/west at Dutch latitudes.
_LAT_SPAN = 0.0036
_LNG_SPAN = 0.0052

_POSTCODE_RE = re.compile(r"\b(\d{4})\s?([A-Za-z]{2})\b")


def _unit(*parts) -> float:
    """Deterministic number in [0, 1) derived from the parts (Python's hash() is salted per run)."""
    digest = hashlib.sha256(":".join(str(p) for p in parts).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def demo_price(kind: str, row_id: int) -> float:
    return round(PRICE_MIN + (PRICE_MAX - PRICE_MIN) * _unit("price", kind, row_id), 2)


def dummy_email_link(kind: str, row_id: int) -> str:
    return f"{DUMMY_BASE}/{kind}/email/{row_id}"


def dummy_pdf_link(kind: str, row_id: int) -> str:
    return f"{DUMMY_BASE}/{kind}/invoice-{row_id}.pdf"


def mask_address(address: str | None) -> str | None:
    """Keep street, 4-digit postcode area and city; drop house number, suffix and postcode letters."""
    if not address:
        return address
    match = _POSTCODE_RE.search(address)
    if match is None:
        return re.split(r"\s\d", address, maxsplit=1)[0].strip(" ,")
    street = re.split(r"\s\d", address[: match.start()], maxsplit=1)[0].strip(" ,")
    city = address[match.end():].strip(" ,")
    return ", ".join(part for part in (street, f"{match.group(1)} {city}".strip()) if part)


def jitter(lat: float | None, lng: float | None, row_id: int) -> tuple[float | None, float | None]:
    if lat is None or lng is None:
        return lat, lng
    return (
        round(lat + (_unit("lat", row_id) - 0.5) * _LAT_SPAN, 6),
        round(lng + (_unit("lng", row_id) - 0.5) * _LNG_SPAN, 6),
    )


def demo_subscription(row: SubscriptionInvoiceOut) -> SubscriptionInvoiceOut:
    return row.model_copy(
        update={
            "amount": demo_price("subscription", row.id),
            "thread_link": dummy_email_link("subscription", row.id) if row.thread_link else None,
            "pdf_url": dummy_pdf_link("subscription", row.id) if row.pdf_url else None,
        }
    )


def demo_appointment(row: AppointmentOut) -> AppointmentOut:
    return row.model_copy(
        update={
            "thread_link": dummy_email_link("appointment", row.id) if row.thread_link else None,
            "cancelled_thread_link": (
                dummy_email_link("appointment-cancelled", row.id) if row.cancelled_thread_link else None
            ),
        }
    )


def demo_factuur(row: FactuurOut) -> FactuurOut:
    lat, lng = jitter(row.lat, row.lng, row.id)
    return row.model_copy(
        update={
            "totaal": demo_price("factuur", row.id),
            "thread_link": dummy_email_link("factuur", row.id) if row.thread_link else None,
            "pdf_url": dummy_pdf_link("factuur", row.id) if row.pdf_url else None,
            "klusadres": mask_address(row.klusadres),
            "lat": lat,
            "lng": lng,
        }
    )


def demo_bookkeeping_entry(row: BookkeepingEntryOut) -> BookkeepingEntryOut:
    # `raw` is Kees's full API response (real amounts, descriptions) — never shown to the demo.
    return row.model_copy(update={"amount_incl": demo_price("bookkeeping", row.id), "raw": None})


def demo_revenue_by_week(rows: list[tuple[int, date]]) -> list[RevenueByWeekOut]:
    """Same shape as the owner's weekly aggregate, but summed from the anonymised prices so the
    totals agree with what the demo sees on the Invoices tab."""
    weeks: dict[date, list[float]] = {}
    for row_id, invoice_date in rows:
        monday = invoice_date - timedelta(days=invoice_date.weekday())
        weeks.setdefault(monday, []).append(demo_price("factuur", row_id))
    return [
        RevenueByWeekOut(
            week_number=monday.isocalendar()[1],
            week_start=monday,
            week_end=monday + timedelta(days=6),
            total=round(sum(prices), 2),
            invoice_count=len(prices),
        )
        for monday, prices in sorted(weeks.items(), reverse=True)
    ]
