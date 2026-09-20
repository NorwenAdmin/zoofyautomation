from datetime import date, datetime

from sqlalchemy import Date, DateTime, Integer, Numeric, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SubscriptionInvoice(Base):
    """Zoofy's monthly membership invoice — an expense billed TO us, kept separate from
    revenue invoices (Facturen) so the two never get summed together."""

    __tablename__ = "subscription_invoices"

    id: Mapped[int] = mapped_column(primary_key=True)
    factuur: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    kenmerk: Mapped[str] = mapped_column(String, nullable=False)
    factuurdatum: Mapped[date | None] = mapped_column(Date, nullable=True)
    vervaldatum: Mapped[date | None] = mapped_column(Date, nullable=True)
    amount: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
    thread_link: Mapped[str | None] = mapped_column(String, nullable=True)
    pdf_url: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Appointment(Base):
    """A Zoofy job visit. Confirmation and cancellation emails arrive independently and in
    either order, so `cancel` can create a bare stub row (klusnummer + klus only) before the
    confirmation email ever shows up — the confirmation upsert then fills in the rest.
    "Выполнено" status isn't stored here: it's computed by joining against `facturen` on
    klusnummer once that table exists, same as the original sheet recomputed it on every sort."""

    __tablename__ = "appointments"

    id: Mapped[int] = mapped_column(primary_key=True)
    klusnummer: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    klus: Mapped[str | None] = mapped_column(String, nullable=True)
    appointment_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    start_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    end_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    thread_link: Mapped[str | None] = mapped_column(String, nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_thread_link: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Factuur(Base):
    """A completed-job invoice from Zoofy (revenue, unlike SubscriptionInvoice which is an
    expense). Uniqueness is on (factuur, totaal) together, not factuur alone — the original
    sheet deliberately kept multiple rows for the same factuur number when the amount changed
    between them (a correction from Zoofy), flagging it as a discrepancy instead of silently
    overwriting. PDFs are attached by row `id`, not by factuur, since factuur isn't unique here."""

    __tablename__ = "facturen"
    __table_args__ = (UniqueConstraint("factuur", "totaal", name="uq_facturen_factuur_totaal"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    factuur: Mapped[str] = mapped_column(String, nullable=False)
    klant: Mapped[str | None] = mapped_column(String, nullable=True)
    afzender_naam: Mapped[str | None] = mapped_column(String, nullable=True)
    afzender_email: Mapped[str | None] = mapped_column(String, nullable=True)
    kenmerk: Mapped[str | None] = mapped_column(String, nullable=True)
    klusnummer: Mapped[str | None] = mapped_column(String, nullable=True)
    klusomschrijving: Mapped[str | None] = mapped_column(String, nullable=True)
    klusadres: Mapped[str | None] = mapped_column(String, nullable=True)
    factuurdatum: Mapped[date | None] = mapped_column(Date, nullable=True)
    vervaldatum: Mapped[date | None] = mapped_column(Date, nullable=True)
    totaal: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
    thread_link: Mapped[str | None] = mapped_column(String, nullable=True)
    pdf_url: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class BookkeepingEntry(Base):
    """A sales invoice as recorded in the accountant's own system (Exact Online), synced
    separately from `facturen` (which comes from Zoofy's emails) so Compare can catch invoices
    Zoofy issued that the accountant hasn't entered yet. `exact_id` is Exact's own GUID for the
    invoice — the real dedup key, since `invoice_number`/`kenmerk` are just the two candidate
    fields Compare tries to match against `facturen`, and it isn't confirmed yet which one (or
    both) the accountant actually fills in. `raw` keeps Exact's full API response for anything
    not otherwise mapped, since the real field shapes only get confirmed once this is wired up."""

    __tablename__ = "bookkeeping_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    exact_id: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    invoice_number: Mapped[str | None] = mapped_column(String, nullable=True)
    kenmerk: Mapped[str | None] = mapped_column(String, nullable=True)
    amount_incl: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
    invoice_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    financial_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    raw: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
