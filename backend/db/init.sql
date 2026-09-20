CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscription_invoices (
    id SERIAL PRIMARY KEY,
    factuur TEXT NOT NULL UNIQUE,
    kenmerk TEXT NOT NULL,
    factuurdatum DATE,
    vervaldatum DATE,
    amount NUMERIC(10, 2),
    thread_link TEXT,
    pdf_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS appointments (
    id SERIAL PRIMARY KEY,
    klusnummer TEXT NOT NULL UNIQUE,
    klus TEXT,
    appointment_date DATE,
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    thread_link TEXT,
    cancelled_at TIMESTAMPTZ,
    cancelled_thread_link TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS facturen (
    id SERIAL PRIMARY KEY,
    factuur TEXT NOT NULL,
    klant TEXT,
    afzender_naam TEXT,
    afzender_email TEXT,
    kenmerk TEXT,
    klusnummer TEXT,
    klusomschrijving TEXT,
    klusadres TEXT,
    factuurdatum DATE,
    vervaldatum DATE,
    totaal NUMERIC(10, 2),
    thread_link TEXT,
    pdf_url TEXT,
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_facturen_factuur_totaal UNIQUE (factuur, totaal)
);
