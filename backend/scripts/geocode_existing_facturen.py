"""One-off backfill: geocode every existing facturen row that has a klusadres but no lat/lng
yet. Run manually (not part of any deploy/CI) after `geocoding_enabled` is turned on:

    cd backend && .venv/bin/python scripts/geocode_existing_facturen.py

Paced at >1 req/sec to respect Nominatim's usage policy — this is a one-time bulk job, unlike
the per-request geocoding in routers/facturen.py which never runs more than one lookup at a
time anyway.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select

from app.db import async_session
from app.geocoding import geocode_address
from app.models import Factuur


async def main() -> None:
    async with async_session() as db:
        result = await db.execute(
            select(Factuur).where(Factuur.klusadres.is_not(None), Factuur.lat.is_(None))
        )
        rows = result.scalars().all()
        print(f"{len(rows)} facturen row(s) to geocode")

        geocoded = 0
        for row in rows:
            coords = await geocode_address(row.klusadres)
            if coords:
                row.lat, row.lng = coords
                geocoded += 1
                print(f"  id={row.id} '{row.klusadres}' -> {coords}")
            else:
                print(f"  id={row.id} '{row.klusadres}' -> no match")
            await db.commit()
            await asyncio.sleep(1.1)

        print(f"Done: {geocoded}/{len(rows)} geocoded")


if __name__ == "__main__":
    asyncio.run(main())
