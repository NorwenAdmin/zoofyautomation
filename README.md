# zoofyautomation

Backend + frontend that replaces Google Sheets/Drive as the system of record for a Zoofy
subcontractor's business (Zoofy is a Dutch marketplace connecting customers with local
handymen/klussers). It's the data layer for an n8n-driven migration off Google Apps Script:
n8n reads Gmail and a third-party bookkeeping API, parses PDFs, and pushes structured records
here via a small internal REST API; this app stores them and gives a human-facing view on top.

Live at `https://zoofyautomation.norwen.nl`.

## What it tracks

- **Подписка Zoofy** — Zoofy's monthly membership invoices (an expense).
- **График работ** — job appointments (confirmations/cancellations arrive as separate emails
  and get merged into one row per `klusnummer`), with a computed "✅ Выполнено" status once a
  matching invoice exists.
- **Facturen** — completed-job revenue invoices parsed from Zoofy's emails and PDFs, with
  address, job description, and geocoded coordinates.
- **Карта** — job locations plotted on a map (Leaflet + OpenStreetMap, geocoded via Nominatim).
- **Бухгалтерия** — diffs the invoices Zoofy issued against what the accountant (Kees de
  Boekhouder) has actually recorded, surfacing anything missing on either side.

All the write endpoints are idempotent (`ON CONFLICT DO NOTHING`/`DO UPDATE`), so the n8n
workflows that feed this app can safely retry without creating duplicates.

## Stack

- **Backend**: FastAPI + SQLAlchemy (async) + PostgreSQL, session-cookie auth for the owner UI
  and a shared `X-API-Key` for n8n's machine-to-machine calls.
- **Frontend**: a single static page (`frontend/`) with vanilla JS — no build step.
- **Tests**: Playwright contract tests validated against the live OpenAPI schema, a pytest
  DB-integrity suite, and security/latency checks — see [TESTING_PLAN.md](TESTING_PLAN.md) for
  the full breakdown, including CI wiring and AI-assisted test generation on contract drift.
- **Deploy**: Docker (Postgres only; the app runs directly via a Python venv + systemd), nginx,
  all on a single VPS.

## Local development

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
docker compose -f ../docker-compose.yml up -d   # Postgres only
.venv/bin/uvicorn app.main:app --reload
```

`app/config.py`'s defaults already point at the local Postgres above — add a `backend/.env` only
to override something (e.g. `GEOCODING_ENABLED=true` to test map geocoding against the real
Nominatim API).

Run the test suites from `tests/` (`npm run test:mock`) and `backend/tests/run.sh` (pytest,
brings up its own throwaway Postgres).

## Deploy

```bash
VPS_HOST=<host> VPS_USER=<user> SSH_KEY=<path> ./deploy/deploy.sh
```

Syncs `backend/` and `frontend/`, installs deps, writes the systemd unit, and configures nginx.
Schema changes to an already-running Postgres volume need a manual `ALTER TABLE`/`CREATE TABLE`
via `docker exec` — there's no migration tool yet, `backend/db/init.sql` only runs on a fresh
volume.
