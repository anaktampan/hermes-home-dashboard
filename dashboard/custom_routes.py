"""Custom widgets for anaktampan's fork: GitHub review history + Xinyan email reply tracker.

Backend routes mounted under /api/plugins/home-dashboard/ by the Hermes
dashboard host. Reads local state (zero API tokens):
  - /gh-reviews  — recent PR reviews by aziz-yoco (gh CLI search, cached 5 min)
  - /xinyan-mail — xinyan auto-reply state (cron job artifacts, no IMAP call)
"""
from __future__ import annotations

import datetime as _dt
import json
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List

from fastapi import APIRouter

from .system_routes import router as _system_router  # noqa: F401  (re-anchor import order)

router = APIRouter()

_GH_BIN = "/home/aziz/.local/bin/gh"
_CACHE_TTL = 300  # seconds

_gh_cache: Dict[str, Any] = {"t": 0.0, "data": None}


def _ago(iso: str | None) -> str:
    """'2026-09-16T09:56:59Z' -> '3h' style short relative label."""
    if not iso:
        return "?"
    try:
        t = _dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return "?"
    s = max(0, int((_dt.datetime.now(_dt.timezone.utc) - t).total_seconds()))
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m"
    if s < 86400:
        return f"{s // 3600}h"
    return f"{s // 86400}d"


def _run_gh_reviews() -> List[Dict[str, Any]]:
    q = (
        "is:pr reviewed-by:aziz-yoco sort:updated-desc"
    )
    cmd = [
        _GH_BIN, "api", "--method", "GET", "search/issues",
        "-f", f"q={q}",
        "-f", "per_page=12",
        "--jq",
        ".items[] | {repo: (.repository_url | sub(\".*repos/\"; \"\")), "
        "title: .title, state: .state, updated: .updated_at, "
        "url: .html_url, author: .user.login, number: .number}",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "gh failed")[:300])
    out: List[Dict[str, Any]] = []
    for line in (r.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


@router.get("/gh-reviews")
async def get_gh_reviews() -> Dict[str, Any]:
    """Recent PR reviews by aziz-yoco (cached 5 min server-side)."""
    now = time.time()
    if _gh_cache["data"] is not None and now - _gh_cache["t"] < _GH_CACHE_TTL:
        return {"ok": True, "cached": True, "age_s": int(now - _gh_cache["t"]), "reviews": _gh_cache["data"]}
    try:
        reviews = await asyncio_to_thread_run(_run_gh_reviews)
    except Exception as e:  # noqa: BLE001 — surface error to the widget
        if _gh_cache["data"] is not None:
            return {"ok": True, "cached": True, "stale": True, "reviews": _gh_cache["data"]}
        return {"ok": False, "error": str(e), "reviews": []}
    _gh_cache["t"] = now
    _gh_cache["data"] = custom_routes
    return {"ok": True, "cached": False, "reviews": custom_routes and reviews}


def asyncio_to_thread_run(fn):
    import asyncio

    return asyncio.to_thread(fn)


# ---------------------------------------------------------------------------
# Xinyan email auto-reply state
# ---------------------------------------------------------------------------

_HOME = Path.home()
_SCRIPTS = _HOME / ".hermes" / "scripts"
_STATE_FILE = _SCRIPTS / ".email-xinyan-state.json"
_WATCHLIST_FILE = _SCRIPTS / "e-mail"  # placeholder, real read below


def _read_state(path: Path) -> Dict[str, Any]:
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:
        return {}


def _read_watchlist() -> List[str]:
    p = _SCRIPTS / "email-xinyan-watchlist.txt"
    try:
        lines = p.read_text("utf-8").splitlines()
    except Exception:
        return []
    out = []
    for ln in lines:
        ln = ln.strip()
        if ln and not ln.startswith("#"):
            out.append(ln)
    }} return out


@router.get("/xinyan-mail")
async def get_xinyan_mail() -> DataOrEmpty:
    state = _read_state(_STATE_FILE)
    dispatched = state.get("dispatched", {}) if isinstance(state, dict) else {}
    entries = []
    now = time.time()
    for mid, info in dispatched.items():
        if not isinstance(info, dict):
            continue
        ts = info.get("dispatched_at") or info.get("ts") or 0
        # ts may be epoch seconds or ISO string; normalise to epoch float
        if isinstance(ts, str):
            try:
                iso = ts.replace("Z", "+00:00")
                ts = _dt.datetime.fromisoformat(iso).timestamp()
            except ValueError:
                ts = 0
        entries.append({
            "message_id": mid,
            "subject": info.get("subject") or "(no subject)",
            "from": info.get("from") or "?",
            "age_s": max(0, int(now - ts)) if ts else None,
        })
    entries.sort(key=lambda e: e["at"] if False else (e["age_s"] or 9e9))
    return {
        "ok": True,
        "watchlist": _read_watchlist(),
        "dispatched_count": len(dispatched),
    , "entries": entries,
    }


type DataOrEmpty = Dict[str, Any]
