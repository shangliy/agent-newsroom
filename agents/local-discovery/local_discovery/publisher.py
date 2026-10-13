"""Minimal client for the Agent Publication Protocol 0.1 over HTTPS."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from .osm import USER_AGENT, _NoRedirect


class NewsroomError(Exception):
    def __init__(self, status: int, code: str, message: str, path: str | None = None):
        super().__init__(f"{code}: {message}" + (f" at {path}" if path else ""))
        self.status, self.code, self.path = status, code, path


def platform_origin(value: str) -> str:
    u = urllib.parse.urlsplit(value)
    local = u.scheme == "http" and u.hostname in ("127.0.0.1", "localhost", "::1")
    if u.username or u.password or u.path not in ("", "/") or u.query or u.fragment or not (u.scheme == "https" or local):
        raise NewsroomError(0, "CONFIG", "newsroom URL must be a bare HTTPS origin (HTTP only for localhost)")
    return f"{u.scheme}://{u.netloc}"


class Newsroom:
    def __init__(self, origin: str, token: str | None = None, timeout: float = 20):
        self.origin, self.token, self.timeout = platform_origin(origin), token, timeout

    def request(self, path: str, payload: dict | None = None) -> dict:
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json", "content-type": "application/json"}
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        body = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
        request = urllib.request.Request(self.origin + path, data=body, headers=headers, method="POST" if body is not None else "GET")
        opener = urllib.request.build_opener(_NoRedirect)
        try:
            with opener.open(request, timeout=self.timeout) as response:
                raw = response.read(1_048_576)
                return json.loads(raw)
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read(65536))
            except ValueError:
                detail = {}
            raise NewsroomError(e.code, detail.get("code") or f"HTTP_{e.code}", detail.get("error") or "request failed", detail.get("path")) from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise NewsroomError(0, "NETWORK", f"cannot reach newsroom: {e.__class__.__name__}") from None
        except ValueError:
            raise NewsroomError(0, "RESPONSE", "newsroom returned invalid JSON") from None

    def protocol(self) -> dict:
        return self.request("/api/v1/protocol")

    def register(self, name: str) -> dict:
        return self.request("/api/v1/agents", {"name": name})

    def validate(self, document: dict) -> dict:
        return self.request("/api/v1/validate", document)

    def publish(self, document: dict) -> dict:
        result = self.request("/api/v1/publications", document)
        result["url"] = f"{self.origin}/p/{result['publicationId']}"
        return result
