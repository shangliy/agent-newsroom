"""The agent: goal → tools → memory → constraints → publication.

Two layers, so the pipeline is useful with or without a model:

* Deterministic pipeline (always available): geocode the area, query Overpass,
  select places under the brief's constraints, compose a protocol document,
  validate it against the newsroom, publish with memory-driven revisions.
* AdalFlow layer (needs a model key): an `Agent`/`Runner` planner that turns a
  natural-language goal into a structured brief using the same geocode/search
  tools, and a `Generator` editor that writes a grounded title, summary,
  reading guide and picks from the mapped data only. Model output is parsed
  into a DataClass and every pick is checked against the real venue list.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

from . import AGENT_NAME
from .compose import MAX_PLACES, compose_discovery, compose_merchant
from .memory import Memory, fingerprint
from .osm import CATEGORIES, Area, SourceError, geocode, parse_venues, search_places, select_venues
from .publisher import Newsroom, NewsroomError

DEFAULT_MODEL = "claude-opus-5-5"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# AdalFlow: editor (Generator + DataClass) and planner (Agent + Runner)
# ---------------------------------------------------------------------------
def _adalflow():
    import adalflow  # noqa: F401  (imported lazily so the deterministic path needs no model deps)
    from adalflow.components.agent import Agent, Runner
    from adalflow.components.model_client.anthropic_client import AnthropicAPIClient
    from adalflow.components.output_parsers import DataClassParser
    from adalflow.core.base_data_class import DataClass
    from adalflow.core.func_tool import FunctionTool
    from adalflow.core.generator import Generator
    return Agent, Runner, AnthropicAPIClient, DataClassParser, DataClass, FunctionTool, Generator


def build_editor(model: str = DEFAULT_MODEL):
    """Generator that writes grounded editorial fields as a DataClass."""
    _, _, AnthropicAPIClient, DataClassParser, DataClass, _, Generator = _adalflow()

    @dataclass
    class Editorial(DataClass):
        title: str = field(default="", metadata={"desc": "Plain, specific title under 90 characters. No superlatives, no 'best'."})
        summary: str = field(default="", metadata={"desc": "Two sentences, under 400 characters, saying what the list is and is not."})
        how_to_read: str = field(default="", metadata={"desc": "Three to five sentences of practical advice on using a map-derived list."})
        picks: list = field(default_factory=list, metadata={"desc": "Up to 5 objects {name, reason}; name must match a listed place exactly; "
                                                                      "reason must cite only the tags shown (hours, cuisine, website, street)."})
        __output_fields__ = ["title", "summary", "how_to_read", "picks"]

    parser = DataClassParser(data_class=Editorial, return_data_class=True, format_type="json")
    task = ("You are LocalScout, an agent that publishes local discovery notes from OpenStreetMap data. You only know what the tags say. "
            "Never invent ratings, popularity, quality, prices or experiences. Say 'as tagged' when citing hours. Write in plain English.")
    editor = Generator(model_client=AnthropicAPIClient(), model_kwargs={"model": model, "max_tokens": 2048},
                       prompt_kwargs={"task_desc_str": task, "output_format_str": parser.get_output_format_str()},
                       output_processors=parser, use_cache=False)
    editor._newsroom_data_class = Editorial  # for tests
    return editor


def write_editorial(editor, area: Area, category: str, venues: list) -> dict | None:
    label = CATEGORIES[category][0]
    listing = "\n".join(f"- {v.name} | street: {v.street or 'n/a'} | hours: {v.hours or 'n/a'} | website: {v.website or 'n/a'} | cuisine: {v.cuisine or 'n/a'}"
                        for v in venues[:MAX_PLACES])
    prompt = f"Area: {area.name}\nCategory: {label}\nPlaces as mapped:\n{listing}\n\nWrite the editorial fields."
    output = editor(prompt_kwargs={"input_str": prompt})
    if output.error or output.data is None:
        return None
    data = output.data.to_dict() if hasattr(output.data, "to_dict") else dict(output.data)
    return {k: data.get(k) for k in ("title", "summary", "how_to_read", "picks")}


def build_planner(model: str = DEFAULT_MODEL):
    """AdalFlow Agent that turns a natural-language goal into a structured brief with the map tools."""
    Agent, Runner, AnthropicAPIClient, _, _, FunctionTool, _ = _adalflow()

    def geocode_area(query: str) -> str:
        """Find the mapped boundary for a place name. Returns display name, bounding box and OSM id, or an error."""
        try:
            a = geocode(query)
            return json.dumps({"name": a.name, "short_name": a.short_name, "bbox": a.bbox, "osm": f"{a.osm_type}/{a.osm_id}"})
        except SourceError as e:
            return json.dumps({"error": e.code})

    def count_places(area_query: str, category: str) -> str:
        """Count named places of a category inside an area. category must be one of the supported keys."""
        if category not in CATEGORIES:
            return json.dumps({"error": "UNKNOWN_CATEGORY", "supported": sorted(CATEGORIES)})
        try:
            venues, _ = search_places(geocode(area_query), category, limit=200)
            return json.dumps({"found": len(venues), "with_hours": sum(1 for v in venues if v.hours), "with_website": sum(1 for v in venues if v.website)})
        except SourceError as e:
            return json.dumps({"error": e.code})

    role = (f"You are {AGENT_NAME}, a local discovery planner. Turn the user's goal into one brief for a map-based note. "
            f"Supported categories: {', '.join(sorted(CATEGORIES))}. Use geocode_area to confirm the area exists and count_places to check "
            "there is enough data (prefer categories with at least 5 places). Finish with exactly one JSON object: "
            '{"area": "<place name as the user would say it>", "category": "<key>", "limit": <5-20>, "why": "<one sentence>"}.')
    agent = Agent(name=AGENT_NAME, tools=[FunctionTool(geocode_area), FunctionTool(count_places)], role_desc=role,
                  model_client=AnthropicAPIClient(), model_kwargs={"model": model, "max_tokens": 2048}, max_steps=6, answer_data_type=str)
    return Runner(agent=agent)


def plan_brief(runner, goal: str) -> dict:
    result = runner.call(prompt_kwargs={"input_str": goal})
    if result.error:
        raise RuntimeError(f"planner failed: {result.error}")
    match = re.search(r"\{.*\}", str(result.answer), re.S)
    if not match:
        raise RuntimeError("planner did not return a JSON brief")
    brief = json.loads(match.group(0))
    if brief.get("category") not in CATEGORIES or not brief.get("area"):
        raise RuntimeError(f"planner returned an unusable brief: {brief}")
    brief["limit"] = max(5, min(int(brief.get("limit") or 12), MAX_PLACES))
    return brief


# ---------------------------------------------------------------------------
# Deterministic pipeline
# ---------------------------------------------------------------------------
class LocalScout:
    def __init__(self, memory: Memory, newsroom: Newsroom | None = None, editor=None, model: str | None = None, log=print):
        self.memory, self.newsroom, self.editor, self.model, self.log = memory, newsroom, editor, model, log

    def ensure_identity(self) -> dict:
        creds = self.memory.credentials()
        if creds:
            self.newsroom.token = creds["token"]
            return {"agentId": creds["agentId"], "registered": False}
        issued = self.newsroom.register(AGENT_NAME)
        self.memory.save_credentials(issued["agentId"], issued["token"])
        self.newsroom.token = issued["token"]
        return {"agentId": issued["agentId"], "registered": True}

    def discover(self, area_query: str, category: str, limit: int = 12, fixture: dict | None = None) -> tuple[dict, dict]:
        """Build (document, report) for one brief. `fixture` = {"area": Area, "overpass": payload} avoids network."""
        retrieved = now_iso()
        if fixture:
            area = fixture["area"]
            venues, osm_ts = parse_venues(fixture["overpass"])
        else:
            area = geocode(area_query)
            venues, osm_ts = search_places(area, category, limit=200)
        selected = select_venues(venues, min(limit, MAX_PLACES))
        editorial = None
        if self.editor is not None and selected:
            try:
                editorial = write_editorial(self.editor, area, category, selected)
            except Exception as e:  # model problems must not block a factual note
                self.log(json.dumps({"editor": "failed", "error": e.__class__.__name__}))
        document = compose_discovery(area, category, selected, retrieved_at=retrieved, osm_timestamp=osm_ts, editorial=editorial,
                                     model=self.model if editorial else None, total_found=len(venues))
        report = {"area": area.name, "category": category, "found": len(venues), "shown": len(selected), "editorial": bool(editorial)}
        return document, report

    def publish(self, document: dict, brief: dict) -> dict:
        """Memory decides the revision; identical content replays the same revision (server is idempotent)."""
        fp = fingerprint(document)
        revision, replay = self.memory.plan_revision(document["contentId"], fp)
        if replay:  # same places and text as the published revision: nothing material changed, do not republish
            known = self.memory.brief(document["contentId"]) or {}
            return {"publicationId": known.get("publicationId"), "revision": revision, "unchanged": True,
                    "url": f"{self.newsroom.origin}/p/{known.get('publicationId')}" if known.get("publicationId") else None}
        document = {**document, "revision": revision}
        self.newsroom.validate(document)
        result = self.newsroom.publish(document)
        self.memory.record(document["contentId"], revision, fp, result.get("publicationId"), brief)
        return {"publicationId": result.get("publicationId"), "revision": result.get("revision"), "replayed": result.get("replayed"),
                "unchanged": False, "url": result.get("url")}

    def merchant(self, entry: dict) -> dict:
        return compose_merchant(entry, retrieved_at=now_iso())
