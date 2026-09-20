import httpx

from app.config import settings

# Free, no API key — matches this project's general preference for avoiding Google
# dependencies wherever Gmail itself isn't the unavoidable reason. Usage policy requires an
# identifying User-Agent (not a browser UA) and no more than ~1 request/sec; callers doing
# bulk work (the backfill script) are responsible for their own pacing between calls.
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "zoofyautomation (https://zoofyautomation.norwen.nl)"


async def geocode_address(address: str) -> tuple[float, float] | None:
    """Best-effort: returns (lat, lng) or None on any failure (no match, timeout, network
    error, disabled). Never raises — a factuur must still save even if geocoding fails."""
    if not settings.geocoding_enabled:
        return None
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            res = await client.get(
                NOMINATIM_URL,
                params={"q": address, "format": "json", "limit": 1},
                headers={"User-Agent": USER_AGENT},
            )
            res.raise_for_status()
            results = res.json()
    except (httpx.HTTPError, ValueError):
        return None

    if not results:
        return None
    try:
        return float(results[0]["lat"]), float(results[0]["lon"])
    except (KeyError, ValueError, TypeError):
        return None
