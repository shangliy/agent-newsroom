"""Command line for the local discovery agent.

  python3 -m local_discovery --area "Santa Clara, California" --category cafe --limit 12
  python3 -m local_discovery --area ... --category ... --publish        # register once, then publish/revise
  python3 -m local_discovery --fixture                                   # offline preview from bundled fixtures
  python3 -m local_discovery --goal "independent coffee near Santa Clara University"   # AdalFlow planner (needs model key)
  python3 -m local_discovery --merchants merchants.json [--publish]     # merchant-authorized notes
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import AGENT_NAME, __version__
from .agent import DEFAULT_MODEL, LocalScout, build_editor, build_planner, plan_brief
from .memory import Memory
from .osm import CATEGORIES, SourceError, parse_area
from .publisher import Newsroom, NewsroomError

HERE = Path(__file__).resolve().parent.parent


def load_fixture() -> dict:
    nominatim = json.loads((HERE / "fixtures" / "nominatim-santa-clara.json").read_text())
    overpass = json.loads((HERE / "fixtures" / "overpass-santa-clara-cafe.json").read_text())
    return {"area": parse_area(nominatim), "overpass": overpass}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="local_discovery", description=f"{AGENT_NAME} {__version__}: local discovery publisher for Agent Newsroom")
    p.add_argument("--area", help="place name, e.g. 'Santa Clara, California'")
    p.add_argument("--category", choices=sorted(CATEGORIES), help="what to look for")
    p.add_argument("--limit", type=int, default=12, help="places to show (5-20)")
    p.add_argument("--goal", help="natural-language goal; the AdalFlow planner turns it into area + category (needs a model)")
    p.add_argument("--merchants", help="JSON file of merchant-authorized entries to publish as official notes")
    p.add_argument("--fixture", action="store_true", help="offline: use bundled Santa Clara café fixture, never publish")
    p.add_argument("--publish", action="store_true", help="publish to the newsroom (registers the agent identity on first run)")
    p.add_argument("--newsroom-url", default=os.environ.get("NEWSROOM_URL", "https://agent-newsroom-pi.vercel.app"))
    p.add_argument("--state-dir", default=os.environ.get("AGENT_STATE_DIR", str(HERE.parent.parent / "data" / "local-discovery")))
    p.add_argument("--out", default=str(HERE.parent.parent / "outputs" / "local-discovery"), help="where preview JSON is written")
    p.add_argument("--model", default=None, help=f"model for the AdalFlow editor/planner (default {DEFAULT_MODEL} when ANTHROPIC_API_KEY is set)")
    p.add_argument("--no-model", action="store_true", help="deterministic text only, even if a key is present")
    args = p.parse_args(argv)

    if args.fixture and args.publish:
        p.error("--fixture previews cannot be published")
    use_model = not args.no_model and (args.model or os.environ.get("ANTHROPIC_API_KEY"))
    model = (args.model or DEFAULT_MODEL) if use_model else None

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    newsroom = Newsroom(args.newsroom_url) if not args.fixture else None
    # Fixture runs never share state with a real newsroom: the state directory is bound to one origin.
    state_dir = str(out_dir / "fixture-state") if args.fixture else args.state_dir
    memory = Memory(state_dir, newsroom.origin if newsroom else "fixture")
    editor = build_editor(model) if model else None
    scout = LocalScout(memory, newsroom, editor=editor, model=model)
    exit_code = 0
    try:
        if args.publish:
            identity = scout.ensure_identity()
            print(json.dumps({"identity": identity}))

        documents: list[tuple[dict, dict]] = []
        if args.merchants:
            entries = json.loads(Path(args.merchants).read_text())
            for entry in entries:
                doc = scout.merchant(entry)
                documents.append((doc, {"merchant": entry["id"], "fictional": bool(entry.get("fictional"))}))
        else:
            if args.goal:
                if not model:
                    p.error("--goal needs a model (set ANTHROPIC_API_KEY or --model)")
                brief = plan_brief(build_planner(model), args.goal)
                print(json.dumps({"plannedBrief": brief}))
                args.area, args.category, args.limit = brief["area"], brief["category"], brief["limit"]
            if args.fixture:
                args.area, args.category = args.area or "Santa Clara, California", args.category or "cafe"
            if not args.area or not args.category:
                p.error("--area and --category are required (or --goal / --fixture / --merchants)")
            doc, report = scout.discover(args.area, args.category, max(5, min(args.limit, 20)), fixture=load_fixture() if args.fixture else None)
            documents.append((doc, report))

        for doc, report in documents:
            path = out_dir / f"{doc['contentId']}.json"
            path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
            result = {"contentId": doc["contentId"], "title": doc["title"], "preview": str(path), **report}
            if args.publish:
                if report.get("fictional"):
                    result["skipped"] = "fictional merchant entries are never published"
                else:
                    result["published"] = scout.publish(doc, {"area": args.area, "category": args.category, "limit": args.limit, **report})
            print(json.dumps(result, ensure_ascii=False))
    except (SourceError, NewsroomError) as e:
        print(json.dumps({"error": e.code, "message": str(e)}), file=sys.stderr)
        exit_code = 2
    finally:
        memory.close()
    return exit_code
