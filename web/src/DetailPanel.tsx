import { useEffect, useState } from "react";
import { getEvent, ApiError, NetworkError } from "./api";
import { MinutesPanel } from "./MinutesPanel";
import { TranscriptViewer } from "./TranscriptViewer";
import type { GregorianEvent, Run } from "./types";

/**
 * The event detail drawer: event metadata + per-run summary, each run's generated `minutes`
 * (MinutesPanel) and its Shiki-highlighted transcript (TranscriptViewer, lazy — fetches on expand).
 *
 * Trust boundary: `prompt`, `title`, `cwd`, and run `error` are agent/user-authored and rendered as
 * React text (auto-escaped). The only `dangerouslySetInnerHTML` is inside TranscriptViewer's Shiki
 * code blocks, where Shiki has already escaped the source into span text nodes.
 */

const dtFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dtFmt.format(d);
}

function duration(run: Run): string {
  if (!run.started_at) return "—";
  const start = new Date(run.started_at).getTime();
  const end = run.ended_at ? new Date(run.ended_at).getTime() : Date.now();
  const secs = Math.max(0, Math.round((end - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  return `${m}m ${secs % 60}s${run.ended_at ? "" : " (running)"}`;
}

interface DetailPanelProps {
  eventId: string;
  onClose: () => void;
}

export function DetailPanel({ eventId, onClose }: DetailPanelProps) {
  const [event, setEvent] = useState<GregorianEvent | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getEvent(eventId)
      .then(({ event, runs }) => {
        if (!active) return;
        setEvent(event);
        setRuns(runs ?? []);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError) setError(err.status === 404 ? "This event no longer exists." : `Error ${err.status}: ${err.message}`);
        else if (err instanceof NetworkError) setError("Can't reach the daemon.");
        else setError(err instanceof Error ? err.message : "Failed to load the event.");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [eventId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Only user-facing runs (skip gregorian's own summarizer pass), newest first.
  const visibleRuns = runs
    .filter((r) => r.role !== "summarizer")
    .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Event detail" onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2>{event?.title ?? "Event"}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        {loading && <p className="muted pad">Loading…</p>}
        {error && (
          <p className="form-error pad" role="alert">
            {error}
          </p>
        )}

        {event && !loading && !error && (
          <div className="detail">
            <span className={`pill status-${event.status}`}>{event.status}</span>

            <dl className="meta">
              <dt>Engine</dt>
              <dd>{event.engine}</dd>
              <dt>Model</dt>
              <dd>{event.model ?? "default"}</dd>
              <dt>cwd</dt>
              <dd className="mono">{event.cwd}</dd>
              <dt>Scheduled</dt>
              <dd>{fmt(event.scheduled_at)}</dd>
              <dt>Created</dt>
              <dd>{fmt(event.created_at)}</dd>
              {event.mentions && event.mentions.length > 0 && (
                <>
                  <dt>Mentions</dt>
                  <dd>{event.mentions.join(", ")}</dd>
                </>
              )}
            </dl>

            {event.prompt && (
              <section className="block-section">
                <h3>Prompt</h3>
                <pre className="text-block">{event.prompt}</pre>
              </section>
            )}

            <section className="block-section">
              <h3>Runs ({visibleRuns.length})</h3>
              {visibleRuns.length === 0 && <p className="muted">No runs yet — this event hasn’t fired.</p>}
              {visibleRuns.map((run) => (
                <div key={run.id} className={`run-card status-${run.status} ${run.status === "running" ? "live" : ""}`}>
                  <div className="run-line">
                    <span className={`pill status-${run.status}`}>{run.status}</span>
                    <span className="muted">{fmt(run.started_at)}</span>
                    <span className="muted">·</span>
                    <span className="muted">{duration(run)}</span>
                    {run.exit_code !== null && <span className="muted">· exit {run.exit_code}</span>}
                  </div>
                  {run.correlation === "ambiguous" && (
                    <div className="run-error" title="≥2 concurrent same-cwd launches were awaiting a transcript; attribution is best-effort (FIFO) and could be swapped with a sibling run.">
                      ⚠ ambiguous correlation
                    </div>
                  )}
                  {run.error && <div className="run-error">⚠ {run.error}</div>}
                  <MinutesPanel run={run} />
                  {run.transcript_path && <TranscriptViewer runId={run.id} />}
                </div>
              ))}
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
