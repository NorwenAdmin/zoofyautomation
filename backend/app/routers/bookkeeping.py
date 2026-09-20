from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, require_n8n_api_key
from app.db import get_db
from app.models import BookkeepingEntry, Factuur
from app.schemas import BookkeepingCompareOut, BookkeepingEntryIn, BookkeepingEntryOut

router = APIRouter(tags=["bookkeeping"])


@router.post("/api/bookkeeping-entries", response_model=BookkeepingEntryOut, dependencies=[Depends(require_n8n_api_key)])
async def create_bookkeeping_entry(payload: BookkeepingEntryIn, db: AsyncSession = Depends(get_db)):
    """n8n calls this once per invoice pulled from Kees de Boekhouder. Upsert on kees_id (Kees's
    own numeric id, not invoice_number — see BookkeepingEntry's docstring) — retry-safe the same
    way as every other resource here."""
    stmt = (
        pg_insert(BookkeepingEntry)
        .values(**payload.model_dump())
        .on_conflict_do_nothing(index_elements=["kees_id"])
        .returning(BookkeepingEntry)
    )
    result = await db.execute(stmt)
    await db.commit()
    row = result.scalar_one_or_none()
    if row is None:
        existing = await db.execute(select(BookkeepingEntry).where(BookkeepingEntry.kees_id == payload.kees_id))
        row = existing.scalar_one()
    return row


@router.get("/api/bookkeeping-entries", response_model=list[BookkeepingEntryOut])
async def list_bookkeeping_entries(db: AsyncSession = Depends(get_db), _current_user=Depends(get_current_user)):
    result = await db.execute(select(BookkeepingEntry).order_by(BookkeepingEntry.invoice_date.desc().nulls_last()))
    return result.scalars().all()


@router.get("/api/bookkeeping/compare", response_model=BookkeepingCompareOut)
async def compare_bookkeeping(db: AsyncSession = Depends(get_db), _current_user=Depends(get_current_user)):
    """Diffs facturen (from Zoofy's emails) against bookkeeping_entries (pulled from Kees)
    so n8n can flag invoices Zoofy issued that the accountant hasn't entered yet. Matches on
    factuur/invoice_number, factuur/file_name, or kenmerk/invoice_number — Kees's invoice_number
    sometimes actually holds the Kenmerk value instead of the real invoice number, and file_name
    stays factuur-shaped even then, so no single field pairing is reliable on its own.
    Both sides are sorted by date descending (most recent first) so the frontend's two lists
    don't come back in arbitrary insertion order."""
    facturen = (
        (await db.execute(select(Factuur).order_by(Factuur.factuurdatum.desc().nulls_last())))
        .scalars()
        .all()
    )
    entries = (
        (await db.execute(select(BookkeepingEntry).order_by(BookkeepingEntry.invoice_date.desc().nulls_last())))
        .scalars()
        .all()
    )

    def matches(f: Factuur, e: BookkeepingEntry) -> bool:
        if e.invoice_number and f.factuur == e.invoice_number:
            return True
        if e.file_name and f.factuur == e.file_name:
            return True
        if f.kenmerk and e.invoice_number and f.kenmerk == e.invoice_number:
            return True
        return False

    missing_in_bookkeeping = [f for f in facturen if not any(matches(f, e) for e in entries)]
    missing_in_facturen = [e for e in entries if not any(matches(f, e) for f in facturen)]

    return BookkeepingCompareOut(
        missing_in_bookkeeping=missing_in_bookkeeping,
        missing_in_facturen=missing_in_facturen,
    )
