from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, require_n8n_api_key
from app.db import get_db
from app.models import SubscriptionInvoice
from app.schemas import SubscriptionInvoiceIn, SubscriptionInvoiceOut

router = APIRouter(prefix="/api/subscriptions", tags=["subscriptions"])

# Sits next to backend/ and frontend/, not inside either, so `deploy.sh`'s rsync --delete
# (which only manages the contents of backend/ and frontend/) never touches uploaded files.
UPLOADS_DIR = Path(__file__).resolve().parents[3] / "uploads" / "subscriptions"


@router.post("", response_model=SubscriptionInvoiceOut, dependencies=[Depends(require_n8n_api_key)])
async def create_subscription_invoice(payload: SubscriptionInvoiceIn, db: AsyncSession = Depends(get_db)):
    """n8n calls this once per parsed email. Upsert on `factuur` so a re-processed email
    (e.g. label didn't stick, workflow re-run) never creates a duplicate row — n8n doesn't
    need to check for existing rows itself before posting."""
    stmt = (
        pg_insert(SubscriptionInvoice)
        .values(**payload.model_dump())
        .on_conflict_do_nothing(index_elements=["factuur"])
        .returning(SubscriptionInvoice)
    )
    result = await db.execute(stmt)
    await db.commit()
    row = result.scalar_one_or_none()
    if row is None:
        # Already existed — return the existing row instead of a bare "no-op" response.
        existing = await db.execute(
            select(SubscriptionInvoice).where(SubscriptionInvoice.factuur == payload.factuur)
        )
        row = existing.scalar_one()
    return row


@router.post(
    "/{factuur}/pdf",
    response_model=SubscriptionInvoiceOut,
    dependencies=[Depends(require_n8n_api_key)],
)
async def upload_subscription_pdf(factuur: str, file: UploadFile = File(...), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(SubscriptionInvoice).where(SubscriptionInvoice.factuur == factuur))
    invoice = result.scalar_one_or_none()
    if invoice is None:
        raise HTTPException(status_code=404, detail=f"No subscription invoice with factuur '{factuur}'")

    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    # factuur is already validated as an existing unique row, safe to use directly as a filename.
    (UPLOADS_DIR / f"{factuur}.pdf").write_bytes(await file.read())

    invoice.pdf_url = f"/uploads/subscriptions/{factuur}.pdf"
    await db.commit()
    await db.refresh(invoice)
    return invoice


@router.get("", response_model=list[SubscriptionInvoiceOut])
async def list_subscription_invoices(
    db: AsyncSession = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    result = await db.execute(
        select(SubscriptionInvoice).order_by(SubscriptionInvoice.factuurdatum.desc().nulls_last())
    )
    return result.scalars().all()
