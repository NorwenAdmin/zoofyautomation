from datetime import timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import Date, cast, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, require_n8n_api_key
from app.db import get_db
from app.geocoding import geocode_address
from app.models import Factuur
from app.schemas import FactuurIn, FactuurOut, FactuurUpdateIn, RevenueByWeekOut

router = APIRouter(prefix="/api/facturen", tags=["facturen"])

# Sibling of backend/ and frontend/, same reasoning as subscriptions.py — untouched by
# deploy.sh's rsync --delete. Nested under gmail/, see subscriptions.py's UPLOADS_DIR comment.
UPLOADS_DIR = Path(__file__).resolve().parents[3] / "uploads" / "gmail" / "facturen"


@router.post("", response_model=FactuurOut, dependencies=[Depends(require_n8n_api_key)])
async def create_factuur(payload: FactuurIn, db: AsyncSession = Depends(get_db)):
    """n8n calls this once per parsed invoice email. Upsert on (factuur, totaal) together —
    a repeat of the exact same invoice+amount is a re-processed email, skip it; the same
    factuur with a DIFFERENT amount is a genuine discrepancy the original sheet flagged
    instead of silently overwriting, so it's kept as its own row (frontend can spot these by
    grouping on `factuur` and checking for >1 distinct `totaal`)."""
    values = payload.model_dump()
    if values.get("klusadres"):
        coords = await geocode_address(values["klusadres"])
        if coords:
            values["lat"], values["lng"] = coords
    stmt = (
        pg_insert(Factuur)
        .values(**values)
        .on_conflict_do_nothing(constraint="uq_facturen_factuur_totaal")
        .returning(Factuur)
    )
    result = await db.execute(stmt)
    await db.commit()
    row = result.scalar_one_or_none()
    if row is None:
        existing = await db.execute(
            select(Factuur).where(Factuur.factuur == payload.factuur, Factuur.totaal == payload.totaal)
        )
        row = existing.scalar_one()
    return row


@router.patch("/{factuur_id}", response_model=FactuurOut, dependencies=[Depends(require_n8n_api_key)])
async def update_factuur(factuur_id: int, payload: FactuurUpdateIn, db: AsyncSession = Depends(get_db)):
    """n8n calls this once the PDF's text layer has been parsed for the job details that only
    live in the PDF, not the email body (Klusnummer/Klusomschrijving/Klusadres) — a separate
    call from create_factuur since PDF extraction happens on a parallel branch after the row
    already exists, not before."""
    invoice = await db.get(Factuur, factuur_id)
    if invoice is None:
        raise HTTPException(status_code=404, detail=f"No factuur with id {factuur_id}")

    updates = payload.model_dump(exclude_unset=True)
    if updates.get("klusadres"):
        coords = await geocode_address(updates["klusadres"])
        if coords:
            updates["lat"], updates["lng"] = coords
    for field, value in updates.items():
        setattr(invoice, field, value)

    await db.commit()
    await db.refresh(invoice)
    return invoice


@router.post("/{factuur_id}/pdf", response_model=FactuurOut, dependencies=[Depends(require_n8n_api_key)])
async def upload_factuur_pdf(factuur_id: int, file: UploadFile = File(...), db: AsyncSession = Depends(get_db)):
    invoice = await db.get(Factuur, factuur_id)
    if invoice is None:
        raise HTTPException(status_code=404, detail=f"No factuur with id {factuur_id}")

    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    (UPLOADS_DIR / f"{factuur_id}.pdf").write_bytes(await file.read())

    invoice.pdf_url = f"/uploads/gmail/facturen/{factuur_id}.pdf"
    await db.commit()
    await db.refresh(invoice)
    return invoice


@router.get("", response_model=list[FactuurOut])
async def list_facturen(
    db: AsyncSession = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    result = await db.execute(select(Factuur).order_by(Factuur.factuurdatum.desc().nulls_last()))
    return result.scalars().all()


@router.get("/revenue-by-week", response_model=list[RevenueByWeekOut])
async def revenue_by_week(
    db: AsyncSession = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Revenue only — `facturen` (unlike `subscription_invoices`, which is an expense). Rows
    without a factuurdatum can't be placed in a week, so they're excluded rather than guessed."""
    week_start = cast(func.date_trunc("week", Factuur.factuurdatum), Date).label("week_start")
    stmt = (
        select(week_start, func.sum(Factuur.totaal).label("total"), func.count().label("invoice_count"))
        .where(Factuur.factuurdatum.is_not(None))
        .group_by(week_start)
        .order_by(week_start.desc())
    )
    rows = (await db.execute(stmt)).all()
    return [
        RevenueByWeekOut(
            week_number=row.week_start.isocalendar()[1],
            week_start=row.week_start,
            week_end=row.week_start + timedelta(days=6),
            total=row.total,
            invoice_count=row.invoice_count,
        )
        for row in rows
    ]
