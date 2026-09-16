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

const POLL_MS = 120_000;
const FILTERS = ["all", "open", "closed"] as const;
type Filter = (typeof FILTERS)[number];

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

/** Recent PR reviews by aziz-yoco across org repos. Fetches its own
 *  plugin-scoped route (60-120s cadence) instead of the shared 10s loop —
 *  review data is slow-moving and the backend caches gh search 5 min. */
export function GhReviewsWidget() {
  const [resp, setResp] = useState<GhReviewsResp | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetchJSON<GhReviewsResp>(
          "/api/plugins/home-dashboard/gh-reviews",
        );
        if (!cancelled) {
          setResp(r);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr(String(e));
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

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
        <span style={{ fontSize: 10, opacity: 0.65 }}>
          {resp?.stale ? "stale" : resp?.cached ? `cache ${resp.age_s ?? "?"}s` : "live"}
          {err ? ` · ${err.slice(0, 40)}` : ""}
        </span>
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
                {open && (
                  <span style={{ opacity: 0.75 }}> · {r.author}</span>
                )}
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
