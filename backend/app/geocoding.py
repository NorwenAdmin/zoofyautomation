import re

import httpx

from app.config import settings

# Free, no API key — matches this project's general preference for avoiding Google
# dependencies wherever Gmail itself isn't the unavoidable reason. Usage policy requires an
# identifying User-Agent (not a browser UA) and no more than ~1 request/sec; callers doing
# bulk work (the backfill script) are responsible for their own pacing between calls.
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "zoofyautomation (https://zoofyautomation.norwen.nl)"

# Dutch postcode: 4 digits + 2 letters, with or without a space, e.g. "1098XC" or "1098 XC".
DUTCH_POSTCODE_RE = re.compile(r"\d{4}\s?[A-Z]{2}")


async def _search(client: httpx.AsyncClient, query: str, **params: str) -> tuple[float, float] | None:
    try:
        res = await client.get(
            NOMINATIM_URL,
            params={"q": query, "format": "json", "limit": 1, **params},
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


async def geocode_address(address: str) -> tuple[float, float] | None:
    """Best-effort: returns (lat, lng) or None on any failure (no match, timeout, network
    error, disabled). Never raises — a factuur must still save even if geocoding fails.

    Falls back to postcode-only geocoding when the full address isn't in Nominatim's street
    index (some smaller/newer residential courts aren't mapped at street level — confirmed on
    6 real klusadres values that failed full-address geocoding but resolved fine by postcode).
    This is coarser (postcode area, ~block-level, not the exact house) but still useful for a
    map pin instead of no pin at all."""
    if not settings.geocoding_enabled:
        return None

    async with httpx.AsyncClient(timeout=5.0) as client:
        coords = await _search(client, address)
        if coords:
            return coords

        match = DUTCH_POSTCODE_RE.search(address)
        if match:
            return await _search(client, f"{match.group()}, Netherlands", countrycodes="nl")

    return None
