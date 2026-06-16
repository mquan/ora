import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listEvents, listRuns, ApiError, NetworkError } from "./api";
import type { GregorianEvent, Run } from "./types";
import { toCalendarItems, addDays, startOfWeek } from "./calendarModel";
import { Calendar, type CalendarView } from "./Calendar";
import { EventForm } from "./EventForm";
import { DetailPanel } from "./DetailPanel";

const POLL_MS = 5_000;
const CLOCK_MS = 30_000;

interface Data {
  events: GregorianEvent[];
  runs: Run[];
}

/** A user-facing description of a load failure (never a silent blank screen). */
function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Session expired — re-run `gregorian ui` to get a fresh token.";
    return `The daemon returned ${err.status}: ${err.message}`;
  }
  if (err instanceof NetworkError) return "Can't reach the gregorian daemon — is it still running?";
  return err instanceof Error ? err.message : "Unknown error loading the calendar.";
}

/** Poll `/events` + `/runs` together; pause while the tab is hidden; resume (and refetch) on focus. */
function usePollingData(): { data: Data; error: string | null; updatedAt: number | null; refresh: () => void } {
  const [data, setData] = useState<Data>({ events: [], runs: [] });
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const seq = useRef(0);

  const fetchOnce = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [{ events }, { runs }] = await Promise.all([listEvents(), listRuns()]);
      if (mine !== seq.current) return; // a newer fetch already landed
      setData({ events: events ?? [], runs: runs ?? [] });
      setError(null);
      setUpdatedAt(Date.now());
    } catch (err) {
      if (mine !== seq.current) return;
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    const start = () => {
      void fetchOnce();
      timer = window.setInterval(() => void fetchOnce(), POLL_MS);
    };
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      stop();
      if (!document.hidden) start();
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchOnce]);

  return { data, error, updatedAt, refresh: fetchOnce };
}

/** A coarse clock for the "now" line — ticks every 30s (decoupled from data polling). */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), CLOCK_MS);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

function relativeAgo(updatedAt: number | null, now: Date): string {
  if (updatedAt === null) return "loading…";
  const secs = Math.max(0, Math.round((now.getTime() - updatedAt) / 1000));
  if (secs < 5) return "updated just now";
  if (secs < 60) return `updated ${secs}s ago`;
  return `updated ${Math.round(secs / 60)}m ago`;
}

export function App() {
  const now = useNow();
  const { data, error, updatedAt, refresh } = usePollingData();
  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const items = useMemo(() => toCalendarItems(data.events, data.runs, now), [data, now]);

  // Week and agenda both step by 7 days; month steps by a calendar month.
  const navigate = (dir: -1 | 0 | 1) => {
    if (dir === 0) return setAnchor(new Date());
    if (view === "month") {
      setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + dir, 1));
    } else {
      setAnchor((a) => addDays(startOfWeek(a), dir * 7));
    }
  };

  const periodLabel = useMemo(() => labelFor(view, anchor), [view, anchor]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" /> gregorian
        </div>
        <div className="nav">
          <button className="btn" onClick={() => navigate(0)}>
            Today
          </button>
          <button className="icon-btn" aria-label="Previous" onClick={() => navigate(-1)}>
            ‹
          </button>
          <button className="icon-btn" aria-label="Next" onClick={() => navigate(1)}>
            ›
          </button>
          <span className="period">{periodLabel}</span>
        </div>
        <div className="spacer" />
        <div className="views">
          {(["week", "month", "agenda"] as CalendarView[]).map((v) => (
            <button key={v} className={`seg ${view === v ? "seg-on" : ""}`} onClick={() => setView(v)}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <button className="btn btn-primary" onClick={() => setFormOpen(true)}>
          ＋ New run
        </button>
      </header>

      <div className="statusline">
        <span className="muted">{relativeAgo(updatedAt, now)}</span>
        {error && (
          <span className="banner" role="alert">
            {error} <button className="link" onClick={() => void refresh()}>Retry</button>
          </span>
        )}
      </div>

      <main className="surface">
        <Calendar view={view} anchor={anchor} items={items} now={now} onSelect={setSelectedEventId} />
      </main>

      {formOpen && (
        <EventForm
          onClose={() => setFormOpen(false)}
          onCreated={() => {
            setFormOpen(false);
            void refresh();
          }}
        />
      )}

      {selectedEventId && (
        <DetailPanel eventId={selectedEventId} onClose={() => setSelectedEventId(null)} />
      )}
    </div>
  );
}

function labelFor(view: CalendarView, anchor: Date): string {
  const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
  if (view === "month") return monthFmt.format(anchor);
  const days = [startOfWeek(anchor), addDays(startOfWeek(anchor), 6)];
  const dFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  return `${dFmt.format(days[0])} – ${dFmt.format(days[1])}, ${anchor.getFullYear()}`;
}
