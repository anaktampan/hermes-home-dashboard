import { useEffect, useState } from "react";
import { fetchJSON } from "../../sdk";
import { HoverArrows } from "./HoverArrows";

interface GhReview {
  repo: string;
  title: string;
  state: string;
  updated: string;
  number: number;
  author: string;
  url: string;
}

interface GhReviewsResp {
  ok: boolean;
  cached?: boolean;
  stale?: boolean;
  age_s?: number;
  error?: string;
  reviews: GhReview[];
}

const FILTERS = ["all", "open", "closed"] as const;
type Filter = (typeof FILTERS)[number];

/** Manual-refresh only: no interval polling. Data loads once on mount; the
 *  ↻ button re-fetches. Backend cache (5 min) still applies server-side. */
function useManualLoad<T>(url: string) {
  const [resp, setResp] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBusy(true);
      try {
        const r = await fetchJSON<T>(url);
        if (!cancelled) {
          setResp(r);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr(String(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, nonce]);
  return {
    resp, err, busy,
    refresh: () => setNonce((n) => n + 1),
  };
}

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function shortRepo(repo: string): string {
  // "YoCoApp/yoco-platform" -> "yoco-platform"
  const idx = repo.lastIndexOf("/");
  return idx >= 0 ? repo.slice(idx + 1) : repo;
}

/** Recent PR reviews by aziz-yoco across org repos. Manual refresh only —
 *  review data is slow-moving and the backend caches gh search 5 min, so
 *  auto-polling adds nothing; the ↻ button fetches on demand. */
export function GhReviewsWidget() {
  const [filter, setFilter] = useState<Filter>("all");
  const { resp, err, busy, refresh } = useManualLoad<GhReviewsResp>(
    "/api/plugins/home-dashboard/gh-reviews",
  );

  const reviews = (resp?.reviews ?? [])
    .filter((r) => (filter === "all" ? true : r.state === filter))
    .slice()
    .sort((a, b) => {
      // open first, then newest update within each group
      if (a.state !== b.state) return a.state === "open" ? -1 : 1;
      return Date.parse(b.updated) - Date.parse(a.updated);
    });

  return (
    <div className="wd-ghreviews" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="wd-title" style={{ fontWeight: 700 }}>Reviews</span>
        <span style={{ fontSize: 10, opacity: 0.65, flex: 1, minWidth: 0 }}>
          {resp?.stale ? "stale" : resp?.cached ? `cache ${resp.age_s ?? "?"}s` : "live"}
          {err ? ` · ${err.slice(0, 40)}` : ""}
        </span>
        <button
          onClick={refresh}
          disabled={busy}
          title="Refresh"
          style={{
            flex: "0 0 auto", border: "none", background: "transparent", cursor: "pointer",
            padding: "0 2px", fontSize: 11, lineHeight: "14px", opacity: busy ? 0.4 : 0.7,
            color: "inherit", fontFamily: "inherit",
          }}
        >
          {busy ? "…" : "↻"}
        </button>
      </div>
      {resp && !resp.ok && !resp.reviews.length ? (
        <div className="wd-empty" style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>
          gh search failed — {(resp.error ?? "").slice(0, 80)}
        </div>
      ) : reviews.length === 0 ? (
        <div className="wd-empty" style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>
          No reviews yet.
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, overflowY: "auto", flex: 1, minHeight: 0, fontSize: 11 }}>
          {reviews.slice(0, 8).map((r) => {
            const open = r.state === "open";
            return (
            <li key={r.url} style={{ display: "flex", gap: 6, padding: "3px 0", alignItems: "baseline" }}>
              <span
                title={r.state}
                style={{
                  fontSize: 9, lineHeight: "14px", flex: "0 0 auto",
                  color: open ? "#4cc38a" : "#8b8fa3",
                }}
              >
                {open ? "◉" : "○"}
            </span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${r.repo}#${r.number} — ${r.title} (by ${r.author})`}>
                {shortRepo(r.repo)}#{r.number}
                <span style={{ opacity: 0.75 }}> · {r.author}</span>
              </span>
              <span style={{ fontSize: 9, opacity: 0.6, flex: "0 0 auto" }}>{ago(r.updated)}</span>
            </li>
            );
          })}
        </ul>
      )}
      <HoverArrows
        label={filter}
        onPrev={() => setFilter(FILTERS[(FILTERS.indexOf(filter) + FILTERS.length - 1) % FILTERS.length])}
        onNext={() => setFilter(FILTERS[(FILTERS.indexOf(filter) + 1) % FILTERS.length])}
      />
    </div>
  );
}
