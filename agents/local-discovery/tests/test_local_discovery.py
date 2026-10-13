"""Offline tests for the local discovery agent. Run from agents/local-discovery:
    python3 -m unittest discover -s tests
Protocol conformance is cross-checked with the Node validator (server/publishing/protocol.mjs) when node is available.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

from local_discovery import compose, memory, osm  # noqa: E402
from local_discovery.agent import LocalScout  # noqa: E402

NOMINATIM = json.loads((ROOT / "fixtures" / "nominatim-santa-clara.json").read_text())
OVERPASS = json.loads((ROOT / "fixtures" / "overpass-santa-clara-cafe.json").read_text())
MERCHANTS = json.loads((ROOT / "merchants.example.json").read_text())
PROTOCOL = ROOT.parent.parent / "server" / "publishing" / "protocol.mjs"


def node_validate(document: dict) -> dict:
    """Run the platform's own validator; returns {"ok": True} or {"ok": False, "code", "path", "message"}."""
    if not shutil.which("node"):
        raise unittest.SkipTest("node not available")
    script = ("import { validatePublication } from %s; let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{"
              "try{validatePublication(JSON.parse(s));console.log(JSON.stringify({ok:true}))}"
              "catch(e){console.log(JSON.stringify({ok:false,code:e.code,path:e.path,message:e.message}))}});" % json.dumps(str(PROTOCOL)))
    run = subprocess.run(["node", "--input-type=module", "-e", script], input=json.dumps(document), capture_output=True, text=True, check=True)
    return json.loads(run.stdout.strip().splitlines()[-1])


class GeocodingAndSearch(unittest.TestCase):
    def test_parse_area_prefers_city_over_county(self):
        area = osm.parse_area(NOMINATIM)
        self.assertEqual(area.short_name, "Santa Clara")
        self.assertEqual(area.osm_type, "relation")
        self.assertLess(area.south, area.north)
        self.assertTrue(area.url.startswith("https://www.openstreetmap.org/relation/"))

    def test_overpass_query_single_and_multi_value(self):
        area = osm.parse_area(NOMINATIM)
        self.assertIn('nwr["amenity"="cafe"]["name"]', osm.overpass_query("cafe", area))
        self.assertIn('["shop"~"^(supermarket|greengrocer|convenience)$"]', osm.overpass_query("grocery", area))
        self.assertIn(area.bbox, osm.overpass_query("cafe", area))

    def test_parse_and_select_venues(self):
        venues, ts = osm.parse_venues(OVERPASS)
        self.assertEqual(len(venues), 80)
        self.assertTrue(ts.startswith("2026-"))
        chosen = osm.select_venues(venues, 12)
        self.assertEqual(len(chosen), 12)
        # complete records first: every chosen place has hours and a website if enough exist
        self.assertTrue(all(v.hours and v.website for v in chosen))
        self.assertEqual(len({(v.name.lower(), v.street.lower()) for v in chosen}), 12)
        self.assertTrue(all(v.url.startswith("https://www.openstreetmap.org/") for v in chosen))

    def test_search_places_falls_back_to_next_endpoint(self):
        calls = []

        def fake_fetch_json(url, params=None, **kw):
            calls.append(url)
            if len(calls) == 1:
                raise osm.SourceError("HTTP_504")
            return OVERPASS
        original = osm.fetch_json
        osm.fetch_json = fake_fetch_json
        try:
            venues, _ = osm.search_places(osm.parse_area(NOMINATIM), "cafe", endpoints=("https://a/x", "https://b/x"), sleep=lambda s: None)
        finally:
            osm.fetch_json = original
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(venues), 80)
        with self.assertRaises(osm.SourceError):
            osm.search_places(osm.parse_area(NOMINATIM), "spaceport")


class Composition(unittest.TestCase):
    def setUp(self):
        self.area = osm.parse_area(NOMINATIM)
        self.venues, self.ts = osm.parse_venues(OVERPASS)
        self.selected = osm.select_venues(self.venues, 12)

    def test_discovery_document_is_valid_protocol(self):
        doc = compose.compose_discovery(self.area, "cafe", self.selected, retrieved_at="2026-10-12T20:00:00Z", osm_timestamp=self.ts, total_found=len(self.venues))
        self.assertEqual(doc["contentId"], "local-cafe-santa-clara")
        self.assertEqual(doc["origin"]["kind"], "web")
        self.assertEqual(len(doc["evidence"]), 13)
        self.assertEqual(len(doc["blocks"][1]["rows"]), 12)
        self.assertEqual(doc["blocks"][2]["points"][0]["value"], 80)
        self.assertLess(len(json.dumps(doc)), 32768)
        self.assertLess(len(json.dumps(doc["extensions"])), 4096)
        self.assertEqual(node_validate(doc), {"ok": True})

    def test_editorial_is_grounded(self):
        editorial = {"title": "Cafés mapped in Santa Clara", "summary": "s", "how_to_read": "h",
                     "picks": [{"name": self.selected[0].name, "reason": "hours tagged"}, {"name": "Made Up Café", "reason": "invented"},
                               {"name": self.selected[1].name.upper(), "reason": ""}]}
        doc = compose.compose_discovery(self.area, "cafe", self.selected, retrieved_at="2026-10-12T20:00:00Z", editorial=editorial, model="m")
        picks = next(b for b in doc["blocks"] if b["id"] == "picks")
        self.assertIn(self.selected[0].name, picks["text"])
        self.assertNotIn("Made Up", picks["text"])
        self.assertEqual(picks["evidenceIds"], [self.selected[0].evidence_id])
        self.assertEqual(doc["extensions"]["newsroom.local-discovery"]["model"], "m")
        self.assertEqual(node_validate(doc), {"ok": True})

    def test_merchant_document(self):
        doc = compose.compose_merchant(MERCHANTS[0], retrieved_at="2026-10-12")
        self.assertEqual(doc["origin"]["kind"], "official")
        self.assertTrue(doc["title"].startswith("[Example]"))
        self.assertEqual(doc["contentId"], "merchant-example-corner-bakery")
        self.assertEqual(node_validate(doc), {"ok": True})
        with self.assertRaises(ValueError):
            compose.compose_merchant({**MERCHANTS[0], "website": "http://insecure.example"}, retrieved_at="2026-10-12")

    def test_fingerprint_ignores_run_metadata(self):
        a = compose.compose_discovery(self.area, "cafe", self.selected, retrieved_at="2026-10-12T20:00:00Z", osm_timestamp="2026-10-12T01:00:00Z")
        b = compose.compose_discovery(self.area, "cafe", self.selected, retrieved_at="2026-11-30T09:00:00Z", osm_timestamp="2026-11-30T01:00:00Z")
        self.assertEqual(memory.fingerprint(a), memory.fingerprint(b))
        self.assertNotEqual(memory.fingerprint(a), memory.fingerprint({**a, "summary": "changed"}))
        self.assertNotIn("2026-10-12", a["blocks"][0]["text"])

    def test_cap_at_twenty_places(self):
        doc = compose.compose_discovery(self.area, "cafe", osm.select_venues(self.venues, 80), retrieved_at="2026-10-12T20:00:00Z")
        self.assertEqual(len(doc["blocks"][1]["rows"]), 20)
        self.assertEqual(len(doc["evidence"]), 21)
        self.assertEqual(node_validate(doc), {"ok": True})


class MemoryAndPublishing(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="local-discovery-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_revisions_follow_content_changes(self):
        mem = memory.Memory(self.dir, "https://example.test")
        self.assertEqual(mem.plan_revision("x", "a"), (1, False))
        mem.record("x", 1, "a", "pub-1", {"area": "A"})
        self.assertEqual(mem.plan_revision("x", "a"), (1, True))
        self.assertEqual(mem.plan_revision("x", "b"), (2, False))
        self.assertEqual(mem.brief("x")["publicationId"], "pub-1")
        with self.assertRaises(RuntimeError):
            memory.Memory(self.dir, "https://other.test")
        mem.save_credentials("agent", "t" * 43)
        self.assertEqual(oct(os.stat(mem.credential_file).st_mode)[-3:], "600")
        with self.assertRaises(RuntimeError):
            mem.save_credentials("agent", "again")
        mem.close()

    def test_scout_publishes_with_idempotent_revision(self):
        class FakeNewsroom:
            origin, token = "https://example.test", None
            def __init__(self): self.calls = []
            def register(self, name): self.calls.append(("register", name)); return {"agentId": "a1", "token": "t" * 43}
            def validate(self, doc): self.calls.append(("validate", doc["revision"])); return {"valid": True}
            def publish(self, doc):
                self.calls.append(("publish", doc["revision"]))
                return {"publicationId": "p1", "revision": doc["revision"], "replayed": False, "url": f"https://example.test/p/p1"}
        news = FakeNewsroom()
        mem = memory.Memory(self.dir, news.origin)
        scout = LocalScout(mem, news)
        self.assertEqual(scout.ensure_identity()["registered"], True)
        self.assertEqual(scout.ensure_identity()["registered"], False)
        fixture = {"area": osm.parse_area(NOMINATIM), "overpass": OVERPASS}
        doc, report = scout.discover("Santa Clara", "cafe", 10, fixture=fixture)
        self.assertEqual(report["shown"], 10)
        first = scout.publish(doc, report)
        again = scout.publish(doc, report)
        self.assertEqual((first["revision"], again["revision"], again["localReplay"]), (1, 1, True))
        changed = {**doc, "summary": doc["summary"] + " Updated."}
        third = scout.publish(changed, report)
        self.assertEqual(third["revision"], 2)
        self.assertEqual([c for c in news.calls if c[0] == "publish"], [("publish", 1), ("publish", 1), ("publish", 2)])
        self.assertEqual(mem.remember_venues(osm.select_venues(osm.parse_venues(OVERPASS)[0], 5), doc["contentId"]), {"new": 5, "total": 5})
        mem.close()


if __name__ == "__main__":
    unittest.main()
