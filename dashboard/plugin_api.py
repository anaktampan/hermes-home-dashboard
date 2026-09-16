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
import re  # noqa: E402
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
# Xinyan email auto-reply state + persistent reply history
# ---------------------------------------------------------------------------

_X_STATE = get_hermes_home() / "scripts" / ".email-xinyan-state.json"
_X_WATCHLIST = get_hermes_home() / "scripts" / "email-xinyan-watchlist.txt"
_X_TTL_H = 6.0  # must mirror email-xinyan-watch.py STATE_TTL_H
_X_JOB_NAME = "email-auto-reply-xinyan"
_x_job_dir_cache: Dict[str, Any] = {"dir": None}


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


def _find_xinyan_job_dir():
    """Locate the cron output dir for the xinyan job by its .md headers."""
    if _x_job_dir_cache["dir"] is not None:
        return _x_job_dir_cache["dir"]
    root = get_hermes_home() / "cron" / "output"
    if not root.is_dir():
        return None
    for d in sorted(root.iterdir()):
        if not d.is_dir():
            continue
        for md in sorted(d.glob("*.md"), reverse=True)[:3]:
            try:
                head = md.read_text("utf-8", errors="replace")[:200]
            except OSError:
                continue
            if _X_JOB_NAME in head:
                _x_job_dir_cache["dir"] = d
                return d
    return None


def _read_xinyan_history(max_runs: int = 40) -> list[Dict[str, Any]]:
    """Replied-email history from cron run reports (persists beyond TTL).

    Each run .md embeds the dispatched batch JSON (message-id, from, subject)
    and the agent's final report with one `✉️ Dibalas:` + `↳ summary` block
    per email. Newest runs first.
    """
    d = _find_xinyan_job_dir()
    if d is None:
        return []
    out: list[Dict[str, Any]] = []
    runs_seen = 0
    for md in sorted(d.glob("*.md"), reverse=True):
        runs_seen += 1
        if runs_seen > max_runs:
            break
        try:
            text = md.read_text("utf-8", errors="replace")
        except OSError:
            continue
        m = re.match(r"(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})\.md$", md.name)
        run_iso = f"{m.group(1)}T{m.group(2)}:{m.group(3)}:{m.group(4)}+00:00" if m else None
        # dispatched batch JSON (single line inside the fenced script output)
        batch_emails: list[Dict[str, Any]] = []
        for line in text.splitlines():
            line = line.strip()
            if line.startswith('{"wakeAgent": true'):
                try:
                    batch = json.loads(line)
                except json.JSONDecodeError:
                    continue
                batch_emails = batch.get("emails") or []
                break
        if not batch_emails:
            continue  # wakeAgent=false run — nothing dispatched
        # reply summaries from the agent's final report, in batch order.
        # ONLY parse after the "## Response" header — the prompt template
        # itself contains literal "✉️ Dibalas:" / "↳" example lines.
        summaries: list[str] = []
        resp_idx = text.find("## Response")
        if resp_idx >= 0:
            lines = text[resp_idx:].splitlines()
            for i, ln in enumerate(lines):
                if ln.strip().startswith("✉️ Dibalas:"):
                    summ = ""
                    for nxt in lines[i + 1:i + 3]:
                        if nxt.strip().startswith("↳"):
                            summ = nxt.strip().lstrip("↳").strip()
                            break
                    summaries.append(summ)
        for idx, em in enumerate(batch_emails[:5]):
            frm = em.get("from") or [{}]
            if isinstance(frm, dict):
                frm = [frm]
            first = frm[0] if frm else {}
            out.append({
                "run": run_iso,
                "message_id": em.get("message_id") or "",
                "from_name": first.get("name") or "",
                "from_email": first.get("email") or "",
                "subject": em.get("subject") or "",
                "reply_summary": summaries[idx] if idx < len(summaries) else "",
            })
    return out


@router.get("/xinyan-mail")
async def get_xinyan_mail() -> Dict[str, Any]:
    """Xinyan auto-reply snapshot: active dedup window + persistent history.

    Never calls IMAP — reads the cron state file and cron run reports.
    """
    state = _read_xinyan_state()
    dispatched = state.get("dispatched", {})
    now = _time.time()
    ttl_s = _X_TTL_H * 3600
    active: list[Dict[str, Any]] = []
    for mid, ts in (dispatched or {}).items():
        ts_f = float(ts) if isinstance(ts, (int, float)) else _parse_iso8601_utc(str(ts))
        if ts_f is None:
            continue
        remaining = int(ttl_s - (now - ts_f))
        if remaining > 0:
            active.append({"message_id": mid, "remaining_s": remaining})
    active.sort(key=lambda e: e["remaining_s"], reverse=True)

    history = _read_xinyan_history()
    hist_ids = {h["message_id"] for h in history if h["message_id"]}
    # dispatched-but-not-yet-in-history => reply in flight
    pending = [a for a in active if a["message_id"] not in hist_ids]

    watchlist = _read_xinyan_watchlist()
    return {
        "ok": True,
        "watchlist": watchlist,
        "watchlist_count": len(watchlist),
        "active_count": len(active),
        "pending": pending,
        "history": history[:5],
        "history_total": len(history),
        "ttl_hours": _X_TTL_H,
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
