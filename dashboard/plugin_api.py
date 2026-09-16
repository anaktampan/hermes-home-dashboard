"""Home dashboard plugin backend.

Mounted at /api/plugins/home-dashboard/ by the Hermes dashboard host.
Persists the widget layout to a JSON file inside the plugin's own directory
so it survives Hermes updates (the plugin lives under ~/.hermes/plugins/,
outside the repo that `git reset --hard` touches).
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Dict

try:
    from hermes_constants import get_hermes_home
except ImportError:  # pragma: no cover - allows standalone unit tests
    import os as _os

    def get_hermes_home() -> Path:  # type: ignore[misc]
        val = (_os.environ.get("HERMES_HOME") or "").strip()
        return Path(val) if val else Path.home() / ".hermes"

try:
    from fastapi import APIRouter, HTTPException
    from pydantic import BaseModel
except Exception:  # pragma: no cover - allows local unit tests
    class APIRouter:  # type: ignore
        def get(self, *_a, **_k):
            return lambda fn: fn

        def put(self, *_a, **_k):
            return lambda fn: fn

    class BaseModel:  # type: ignore
        pass

    class HTTPException(Exception):  # type: ignore
        def __init__(self, status_code: int, detail: str = "") -> None:
            self.status_code = status_code
            self.detail = detail


router = APIRouter()

# ---------------------------------------------------------------------------
# anaktampan custom routes: GitHub review history + Xinyan email replies.
# Both read local state only (no new API tokens): gh CLI (already authed as
# aziz-yoco) and the email-auto-reply cron artifacts on disk.
# ---------------------------------------------------------------------------

import asyncio  # noqa: E402
import subprocess  # noqa: E402
import time as _time  # noqa: E402

_GH_BIN = "/home/aziz/.local/bin/gh"
_GH_REVIEW_CACHE: Dict[str, Any] = {"t": 0.0, "data": None}
_GH_CACHE_TTL = 300.0  # seconds


def _parse_iso8601_utc(s: str) -> float | None:
    """'2026-09-16T09:56:59Z' -> epoch seconds; None on failure."""
    import datetime as _dt

    try:
        return _dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError):
        return None


def _run_gh_review_search() -> list[Dict[str, Any]]:
    """Recent PRs reviewed by aziz-yoco across all repos (search API).

    Uses the same `gh` binary the rest of the host uses; auth comes from the
    existing gh config (aziz-yoco token, no new secrets in .env).
    """
    jq = (
        '.items[] | {repo: (.repository_url | sub(".*repos/"; "")), '
        "title: .title, state: .state, updated: .updated_at, "
        "number: .number, author: .user.login, url: .html_url}"
    )
    cmd = [
        _GH_BIN, "api", "--method", "GET", "search/issues",
        "-f", "q=is:pr reviewed-by:aziz-yoco sort:updated-desc",
        "-f", "per_page=15",
        "--jq", jq,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "gh search failed")[:300])
    items: list[Dict[str, Any]] = []
    for line in (r.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            items.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return items


@router.get("/gh-reviews")
async def get_gh_reviews() -> Dict[str, Any]:
    """Recent PR reviews by aziz-yoco, cached 5 min server-side."""
    now = _time.time()
    if _GH_REVIEW_CACHE["data"] is not None and (now - _GH_REVIEW_CACHE["t"]) < _GH_CACHE_TTL:
        return {
            "ok": True, "cached": True, "age_s": int(now - _GH_REVIEW_CACHE["t"]),
            "reviews": _GH_REVIEW_CACHE["data"],
        }
    try:
        reviews = await asyncio.to_thread(_run_gh_review_search)
    except Exception as e:  # noqa: BLE001 — degrade to stale cache on failure
        if _GH_REVIEW_CACHE["data"] is not None:
            return {
                "ok": True, "cached": True, "stale": True,
                "reviews": _GH_REVIEW_CACHE["data"],
            }
        return {"ok": False, "error": str(e), "reviews": []}
    _GH_REVIEW_CACHE["t"] = now
    _GH_REVIEW_CACHE["data"] = reviews
    return {"ok": True, "cached": False, "reviews": reviews}


# ---------------------------------------------------------------------------
# Xinyan email auto-reply state
# ---------------------------------------------------------------------------

_X_STATE = get_hermes_home() / "scripts" / ".email-xinyan-state.json"
_X_WATCHLIST = get_hermes_home() / "scripts" / "email-xinyan-watchlist.txt"
_X_TTL_H = 6.0  # must mirror email-xinyan-watch.py STATE_TTL_H


def _read_xinyan_state() -> Dict[str, Any]:
    try:
        data = json.loads(_X_STATE.read_text("utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _read_xinyan_watchlist() -> list[str]:
    try:
        lines = (_X_WATCHLIST.read_text("utf-8")).splitlines()
    except Exception:
        return []
    return [
        ln.strip() for ln in lines
        if ln.strip() and not ln.lstrip().startswith("#")
    ]


@router.get("/xinyan-mail")
async def get_xinyan_mail() -> Dict[str, Any]:
    """Snapshot of the email-auto-reply-xinyan cron state.

    Reads the state file written by ~/.hermes/scripts/email-xinyan-watch.py —
    never calls IMAP itself, so the widget poll can never trigger a reply.
    """
    state = _read_xinyan_state()
    dispatched = state.get("dispatched", {})
    entries: list[Dict[str, Any]] = []
    now = _time.time()
    for mid, ts in (dispatched or {}).items():
        ts_f = float(ts) if isinstance(ts, (int, float)) else _parse_iso8601_utc(str(ts))
        if ts_f is None:
            continue
        entries.append({
            "message_id": mid,
            "dispatched_epoch": ts_f,
            "age_s": max(0, int(now - ts_f)),
        })
    entries.sort(key=lambda e: e["age_s"])  # newest first
    ttl_s = _X_TTL_H * 3600
    watchlist = _read_xinyan_watchlist()
    return {
        "ok": True,
        "watchlist": watchlist,
        "watchlist_count": len(watchlist),
        "dispatched_active": len([e for e in entries if e["age_s"] < ttl_s]),
        "dispatched_total": len(entries),
        "ttl_hours": _X_TTL_H,
        "entries": entries[:10],
    }

LAYOUT_FILE = get_hermes_home() / "plugins" / "home-dashboard" / "layout.json"
_MAX_WIDGETS = 64


def _valid_layout(layout: Any) -> bool:
    if not isinstance(layout, dict) or layout.get("version") != 1:
        return False
    widgets = layout.get("widgets")
    if not isinstance(widgets, list) or len(widgets) > _MAX_WIDGETS:
        return False
    for w in widgets:
        if not isinstance(w, dict) or not isinstance(w.get("id"), str):
            return False
        if not all(isinstance(w.get(k), int) for k in ("gx", "gy", "gw", "gh")):
            return False
    return True


@router.get("/layout")
async def get_layout() -> Dict[str, Any]:
    """Return the saved layout, or {"layout": null} for the client default."""
    if LAYOUT_FILE.exists():
        try:
            data = json.loads(LAYOUT_FILE.read_text("utf-8"))
            if _valid_layout(data):
                return {"layout": data}
        except Exception:
            pass
    return {"layout": None}


class LayoutBody(BaseModel):
    layout: dict


@router.put("/layout")
async def set_layout(body: "LayoutBody") -> Dict[str, Any]:
    """Persist the widget layout (positions/sizes/per-widget props)."""
    if not _valid_layout(body.layout):
        raise HTTPException(status_code=400, detail="invalid layout document")
    LAYOUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    LAYOUT_FILE.write_text(json.dumps(body.layout), encoding="utf-8")
    return {"ok": True}


# Hermes Desktop deliberately exposes plugin-scoped REST instead of a generic
# core-API escape hatch.  These read-only routes adapt the same current Hermes
# services the web dashboard uses, keeping the Desktop bundle inside its public
# ``ctx.rest`` boundary while preserving the richer Home widgets.
@router.get("/system")
async def get_desktop_system() -> Dict[str, Any]:
    from hermes_cli.web_server import get_system_stats

    return await get_system_stats()


@router.get("/analytics")
async def get_desktop_analytics(days: int = 30, profile: str | None = None) -> Dict[str, Any]:
    from hermes_cli.web_server import get_usage_analytics

    return await get_usage_analytics(days=max(1, min(366, days)), profile=profile)


@router.get("/cron")
async def get_desktop_cron(profile: str = "all") -> list[Dict[str, Any]]:
    from hermes_cli.web_server import list_cron_jobs

    return await list_cron_jobs(profile=profile or "all")


@router.get("/sessions")
async def get_desktop_sessions(
    limit: int = 20,
    offset: int = 0,
    profile: str | None = None,
) -> Dict[str, Any]:
    from hermes_cli.web_server import get_sessions

    return await asyncio.to_thread(
        get_sessions,
        limit=max(1, min(100, limit)),
        offset=max(0, offset),
        order="recent",
        profile=profile,
    )
