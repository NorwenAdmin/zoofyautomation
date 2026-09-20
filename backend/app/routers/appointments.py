from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, require_n8n_api_key
from app.db import get_db
from app.models import Appointment
from app.schemas import AppointmentCancelIn, AppointmentIn, AppointmentOut

router = APIRouter(prefix="/api/appointments", tags=["appointments"])


@router.post("", response_model=AppointmentOut, dependencies=[Depends(require_n8n_api_key)])
async def create_appointment(payload: AppointmentIn, db: AsyncSession = Depends(get_db)):
    """n8n calls this once per confirmation email. If a cancellation for this klusnummer
    already created a bare stub row, this fills in the fields the stub didn't have —
    it never overwrites a field that's already set, so whichever email arrived first wins."""
    values = payload.model_dump()
    stmt = pg_insert(Appointment).values(**values)
    stmt = stmt.on_conflict_do_update(
        index_elements=["klusnummer"],
        set_={
            "klus": pg_insert(Appointment).excluded.klus,
            "appointment_date": pg_insert(Appointment).excluded.appointment_date,
            "start_time": pg_insert(Appointment).excluded.start_time,
            "end_time": pg_insert(Appointment).excluded.end_time,
            "thread_link": pg_insert(Appointment).excluded.thread_link,
        },
        where=Appointment.appointment_date.is_(None),
    ).returning(Appointment)
    result = await db.execute(stmt)
    await db.commit()
    row = result.scalar_one_or_none()
    if row is None:
        # Conflict happened but the WHERE guard skipped the update (already had a date) —
        # row exists, just return it as-is instead of a bare no-op response.
        existing = await db.execute(select(Appointment).where(Appointment.klusnummer == payload.klusnummer))
        row = existing.scalar_one()
    return row


@router.post(
    "/{klusnummer}/cancel",
    response_model=AppointmentOut,
    dependencies=[Depends(require_n8n_api_key)],
)
async def cancel_appointment(klusnummer: str, payload: AppointmentCancelIn, db: AsyncSession = Depends(get_db)):
    """n8n calls this once per cancellation email. Cancellation and confirmation emails can
    arrive in either order, so this creates a bare stub row if the klusnummer isn't known yet —
    the confirmation upsert above fills in the visit details later if it comes in after."""
    stmt = (
        pg_insert(Appointment)
        .values(klusnummer=klusnummer, klus=payload.klus, cancelled_at=func.now(), cancelled_thread_link=payload.thread_link)
        .on_conflict_do_update(
            index_elements=["klusnummer"],
            set_={"cancelled_at": func.now(), "cancelled_thread_link": payload.thread_link},
        )
        .returning(Appointment)
    )
    result = await db.execute(stmt)
    await db.commit()
    return result.scalar_one()


@router.get("", response_model=list[AppointmentOut])
async def list_appointments(
    db: AsyncSession = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    result = await db.execute(
        select(Appointment).order_by(Appointment.appointment_date.desc().nulls_last())
    )
    return result.scalars().all()
