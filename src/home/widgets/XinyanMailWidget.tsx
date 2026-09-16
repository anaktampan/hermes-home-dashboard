import { useEffect, useState } from "react";
import { fetchJSON } from "../../sdk";
import { HoverArrows } from "./HoverArrows";

interface XinyanEntry {
  message_id: string;
  dispatched_epoch: number;
  age_s: number;
}

interface XinyanResp {
  ok: boolean;
  watchlist: string[];
  watchlist_count: number;
  dispatched_active: number;
  dispatched_total: number;
  ttl_hours: number;
  entries: XinyanEntry[];
}

const POLL_MS = 60_000;
const VIEWS = ["entries", "watchlist", "off"] as const;
type View = (typeof VIEWS)[number];

function fmtAge(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** Xinyan email auto-reply state: what the cron job dispatched recently
 *  (message-ids within the 6h dedup TTL) and the active watch patterns.
 *  Read-only view over the state file — never triggers IMAP or a reply. */
export function XinyanMailWidget() {
  const [resp, setResp] = useState<XinyanResp | null>(null);
  const [view, setView] = useState<View>("entries");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetchJSON<XinyanResp>(
          "/api/plugins/home-dashboard/xinyan-mail",
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

  const ttl_s = (resp?.ttl_hours ?? 6) * 3600;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="wd-title" style={{ fontWeight: 700 }}>Xinyan Mail</span>
        <span style={{ fontSize: 10, opacity: 0.65 }}>
          {resp ? `${resp.dispatched_active} active / ${resp.dispatched_total} tot` : err ? err.slice(0, 40) : "…"}
        </span>
      </div>
      {resp && view === "entries" && (
        resp.entries.length === 0 ? (
          <div className="wd-empty" style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>
            No dispatched mail in TTL window — inbox quiet.
          </div>
        ) : (
          <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, overflowY: "auto", flex: 1, minHeight: 0, fontSize: 11 }}>
            {resp.entries.slice(0, 5).map((e) => {
              const remaining = ttl_s - e.age_s;
              const hot = remaining > 0;
              return (
                <li key={e.message_id} style={{ display: "flex", gap: 6, padding: "3px 0", alignItems: "baseline" }}>
                  <span style={{ fontSize: 9, flex: "0 0 auto", color: hot ? "#e5484d" : "#8b8fa3" }}>✉</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.message_id}>
                    {e.message_id.replace(/[<>]/g, "").slice(0, 30)}
                  </span>
                  <span style={{ fontSize: 9, opacity: 0.6, flex: "0 0 auto" }}>
                    {hot ? `dedup ${fmtAge(Math.max(0, remaining))} left` : `sent ${fmtAge(e.age_s)} ago`}
                  </span>
                </li>
              );
            })}
          </ul>
        )
      )}
      {resp && view === "watchlist" && (
        <div style={{ marginTop: 6, fontSize: 11, opacity: 0.85 }}>
          <div style={{ opacity: 0.7, marginBottom: 4 }}>
            Senders matching any pattern get an auto-reply (cron 30m, TTL {resp.ttl_hours}h):
          </div>
          {resp.watchlist.length ? resp.watchlist.map((w) => (
            <div key={w} style={{ fontFamily: "var(--font-mono, monospace)" }}>· {w}</div>
          )) : <div style={{ opacity: 0.7 }}>default: xinyan</div>}
        </div>
      )}
      <HoverArrows
        label={view}
        onPrev={() => setView(VIEWS[(VIEWS.indexOf(view) + VIEWS.length - 1) % VIEWS.length])}
        onNext={() => setView(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length])}
      />
    </div>
  );
}
