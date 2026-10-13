"""Persistent agent memory: credentials, published briefs with revisions, seen venues.

SQLite in AGENT_STATE_DIR (default data/local-discovery/), mode 0600. The state
directory is bound to one newsroom origin, like the Node producers' state.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path


VOLATILE = ("revision", "extensions")  # extensions carry run metadata such as the OSM data timestamp


def fingerprint(document: dict) -> str:
    """Hash of the material content only: id, title, origin, listed places and picks.

    Counts and timestamps vary between Overpass mirrors with different data freshness, so they do not
    count as a change; a new revision is published only when the places or the editorial text differ.
    """
    blocks = {b["id"]: b for b in document.get("blocks", [])}
    body = {"contentId": document.get("contentId"), "title": document.get("title"), "origin": document.get("origin"),
            "rows": blocks.get("places", {}).get("rows"), "picks": blocks.get("picks", {}).get("text"),
            "reading": blocks.get("reading", {}).get("text"), "about": blocks.get("about", {}).get("text"),
            "hours": blocks.get("hours", {}).get("rows")}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


class Memory:
    def __init__(self, directory: str | os.PathLike, origin: str, now=time.time):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.now = now
        path = self.dir / "local-discovery.sqlite"
        self.db = sqlite3.connect(path)
        os.chmod(path, 0o600)
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS briefs(content_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, fingerprint TEXT NOT NULL,
                publication_id TEXT, brief TEXT NOT NULL, updated INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS venues(key TEXT PRIMARY KEY, name TEXT NOT NULL, content_id TEXT NOT NULL,
                first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
        """)
        bound = self.db.execute("SELECT value FROM settings WHERE key='origin'").fetchone()
        if bound and bound[0] != origin:
            raise RuntimeError(f"state directory is bound to {bound[0]}; use a separate AGENT_STATE_DIR for {origin}")
        self.db.execute("INSERT OR IGNORE INTO settings VALUES('origin', ?)", (origin,))
        self.db.commit()
        self.origin = origin

    # --- credentials -------------------------------------------------------
    @property
    def credential_file(self) -> Path:
        return self.dir / "credentials.json"

    def credentials(self) -> dict | None:
        if not self.credential_file.exists():
            return None
        data = json.loads(self.credential_file.read_text())
        if data.get("origin") != self.origin:
            raise RuntimeError("credential file is bound to another origin")
        return data

    def save_credentials(self, agent_id: str, token: str) -> None:
        if self.credential_file.exists():
            raise RuntimeError("refusing to overwrite an existing identity")
        fd = os.open(self.credential_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({"agentId": agent_id, "token": token, "origin": self.origin}, f)

    # --- briefs / revisions -----------------------------------------------
    def plan_revision(self, content_id: str, document_fingerprint: str) -> tuple[int, bool]:
        """Return (revision, replay). Same content → same revision (idempotent retry); changed → next revision."""
        row = self.db.execute("SELECT revision, fingerprint FROM briefs WHERE content_id=?", (content_id,)).fetchone()
        if not row:
            return 1, False
        revision, stored = row
        return (revision, True) if stored == document_fingerprint else (revision + 1, False)

    def record(self, content_id: str, revision: int, document_fingerprint: str, publication_id: str | None, brief: dict) -> None:
        self.db.execute("INSERT OR REPLACE INTO briefs VALUES(?,?,?,?,?,?)",
                        (content_id, revision, document_fingerprint, publication_id, json.dumps(brief, sort_keys=True), int(self.now())))
        self.db.commit()

    def brief(self, content_id: str) -> dict | None:
        row = self.db.execute("SELECT revision, fingerprint, publication_id, brief, updated FROM briefs WHERE content_id=?", (content_id,)).fetchone()
        if not row:
            return None
        return {"revision": row[0], "fingerprint": row[1], "publicationId": row[2], "brief": json.loads(row[3]), "updated": row[4]}

    def briefs(self) -> list[dict]:
        return [{"contentId": r[0], "revision": r[1], "publicationId": r[2], "updated": r[3]}
                for r in self.db.execute("SELECT content_id, revision, publication_id, updated FROM briefs ORDER BY updated DESC")]

    # --- venues -----------------------------------------------------------
    def remember_venues(self, venues, content_id: str) -> dict:
        now, new = int(self.now()), 0
        for v in venues:
            if self.db.execute("SELECT 1 FROM venues WHERE key=?", (v.key,)).fetchone():
                self.db.execute("UPDATE venues SET last_seen=?, name=? WHERE key=?", (now, v.name, v.key))
            else:
                self.db.execute("INSERT INTO venues VALUES(?,?,?,?,?)", (v.key, v.name, content_id, now, now))
                new += 1
        self.db.commit()
        return {"new": new, "total": len(venues)}

    def close(self) -> None:
        self.db.close()
