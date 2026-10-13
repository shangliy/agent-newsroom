"""OpenStreetMap adapters: Nominatim geocoding and Overpass place search.

Plain urllib, explicit User-Agent (required by both services), 20–30 s timeouts,
2 MB response cap, no redirects. Public map data only; nothing is scraped from
business websites.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

USER_AGENT = "agent-newsroom-local-discovery/0.1 (+https://github.com/shangliy/agent-newsroom)"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
OVERPASS_ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)
SETTLEMENT_TYPES = ("city", "town", "village", "suburb", "neighbourhood", "borough", "quarter",
                    "municipality", "hamlet", "city_district", "district")
# category key -> (label, OSM key, accepted OSM values)
CATEGORIES = {
    "cafe": ("Cafés", "amenity", ["cafe"]),
    "restaurant": ("Restaurants", "amenity", ["restaurant"]),
    "bakery": ("Bakeries", "shop", ["bakery"]),
    "bookstore": ("Bookstores", "shop", ["books"]),
    "grocery": ("Grocery stores", "shop", ["supermarket", "greengrocer", "convenience"]),
    "bike": ("Bike shops", "shop", ["bicycle"]),
    "hardware": ("Hardware stores", "shop", ["hardware", "doityourself"]),
    "florist": ("Florists", "shop", ["florist"]),
    "barber": ("Barbers and hair salons", "shop", ["hairdresser"]),
    "pharmacy": ("Pharmacies", "amenity", ["pharmacy"]),
    "library": ("Libraries", "amenity", ["library"]),
    "bar": ("Bars and pubs", "amenity", ["bar", "pub"]),
    "icecream": ("Ice cream shops", "amenity", ["ice_cream"]),
    "gym": ("Gyms", "leisure", ["fitness_centre"]),
}


class SourceError(Exception):
    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        raise SourceError("REDIRECT", f"unexpected redirect to {newurl}")


def fetch(url: str, params: dict | None = None, timeout: float = 25, max_bytes: int = 2_000_000) -> bytes:
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as response:
            chunks, size = [], 0
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise SourceError("TOO_LARGE", "response exceeds 2 MB")
                chunks.append(chunk)
            return b"".join(chunks)
    except urllib.error.HTTPError as e:
        raise SourceError(f"HTTP_{e.code}", f"{url.split('?')[0]} returned {e.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise SourceError("NETWORK", f"{url.split('?')[0]}: {e.__class__.__name__}") from None


def fetch_json(url: str, params: dict | None = None, **kw):
    raw = fetch(url, params, **kw)
    try:
        return json.loads(raw)
    except ValueError:
        raise SourceError("INVALID_RESPONSE", f"{url.split('?')[0]} did not return JSON") from None


@dataclass(frozen=True)
class Area:
    name: str
    short_name: str
    south: float
    west: float
    north: float
    east: float
    osm_type: str
    osm_id: int

    @property
    def url(self) -> str:
        return f"https://www.openstreetmap.org/{self.osm_type}/{self.osm_id}"

    @property
    def bbox(self) -> str:
        return f"{self.south},{self.west},{self.north},{self.east}"


def parse_area(results: list, prefer=SETTLEMENT_TYPES) -> Area | None:
    """Pick the first settlement-level match; Nominatim often ranks the county first."""
    ranked = sorted(results, key=lambda r: (r.get("addresstype") not in prefer, results.index(r)))
    for r in ranked:
        try:
            s, n, w, e = (float(x) for x in r["boundingbox"])
            return Area(name=r["display_name"], short_name=r["display_name"].split(",")[0].strip(),
                        south=s, west=w, north=n, east=e, osm_type=r["osm_type"], osm_id=int(r["osm_id"]))
        except (KeyError, ValueError, TypeError):
            continue
    return None


def geocode(query: str) -> Area:
    results = fetch_json(NOMINATIM, {"q": query, "format": "jsonv2", "limit": 5})
    area = parse_area(results if isinstance(results, list) else [])
    if not area:
        raise SourceError("NOT_FOUND", f"no mapped area for {query!r}")
    return area


@dataclass
class Venue:
    osm_type: str
    osm_id: int
    name: str
    tags: dict = field(default_factory=dict)
    lat: float | None = None
    lon: float | None = None

    @property
    def key(self) -> str:
        return f"{self.osm_type}/{self.osm_id}"

    @property
    def url(self) -> str:
        return f"https://www.openstreetmap.org/{self.osm_type}/{self.osm_id}"

    @property
    def evidence_id(self) -> str:
        return f"osm-{self.osm_type}-{self.osm_id}"

    @property
    def street(self) -> str:
        number, street = self.tags.get("addr:housenumber", ""), self.tags.get("addr:street", "")
        return " ".join(x for x in (number, street) if x)

    @property
    def hours(self) -> str:
        return self.tags.get("opening_hours", "")

    @property
    def website(self) -> str:
        site = self.tags.get("website") or self.tags.get("contact:website") or ""
        return site if site.startswith(("https://", "http://")) else ""

    @property
    def cuisine(self) -> str:
        return self.tags.get("cuisine", "").replace(";", ", ").replace("_", " ")


def parse_venues(payload: dict) -> tuple[list[Venue], str | None]:
    venues = []
    for element in payload.get("elements", []):
        tags = element.get("tags") or {}
        name = tags.get("name")
        if not name or element.get("type") not in ("node", "way", "relation"):
            continue
        center = element.get("center") or element
        venues.append(Venue(element["type"], int(element["id"]), name.strip(), tags, center.get("lat"), center.get("lon")))
    return venues, (payload.get("osm3s") or {}).get("timestamp_osm_base")


def overpass_query(category: str, area: Area, limit: int = 80) -> str:
    _, key, values = CATEGORIES[category]
    selector = f'["{key}"="{values[0]}"]' if len(values) == 1 else f'["{key}"~"^({"|".join(values)})$"]'
    return f'[out:json][timeout:25];nwr{selector}["name"]({area.bbox});out center tags {int(limit)};'


def search_places(area: Area, category: str, limit: int = 80, endpoints=OVERPASS_ENDPOINTS, sleep=time.sleep) -> tuple[list[Venue], str | None]:
    if category not in CATEGORIES:
        raise SourceError("UNKNOWN_CATEGORY", f"unknown category {category!r}; choose from {', '.join(CATEGORIES)}")
    query, last = overpass_query(category, area, limit), None
    for i, endpoint in enumerate(endpoints):
        if i:
            sleep(1)
        try:
            return parse_venues(fetch_json(endpoint, {"data": query}, timeout=30))
        except SourceError as e:
            last = e
    raise last or SourceError("NETWORK", "no Overpass endpoint answered")


def select_venues(venues: list[Venue], limit: int) -> list[Venue]:
    """Deduplicate by name + street, prefer places with hours and a website, then alphabetical."""
    seen, unique = set(), []
    for v in venues:
        key = (v.name.lower(), v.street.lower())
        if key in seen:
            continue
        seen.add(key)
        unique.append(v)
    unique.sort(key=lambda v: (not v.hours, not v.website, v.name.lower()))
    return unique[:limit]
