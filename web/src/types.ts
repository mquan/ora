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

export interface OraEvent {
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

/** One selectable model for an engine (mirrors the daemon registry's `ModelChoice`). */
export interface EngineModelChoice {
  value: string;
  label: string;
}

/** One engine's registry entry from `GET /engines` — its id, label, and curated model choices. */
export interface EngineInfo {
  id: Engine;
  label: string;
  models: EngineModelChoice[];
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
  /** `'ambiguous'` when this run was correlated to a transcript under same-cwd concurrency (best-effort
   *  FIFO attribution); `null`/absent when unambiguous. Surfaced as a warning on the run card. */
  correlation?: string | null;
}

/** One normalized transcript entry (mirrors the daemon's `TranscriptEvent`). `raw` keeps the original
 *  JSONL object so nothing is ever lost. */
export type TranscriptEventType = "message" | "tool_use" | "tool_result" | "system" | "unknown";

export interface TranscriptEvent {
  type: TranscriptEventType;
  role?: "user" | "assistant" | "system";
  /** Flattened human-readable text, when the entry has any. */
  text?: string;
  /** Tool name for `tool_use`/`tool_result` entries. */
  toolName?: string;
  /** ISO timestamp, when the entry carries one. */
  timestamp?: string;
  /** The untouched source object for this transcript line. */
  raw: unknown;
}

/** What `GET /runs/:id/transcript` returns (mirrors the daemon's `TranscriptResult`). Degraded reads
 *  arrive as 200 with a named `reason` — never a silent failure. */
export interface TranscriptResult {
  path: string | null;
  byteSize: number;
  entries: TranscriptEvent[];
  truncated: boolean;
  reason?: string;
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
