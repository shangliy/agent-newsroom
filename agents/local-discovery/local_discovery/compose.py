"""Turn map data (and merchant-provided data) into Agent Publication Protocol 0.1 documents.

Everything factual is tied to evidence: one OpenStreetMap link per place plus the
area boundary. Editorial text is marked opinion/analysis. Nothing is invented:
no ratings, no photos, no visits.
"""
from __future__ import annotations

import re
import unicodedata

from .osm import CATEGORIES, Area, Venue, chain_keys, venue_features

PROTOCOL = "agent-publication/0.1"
MAX_PLACES = 20  # keeps evidence ≤ 50 and the request well under 32 KB


def slug(text: str, limit: int = 40) -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"-{2,}", "-", re.sub(r"[^a-zA-Z0-9]+", "-", ascii_text)).strip("-").lower()[:limit] or "area"


def content_id(category: str, area: Area) -> str:
    return f"local-{category}-{slug(area.short_name)}"[:80]


def _cell(value: str, limit: int = 1000) -> str:
    return (value or "—")[:limit]


def compose_discovery(area: Area, category: str, venues: list[Venue], *, retrieved_at: str, osm_timestamp: str | None = None,
                      editorial: dict | None = None, model: str | None = None, total_found: int | None = None,
                      population: list[Venue] | None = None) -> dict:
    """`venues` are the places to list; `population` is everything the map returned (for coverage and chain detection)."""
    label, key, values = CATEGORIES[category]
    shown = venues[:MAX_PLACES]
    total = total_found if total_found is not None else len(venues)
    date = retrieved_at[:10]
    evidence = [{"id": "osm-area", "url": area.url, "label": f"OpenStreetMap boundary: {area.name}", "retrievedAt": date}]
    evidence += [{"id": v.evidence_id, "url": v.url, "label": f"OpenStreetMap: {v.name}", "retrievedAt": date,
                  "locator": f"{key}={'/'.join(values)}; tags as mapped"} for v in shown]
    venue_ids = [v.evidence_id for v in shown]
    population = population or venues
    with_hours = sum(1 for v in population if v.hours)
    with_site = sum(1 for v in population if v.website)
    with_street = sum(1 for v in population if v.street)
    chains = chain_keys(population)
    features = [venue_features(v, chains) for v in shown]
    independent = sum(1 for v in population if venue_features(v, chains)[0] == "Independent")
    shown_independent = sum(1 for f in features if f[0] == "Independent")

    editorial = editorial or {}
    title = (editorial.get("title") or f"{label} in {area.short_name}, as the map has them")[:200]
    summary = (editorial.get("summary") or
               f"{total} named {label.lower()} are mapped inside {area.short_name} in OpenStreetMap; this note lists {len(shown)}, "
               f"preferring complete records and capping any one brand at two. It is a map excerpt, not a ranking or a review.")[:1000]
    method = (f"OpenStreetMap lists {total} named {label.lower()} inside the mapped boundary of {area.name}. "
              f"Of those, {with_hours} carry opening hours, {with_site} a website and {with_street} a street address; {independent} carry no brand tag "
              f"and are not mapped at three or more locations, which this note calls independent. "
              f"This note shows {len(shown)} ({shown_independent} independent), ranked by how complete each record is, with no brand shown more than "
              f"twice, then alphabetically. Features are copied from explicit map tags; a missing tag means unknown, not absent. Hours, addresses and links are copied "
              f"from map tags on the retrieval date recorded with each source; they can be outdated, and the agent did not visit, call or rate any place.")
    rows = [[_cell(v.name, 200), _cell(v.street, 200), _cell(v.hours, 300), _cell(v.website, 500), _cell(", ".join(f), 300)]
            for v, f in zip(shown, features)]
    blocks = [
        {"id": "method", "type": "text", "mode": "fact", "text": method, "evidenceIds": ["osm-area", *venue_ids]},
        {"id": "places", "type": "table", "mode": "fact", "columns": ["Place", "Street", "Hours as tagged", "Website as tagged", "Features as tagged"],
         "rows": rows, "evidenceIds": venue_ids},
        {"id": "coverage", "type": "chart", "mode": "fact", "chartType": "bar", "unit": "places",
         "points": [{"label": "Named places", "value": total}, {"label": "With hours", "value": with_hours},
                    {"label": "With website", "value": with_site}, {"label": "With street address", "value": with_street},
                    {"label": "Independent", "value": independent}],
         "evidenceIds": ["osm-area", *venue_ids]},
    ]
    picks = _grounded_picks(editorial.get("picks") or [], shown)
    if picks:
        blocks.append({"id": "picks", "type": "text", "mode": "analysis", "text": "\n".join(f"{n}: {r}" for n, r, _ in picks)[:8000],
                       "evidenceIds": sorted({eid for _, _, eid in picks})})
    reading = editorial.get("how_to_read") or (
        "How to use this: treat it as a map excerpt rather than a shortlist. If a place matters to you, confirm its hours on its own site "
        "before going. If you run one of these businesses and the map is wrong, correct it on openstreetmap.org; this note is rebuilt from "
        "the same data, so the fix shows up here on the next revision.")
    blocks.append({"id": "reading", "type": "text", "mode": "opinion", "text": reading[:8000]})
    return {
        "protocol": PROTOCOL, "contentId": content_id(category, area), "revision": 1, "action": "publish",
        "title": title, "summary": summary, "language": "en",
        "topics": ["Local discovery", label, area.short_name][:8],
        "origin": {"kind": "web", "statement": (
            "Compiled by the local discovery agent from OpenStreetMap data (ODbL) via the Overpass API and Nominatim. Places appear as "
            "mapped by volunteers; the agent did not visit them, holds no relationship with them, and this is not a ranking, rating or "
            "endorsement. Merchants can correct their own entry on openstreetmap.org.")},
        "evidence": evidence, "blocks": blocks,
        "extensions": {"newsroom.local-discovery": {"producer": "local-discovery", "framework": "adalflow", "model": model,
                                                     "source": "openstreetmap", "osmTimestamp": osm_timestamp,
                                                     "brief": {"area": area.short_name, "areaOsm": f"{area.osm_type}/{area.osm_id}",
                                                               "category": category, "shown": len(shown), "found": total}},
                       # renderer hint: block id -> column whose comma-separated cells become filter chips
                       "newsroom.facets": {"places": "Features as tagged"}},
    }


def _grounded_picks(picks: list, venues: list[Venue]) -> list[tuple[str, str, str]]:
    """Keep only model picks that name a listed venue; drop anything ungrounded."""
    by_name = {v.name.lower(): v for v in venues}
    out = []
    for pick in picks:
        if isinstance(pick, dict):
            name, reason = str(pick.get("name", "")), str(pick.get("reason", ""))
        else:
            name, _, reason = str(pick).partition(":")
        venue = by_name.get(name.strip().lower())
        if venue and reason.strip():
            out.append((venue.name, reason.strip()[:400], venue.evidence_id))
    return out[:8]


def compose_merchant(merchant: dict, *, retrieved_at: str) -> dict:
    """A merchant's own listing, published with origin=official on their authorization."""
    for field in ("id", "name", "website", "statement", "about"):
        if not merchant.get(field):
            raise ValueError(f"merchant entry needs {field!r}")
    if not str(merchant["website"]).startswith("https://"):
        raise ValueError("merchant website must be HTTPS")
    fictional = bool(merchant.get("fictional"))
    name = merchant["name"][:150]
    hours = merchant.get("hours") or {}
    blocks = [{"id": "about", "type": "text", "mode": "fact", "text": merchant["about"][:8000], "evidenceIds": ["site"]}]
    if hours:
        blocks.append({"id": "hours", "type": "table", "mode": "fact", "columns": ["Day", "Hours"],
                       "rows": [[str(d)[:100], str(h)[:200]] for d, h in list(hours.items())[:7]], "evidenceIds": ["site"]})
    if merchant.get("note"):
        blocks.append({"id": "note", "type": "text", "mode": "opinion", "text": merchant["note"][:8000]})
    return {
        "protocol": PROTOCOL, "contentId": f"merchant-{slug(merchant['id'])}"[:80], "revision": 1, "action": "publish",
        "title": (("[Example] " if fictional else "") + (merchant.get("title") or f"{name}: what the owners want you to know"))[:200],
        "summary": (("Fictional sample merchant entry for testing; not a real business. " if fictional else "") +
                    (merchant.get("summary") or f"Information supplied by {name} and published on their authorization."))[:1000],
        "language": merchant.get("language", "en"),
        "topics": ["Local discovery", "Merchant", *(merchant.get("topics") or [])][:8],
        "origin": {"kind": "official", "representedEntity": name[:200], "statement": merchant["statement"][:1000]},
        "evidence": [{"id": "site", "url": merchant["website"], "label": f"{name} official website", "retrievedAt": retrieved_at[:10]}],
        "blocks": blocks,
        "extensions": {"newsroom.local-discovery": {"producer": "local-discovery", "framework": "adalflow", "source": "merchant-provided",
                                                     "merchantId": merchant["id"], "authorizedUntil": merchant.get("authorizedUntil"),
                                                     "fictional": fictional}},
    }
