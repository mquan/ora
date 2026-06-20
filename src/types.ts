/**
 * Shared domain types for gregorian.
 *
 * Row interfaces mirror the SQLite columns in `snake_case` so the store, daemon,
 * watcher, and web API all speak the same shapes with no mapping layer. The schema
 * is locked in the design doc §"SQLite schema (M1)".
 */

/** Package marker. The real version is sourced from package.json at build/release time. */
export const GREGORIAN = "gregorian" as const;

/** Agent engines gregorian can launch and record. */
export type EngineKind = "claude" | "codex";

/**
 * Sentinel prefix for a LAUNCHED run whose engine cannot pre-assign the transcript session id
 * (codex: the rollout UUID is codex-chosen, learned only when the file appears). The scheduler writes
 * `pending:<uuid>` as a placeholder `session_id` so the NOT-NULL + UNIQUE `session_id` index still
 * holds; the watcher claims such a row when the real rollout appears and backfills the true id. A real
 * engine session id is never of this shape, so `getRunBySession(<realId>)` can never collide with a
 * pending row. Shared here (zero new import edges) by scheduler (writes), store (queries), watcher
 * (claims), and reconcile (skips).
 */
export const PENDING_SESSION_PREFIX = "pending:";

/** Build a pending-launch placeholder `session_id` from a freshly-generated uuid. */
export function pendingSession(uuid: string): string {
  return `${PENDING_SESSION_PREFIX}${uuid}`;
}

/** Whether a `session_id` is a not-yet-correlated pending-launch placeholder (see {@link PENDING_SESSION_PREFIX}). */
export function isPendingSession(sessionId: string): boolean {
  return sessionId.startsWith(PENDING_SESSION_PREFIX);
}

/**
 * A run's purpose. `run` is a user-facing agent run the watcher records; `summarizer`
 * is gregorian's own `claude -p` minutes pass, which the watcher skips (self-ingestion guard).
 */
export type RunRole = "run" | "summarizer";

/** `once` = a concrete scheduled occurrence; `adhoc` = a run discovered after the fact. */
export type ScheduleKind = "once" | "adhoc";

/** Lifecycle of a scheduled/recorded event. A scheduled fire must never silently vanish. */
export type EventStatus = "scheduled" | "running" | "done" | "failed" | "missed";

/** Lifecycle of a single run. */
export type RunStatus = "running" | "done" | "failed";

/**
 * A scheduled template that spawns occurrences. Each occurrence is materialized as its own
 * one-off `event`. Null for one-off / ad-hoc events.
 */
export interface RecurrenceRule {
  id: string;
  cron_spec: string;
  engine: EngineKind;
  model: string | null;
  cwd: string;
  prompt: string;
  /** Skill/doc references; persisted as a JSON array. */
  mentions: string[] | null;
  created_at: string;
}

/** A scheduled or discovered unit of work on the timeline. */
export interface Event {
  id: string;
  title: string;
  engine: EngineKind;
  model: string | null;
  cwd: string;
  /** Null for pure ad-hoc (discovered) events. */
  prompt: string | null;
  /** Skill/doc references; persisted as a JSON array. */
  mentions: string[] | null;
  schedule_kind: ScheduleKind;
  /** Concrete ISO time for `once`; null for `adhoc`. */
  scheduled_at: string | null;
  recurrence_rule_id: string | null;
  status: EventStatus;
  created_at: string;
}

/** A single execution of an event, correlated to a transcript by `session_id`. */
export interface Run {
  id: string;
  event_id: string;
  engine: EngineKind;
  /** The join key — pre-assigned for claude. Unique across all runs (watcher dedup). */
  session_id: string;
  role: RunRole;
  transcript_path: string | null;
  /** Bytes of the transcript already ingested — for dedup / re-attach after restart. */
  transcript_offset: number;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  /** Git diff summary; null for ad-hoc (no before-snapshot). */
  diff_stat: string | null;
  minutes: string | null;
  status: RunStatus;
  /**
   * Named, human-readable reason the run failed (spawn/finalize/interrupted) — null when the run
   * did not fail. A failed run is never a cause-less dead end (m2-finding B); surfaced in
   * `gregorian list` (short) and `gregorian show` (full). Added by migration v2.
   */
  error: string | null;
  /**
   * Correlation-confidence marker, written ONLY when the watcher claims a pending launched run (codex)
   * under concurrency. `null` = normal/unambiguous. `'ambiguous'` = ≥2 same-cwd launches were awaiting
   * a rollout within the confidence window, so this run's attribution is best-effort FIFO and could be
   * swapped with a sibling's — recorded (never lost), but flagged visibly (never silently mis-attributed).
   * Surfaced in `gregorian list`/`show` and the web detail panel. Added by migration v3.
   */
  correlation: string | null;
}

/**
 * Creation inputs. Store-generated fields (`id`, `created_at`) and fields with sane defaults
 * are optional; everything else is required.
 */
export type NewRecurrenceRule = Omit<RecurrenceRule, "id" | "created_at" | "model" | "mentions"> &
  Partial<Pick<RecurrenceRule, "id" | "created_at" | "model" | "mentions">>;

export type NewEvent = Omit<
  Event,
  "id" | "created_at" | "model" | "prompt" | "mentions" | "scheduled_at" | "recurrence_rule_id"
> &
  Partial<
    Pick<
      Event,
      "id" | "created_at" | "model" | "prompt" | "mentions" | "scheduled_at" | "recurrence_rule_id"
    >
  >;

export type NewRun = Omit<
  Run,
  | "id"
  | "transcript_offset"
  | "transcript_path"
  | "started_at"
  | "ended_at"
  | "exit_code"
  | "diff_stat"
  | "minutes"
  | "error"
  | "correlation"
> &
  Partial<
    Pick<
      Run,
      | "id"
      | "transcript_offset"
      | "transcript_path"
      | "started_at"
      | "ended_at"
      | "exit_code"
      | "diff_stat"
      | "minutes"
      | "error"
      | "correlation"
    >
  >;

/** Patchable fields on an existing run (status transitions, recording results). */
export type RunUpdate = Partial<
  Pick<
    Run,
    | "status"
    | "role"
    | "transcript_path"
    | "transcript_offset"
    | "started_at"
    | "ended_at"
    | "exit_code"
    | "diff_stat"
    | "minutes"
    | "error"
  >
>;

/** Patchable fields on an existing event. */
export type EventUpdate = Partial<
  Pick<Event, "status" | "title" | "scheduled_at" | "model" | "prompt" | "mentions">
>;

/** Optional filter for `listEvents`. */
export interface EventFilter {
  status?: EventStatus;
}
