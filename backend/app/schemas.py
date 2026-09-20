from datetime import date, datetime

from pydantic import BaseModel, EmailStr


class RegisterIn(BaseModel):
    email: EmailStr
    password: str
    name: str


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: int
    email: str
    name: str

    model_config = {"from_attributes": True}


class SubscriptionInvoiceIn(BaseModel):
    factuur: str
    kenmerk: str
    factuurdatum: date | None = None
    vervaldatum: date | None = None
    amount: float | None = None
    thread_link: str | None = None


class SubscriptionInvoiceOut(BaseModel):
    id: int
    factuur: str
    kenmerk: str
    factuurdatum: date | None
    vervaldatum: date | None
    amount: float | None
    thread_link: str | None
    pdf_url: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class AppointmentIn(BaseModel):
    klusnummer: str
    klus: str | None = None
    appointment_date: date | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None
    thread_link: str | None = None


class AppointmentCancelIn(BaseModel):
    klus: str | None = None
    thread_link: str | None = None


class AppointmentOut(BaseModel):
    id: int
    klusnummer: str
    klus: str | None
    appointment_date: date | None
    start_time: datetime | None
    end_time: datetime | None
    thread_link: str | None
    cancelled_at: datetime | None
    cancelled_thread_link: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class FactuurIn(BaseModel):
    factuur: str
    klant: str | None = None
    afzender_naam: str | None = None
    afzender_email: str | None = None
    kenmerk: str | None = None
    klusnummer: str | None = None
    klusomschrijving: str | None = None
    klusadres: str | None = None
    factuurdatum: date | None = None
    vervaldatum: date | None = None
    totaal: float | None = None
    thread_link: str | None = None


class FactuurUpdateIn(BaseModel):
    klusnummer: str | None = None
    klusomschrijving: str | None = None
    klusadres: str | None = None


class FactuurOut(BaseModel):
    id: int
    factuur: str
    klant: str | None
    afzender_naam: str | None
    afzender_email: str | None
    kenmerk: str | None
    klusnummer: str | None
    klusomschrijving: str | None
    klusadres: str | None
    factuurdatum: date | None
    vervaldatum: date | None
    totaal: float | None
    thread_link: str | None
    pdf_url: str | None
    lat: float | None
    lng: float | None
    created_at: datetime

    model_config = {"from_attributes": True}
