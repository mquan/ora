/**
 * The wire contract — a faithful mirror of the daemon's `src/types.ts` (the API serializes these as JSON
 * with ISO-8601 string timestamps). Kept hand-written (not generated) so the SPA stays a standalone Vite
 * package with no build-time dependency on the daemon's TypeScript.
 */

export type Engine = "claude" | "codex";

/** An event's lifecycle state (mirrors the daemon enum). */
export type EventStatus = "scheduled" | "running" | "done" | "failed" | "missed";

/** A single run's state (a run is one execution of an event). */
export type RunStatus = "running" | "done" | "failed";

export interface GregorianEvent {
  id: string;
  title: string;
  engine: Engine;
  model: string | null;
  cwd: string;
  prompt: string | null;
  mentions: string[] | null;
  schedule_kind: "once" | "adhoc";
  scheduled_at: string | null;
  recurrence_rule_id: string | null;
  status: EventStatus;
  created_at: string;
}

export interface Run {
  id: string;
  event_id: string;
  engine: Engine;
  session_id: string;
  role: "run" | "summarizer";
  transcript_path: string | null;
  transcript_offset?: number;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  diff_stat: string | null;
  minutes: string | null;
  status: RunStatus;
  error: string | null;
}

/** Request body for `POST /events`. */
export interface CreateEventBody {
  engine: Engine;
  cwd: string;
  scheduled_at: string;
  title?: string;
  model?: string | null;
  prompt?: string | null;
  mentions?: string[] | null;
}
