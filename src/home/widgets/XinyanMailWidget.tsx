import { useEffect, useState } from "react";
import { fetchJSON } from "../../sdk";
import { HoverArrows } from "./HoverArrows";

interface XinyanHistoryItem {
  run: string | null;
  message_id: string;
  from_name: string;
  from_email: string;
  subject: string;
  reply_summary: string;
}

interface XinyanPending {
  message_id: string;
  remaining_s: number;
}

interface XinyanResp {
  ok: boolean;
  watchlist: string[];
  watchlist_count: number;
  active_count: number;
  pending: XinyanPending[];
  history: XinyanHistoryItem[];
  history_total: number;
  ttl_hours: number;
}

const VIEWS = ["history", "watchlist"] as const;
type View = (typeof VIEWS)[number];

function ago(iso: string | null): string {
  if (!iso) return "?";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function fmtRemaining(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** Xinyan auto-reply: persistent reply history (from cron run reports, since
 *  the job was created) + live dedup window + watchlist. Read-only view —
 *  never touches IMAP, never triggers a reply. Manual refresh only (↻ button);
 *  the underlying cron runs every 30m anyway, so polling adds nothing. */
export function XinyanMailWidget() {
  const [view, setView] = useState<View>("history");
  const [resp, setResp] = useState<XinyanResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBusy(true);
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
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="wd-title" style={{ fontWeight: 700 }}>Xinyan Mail</span>
        <span style={{ fontSize: 10, opacity: 0.65, flex: 1, minWidth: 0 }}>
          {resp
            ? `${resp.history_total} balasan · ${resp.active_count} dedup`
            : err
              ? err.slice(0, 40)
              : "…"}
        </span>
        <button
          onClick={() => setNonce((n) => n + 1)}
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
      {!resp ? (
        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>
          {err ? "route error" : "loading…"}
        </div>
      ) : view === "history" ? (
        <>
          {resp.pending.length > 0 && (
            <div style={{ fontSize: 10, color: "#e5c94c", marginTop: 4 }}>
              ⏳ {resp.pending.length} balasan in-flight (dedup {fmtRemaining(resp.pending[0].remaining_s)})
            </div>
          )}
          {resp.history.length === 0 ? (
            <div className="wd-empty" style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>
              Belum ada email xinyan yang dibalas sejak cron dibuat.
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, overflowY: "auto", flex: 1, minHeight: 0, fontSize: 11 }}>
              {resp.history.map((h) => (
                <li key={h.message_id || `${h.run}-${h.subject}`} style={{ padding: "3px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                    <span style={{ fontSize: 9, flex: "0 0 auto", color: "#4cc38a" }}>✉</span>
                    <span
                      style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}
                      title={h.subject}
                    >
                      {h.subject}
                    </span>
                    <span style={{ fontSize: 9, opacity: 0.6, flex: "0 0 auto" }}>{ago(h.run)}</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, paddingLeft: 15 }}>
                    <span
                      style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.7 }}
                      title={h.reply_summary}
                    >
                      {h.reply_summary || "(no summary)"}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
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
