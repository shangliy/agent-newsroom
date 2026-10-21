"""OpenStreetMap adapters: Nominatim geocoding and Overpass place search.

Plain urllib, explicit User-Agent (required by both services), 20–30 s timeouts,
2 MB response cap, no redirects. Public map data only; nothing is scraped from
business websites.
"""
from __future__ import annotations

import json
import re
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
    def brand(self) -> str:
        return self.tags.get("brand", "")

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


# OSM tag -> feature label. Only explicit tags count; a missing tag is "unknown", never "no".
FEATURE_TAGS = (
    ("internet_access", ("wlan", "yes", "wifi"), "Wi-Fi"),
    ("outdoor_seating", ("yes",), "Outdoor seating"),
    ("wheelchair", ("yes",), "Wheelchair accessible"),
    ("takeaway", ("yes", "only"), "Takeaway"),
    ("drive_through", ("yes",), "Drive-through"),
    ("diet:vegan", ("yes", "only"), "Vegan options"),
    ("diet:vegetarian", ("yes", "only"), "Vegetarian options"),
    ("diet:gluten_free", ("yes", "only"), "Gluten-free options"),
    ("dog", ("yes",), "Dogs welcome"),
)
_LATE = re.compile(r"-(2[1-4]|0[0-4]):\d\d")


def venue_features(v: Venue, chain_keys: set[str] = frozenset()) -> list[str]:
    """Fine-grained, evidence-backed labels for one place, derived only from its own map tags."""
    out = ["Chain" if chain_key(v) in chain_keys or v.brand else "Independent"]
    out += [label for key, values, label in FEATURE_TAGS if v.tags.get(key, "").lower() in values]
    if v.hours and (_LATE.search(v.hours) or v.hours.strip() == "24/7"):
        out.append("Open after 9pm")
    if v.tags.get("website:menu"):
        out.append("Menu online")
    out += [c.strip().capitalize() for c in v.cuisine.split(",") if c.strip()][:3]
    return list(dict.fromkeys(out))


def chain_key(v: Venue) -> str:
    return (v.tags.get("brand:wikidata") or v.brand or v.name).lower()


def chain_keys(venues: list[Venue], min_locations: int = 3) -> set[str]:
    """Brands tagged in OSM, plus untagged names mapped at several locations in the area (name density)."""
    counts: dict[str, int] = {}
    for v in venues:
        counts[chain_key(v)] = counts.get(chain_key(v), 0) + 1
    return {chain_key(v) for v in venues if v.brand} | {k for k, n in counts.items() if n >= min_locations}


def completeness(v: Venue) -> float:
    return 2 * bool(v.hours) + 2 * bool(v.website) + bool(v.street) + 0.25 * min(4, sum(v.tags.get(k, "").lower() in vals for k, vals, _ in FEATURE_TAGS))


def select_venues(venues: list[Venue], limit: int, per_brand: int = 2) -> list[Venue]:
    """Deduplicate by name + street, rank by record completeness, and cap each brand at `per_brand` places.

    Chains map well (19 of 80 Santa Clara cafés are one brand), so pure completeness sorting fills the
    list with them. The cap keeps the excerpt about the area rather than one brand; overflow is used only
    when there are not enough other places to reach `limit`. Ties are alphabetical, so output is stable.
    """
    seen, unique = set(), []
    for v in venues:
        key = (v.name.lower(), v.street.lower())
        if key in seen:
            continue
        seen.add(key)
        unique.append(v)
    unique.sort(key=lambda v: (-completeness(v), v.name.lower()))
    taken, overflow, per = [], [], {}
    for v in unique:
        k = chain_key(v)
        (taken if per.get(k, 0) < per_brand else overflow).append(v)
        per[k] = per.get(k, 0) + 1
    return (taken + overflow)[:limit]
