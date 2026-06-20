/**
 * Store — the single SQLite boundary for gregorian.
 *
 * Everything above it (daemon, watcher, web API) speaks typed row objects from `types.ts`;
 * only this module touches better-sqlite3. The daemon is the single writer; WAL mode lets the
 * web API read without blocking it. One synchronous connection per process.
 *
 * The schema lives in the sibling `schema.sql` (single source of truth, human-readable) and is
 * read at runtime relative to this module — same path logic in `src` (vitest) and `dist` (npx),
 * since the build copies the `.sql` into `dist/store/`.
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import type {
  EngineKind,
  Event,
  EventFilter,
  EventUpdate,
  NewEvent,
  NewRecurrenceRule,
  NewRun,
  RecurrenceRule,
  Run,
  RunUpdate,
} from "../types.js";
import { PENDING_SESSION_PREFIX } from "../types.js";

type DB = Database.Database;

/** Canonical DDL, read once at module load. Resolves in both `src` and `dist`. */
const SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/**
 * Ordered migrations. `user_version` records how many have been applied; on open we run any
 * that are pending, each in its own transaction. v1 is the initial schema. Append, never edit.
 */
const MIGRATIONS: ReadonlyArray<(db: DB) => void> = [
  // v1 — initial schema (the human-readable `schema.sql` snapshot).
  (db) => db.exec(SCHEMA_SQL),
  // v2 — record WHY a run failed (m2-finding B) + index recurrence-occurrence lookups
  // (materializeRecurrences queries event.recurrence_rule_id on every boot + tick). `schema.sql`
  // stays frozen as the v1 snapshot per the append-never-edit convention above.
  (db) => {
    db.exec("ALTER TABLE run ADD COLUMN error TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_event_recurrence ON event(recurrence_rule_id)");
  },
  // v3 — correlation-confidence marker for codex concurrency hardening. Additive nullable column;
  // existing rows default to NULL (= unambiguous). Written only by `attachLaunchedRun` when the
  // watcher claims a pending launched run under same-cwd concurrency. `schema.sql` stays the v1 snapshot.
  (db) => {
    db.exec("ALTER TABLE run ADD COLUMN correlation TEXT");
  },
];

/** A scalar value that can be bound to a SQLite statement parameter. */
type Bind = string | number | null;

// --- internal row shapes (TEXT columns come back as strings; we narrow the unions on map) ---

interface RecurrenceRuleRow {
  id: string;
  cron_spec: string;
  engine: string;
  model: string | null;
  cwd: string;
  prompt: string;
  mentions: string | null;
  created_at: string;
}

interface EventRow {
  id: string;
  title: string;
  engine: string;
  model: string | null;
  cwd: string;
  prompt: string | null;
  mentions: string | null;
  schedule_kind: string;
  scheduled_at: string | null;
  recurrence_rule_id: string | null;
  status: string;
  created_at: string;
}

interface RunRow {
  id: string;
  event_id: string;
  engine: string;
  session_id: string;
  role: string;
  transcript_path: string | null;
  transcript_offset: number;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  diff_stat: string | null;
  minutes: string | null;
  status: string;
  error: string | null;
  correlation: string | null;
}

function parseMentions(raw: string | null): string[] | null {
  return raw === null ? null : (JSON.parse(raw) as string[]);
}

function serializeMentions(mentions: string[] | null | undefined): string | null {
  return mentions == null ? null : JSON.stringify(mentions);
}

function nowIso(): string {
  return new Date().toISOString();
}

export class Store {
  private readonly db: DB;

  /**
   * Open (or create) the database at `dbPath`, enable WAL + foreign keys, and run migrations.
   * WAL requires a real file path — `:memory:` silently ignores it.
   */
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    for (let version = current; version < MIGRATIONS.length; version++) {
      const up = MIGRATIONS[version];
      if (!up) continue;
      const apply = this.db.transaction(() => {
        up(this.db);
        this.db.pragma(`user_version = ${version + 1}`);
      });
      apply();
    }
  }

  /** Current SQLite journal mode (e.g. `"wal"`). Exposed for diagnostics/tests. */
  journalMode(): string {
    return this.db.pragma("journal_mode", { simple: true }) as string;
  }

  close(): void {
    this.db.close();
  }

  // --- recurrence_rule ---

  createRecurrenceRule(input: NewRecurrenceRule): RecurrenceRule {
    const rule: RecurrenceRule = {
      id: input.id ?? randomUUID(),
      cron_spec: input.cron_spec,
      engine: input.engine,
      model: input.model ?? null,
      cwd: input.cwd,
      prompt: input.prompt,
      mentions: input.mentions ?? null,
      created_at: input.created_at ?? nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO recurrence_rule (id, cron_spec, engine, model, cwd, prompt, mentions, created_at)
         VALUES (@id, @cron_spec, @engine, @model, @cwd, @prompt, @mentions, @created_at)`,
      )
      .run({ ...rule, mentions: serializeMentions(rule.mentions) });
    return rule;
  }

  getRecurrenceRule(id: string): RecurrenceRule | undefined {
    const row = this.db.prepare(`SELECT * FROM recurrence_rule WHERE id = ?`).get(id) as
      | RecurrenceRuleRow
      | undefined;
    return row && this.mapRule(row);
  }

  listRecurrenceRules(): RecurrenceRule[] {
    const rows = this.db
      .prepare(`SELECT * FROM recurrence_rule ORDER BY created_at`)
      .all() as RecurrenceRuleRow[];
    return rows.map((r) => this.mapRule(r));
  }

  // --- event ---

  createEvent(input: NewEvent): Event {
    const event: Event = {
      id: input.id ?? randomUUID(),
      title: input.title,
      engine: input.engine,
      model: input.model ?? null,
      cwd: input.cwd,
      prompt: input.prompt ?? null,
      mentions: input.mentions ?? null,
      schedule_kind: input.schedule_kind,
      scheduled_at: input.scheduled_at ?? null,
      recurrence_rule_id: input.recurrence_rule_id ?? null,
      status: input.status,
      created_at: input.created_at ?? nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO event
           (id, title, engine, model, cwd, prompt, mentions, schedule_kind, scheduled_at, recurrence_rule_id, status, created_at)
         VALUES
           (@id, @title, @engine, @model, @cwd, @prompt, @mentions, @schedule_kind, @scheduled_at, @recurrence_rule_id, @status, @created_at)`,
      )
      .run({ ...event, mentions: serializeMentions(event.mentions) });
    return event;
  }

  getEvent(id: string): Event | undefined {
    const row = this.db.prepare(`SELECT * FROM event WHERE id = ?`).get(id) as EventRow | undefined;
    return row && this.mapEvent(row);
  }

  listEvents(filter: EventFilter = {}): Event[] {
    const rows = (
      filter.status === undefined
        ? this.db.prepare(`SELECT * FROM event ORDER BY created_at`).all()
        : this.db.prepare(`SELECT * FROM event WHERE status = ? ORDER BY created_at`).all(filter.status)
    ) as EventRow[];
    return rows.map((r) => this.mapEvent(r));
  }

  /**
   * Every event materialized from a recurrence rule, oldest occurrence first. Backs idempotent
   * re-materialization (skip occurrences already present) — see `daemon/recurrence.ts`.
   */
  listEventsByRule(ruleId: string): Event[] {
    const rows = this.db
      .prepare(`SELECT * FROM event WHERE recurrence_rule_id = ? ORDER BY scheduled_at`)
      .all(ruleId) as EventRow[];
    return rows.map((r) => this.mapEvent(r));
  }

  /** Apply a partial update and return the refreshed row (or `undefined` if `id` is unknown). */
  updateEvent(id: string, patch: EventUpdate): Event | undefined {
    const bind = this.buildPatch(patch, ["mentions"]);
    if (bind.keys.length > 0) {
      this.db
        .prepare(`UPDATE event SET ${bind.setClause} WHERE id = @id`)
        .run({ ...bind.values, id });
    }
    return this.getEvent(id);
  }

  // --- run ---

  createRun(input: NewRun): Run {
    const run: Run = {
      id: input.id ?? randomUUID(),
      event_id: input.event_id,
      engine: input.engine,
      session_id: input.session_id,
      role: input.role,
      transcript_path: input.transcript_path ?? null,
      transcript_offset: input.transcript_offset ?? 0,
      started_at: input.started_at ?? null,
      ended_at: input.ended_at ?? null,
      exit_code: input.exit_code ?? null,
      diff_stat: input.diff_stat ?? null,
      minutes: input.minutes ?? null,
      status: input.status,
      error: input.error ?? null,
      correlation: input.correlation ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO run
           (id, event_id, engine, session_id, role, transcript_path, transcript_offset,
            started_at, ended_at, exit_code, diff_stat, minutes, status, error, correlation)
         VALUES
           (@id, @event_id, @engine, @session_id, @role, @transcript_path, @transcript_offset,
            @started_at, @ended_at, @exit_code, @diff_stat, @minutes, @status, @error, @correlation)`,
      )
      .run(run);
    return run;
  }

  getRun(id: string): Run | undefined {
    const row = this.db.prepare(`SELECT * FROM run WHERE id = ?`).get(id) as RunRow | undefined;
    return row && this.mapRun(row);
  }

  /** Look up a run by its (unique) session id — the watcher's correlation key. */
  getRunBySession(sessionId: string): Run | undefined {
    const row = this.db.prepare(`SELECT * FROM run WHERE session_id = ?`).get(sessionId) as
      | RunRow
      | undefined;
    return row && this.mapRun(row);
  }

  /** Apply a partial update and return the refreshed row (or `undefined` if `id` is unknown). */
  updateRun(id: string, patch: RunUpdate): Run | undefined {
    const bind = this.buildPatch(patch, []);
    if (bind.keys.length > 0) {
      this.db.prepare(`UPDATE run SET ${bind.setClause} WHERE id = @id`).run({ ...bind.values, id });
    }
    return this.getRun(id);
  }

  /**
   * All runs, oldest-started first (`started_at` is set at creation in the launch path). Powers the
   * daemon's `GET /runs` and the CLI `list` view. `id` is the tiebreaker for a stable order when two
   * runs share a timestamp or `started_at` is null.
   */
  listRuns(): Run[] {
    const rows = this.db
      .prepare(`SELECT * FROM run ORDER BY started_at, id`)
      .all() as RunRow[];
    return rows.map((r) => this.mapRun(r));
  }

  /** Runs for a single event, oldest-started first. */
  listRunsByEvent(eventId: string): Run[] {
    const rows = this.db
      .prepare(`SELECT * FROM run WHERE event_id = ? ORDER BY started_at, id`)
      .all(eventId) as RunRow[];
    return rows.map((r) => this.mapRun(r));
  }

  /**
   * Launched runs for `engine` still awaiting transcript correlation — `role='run'`, `status='running'`,
   * and a `pending:` placeholder `session_id` (an engine that can't pre-assign the rollout id, i.e.
   * codex). Oldest-spawned first. The watcher scans these to claim a freshly-appeared rollout BEFORE it
   * would otherwise treat it as a brand-new ad-hoc session (the pending-row + spawn-window match). claude
   * never writes such rows, so for claude this is always empty.
   */
  listPendingLaunchedRuns(engine: EngineKind): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM run
           WHERE engine = ? AND role = 'run' AND status = 'running' AND session_id LIKE ?
           ORDER BY started_at, id`,
      )
      .all(engine, `${PENDING_SESSION_PREFIX}%`) as RunRow[];
    return rows.map((r) => this.mapRun(r));
  }

  /**
   * Claim a pending launched run: backfill its real `session_id` (replacing the `pending:` placeholder),
   * `transcript_path`, and `transcript_offset` in one UPDATE, returning the refreshed row. The dedicated
   * method (rather than widening `RunUpdate` with `session_id`) keeps `session_id` immutable across the
   * general update surface — only the watcher's one-time pending→real correlation rewrites it. The real
   * id is unique, so the UNIQUE `session_id` index is preserved.
   *
   * `correlation` stamps the confidence marker in the SAME update: pass `'ambiguous'` when ≥2 same-cwd
   * launches were concurrently awaiting a rollout (best-effort FIFO attribution); omit it (default
   * `null`) for the normal single-candidate claim. The optional trailing param keeps the existing
   * single production caller backward-compatible.
   */
  attachLaunchedRun(
    runId: string,
    sessionId: string,
    transcriptPath: string,
    transcriptOffset: number,
    correlation: "ambiguous" | null = null,
  ): Run | undefined {
    this.db
      .prepare(
        `UPDATE run
           SET session_id = @session_id, transcript_path = @transcript_path,
               transcript_offset = @transcript_offset, correlation = @correlation
         WHERE id = @id`,
      )
      .run({
        id: runId,
        session_id: sessionId,
        transcript_path: transcriptPath,
        transcript_offset: transcriptOffset,
        correlation,
      });
    return this.getRun(runId);
  }

  /**
   * Stamp a run `correlation='ambiguous'` WITHOUT otherwise touching it. The watcher calls this on the
   * still-pending SIBLINGS of a concurrent same-cwd claim so that when each sibling's own rollout later
   * claims it, the flag is already there (sticky) — the whole concurrent group is mutually uncertain, so
   * every member must carry the marker, not just the first one claimed (never silently mis-attribute).
   */
  markRunAmbiguous(runId: string): void {
    this.db.prepare(`UPDATE run SET correlation = 'ambiguous' WHERE id = @id`).run({ id: runId });
  }

  // --- mappers / helpers ---

  private mapRule(row: RecurrenceRuleRow): RecurrenceRule {
    return {
      ...row,
      engine: row.engine as RecurrenceRule["engine"],
      mentions: parseMentions(row.mentions),
    };
  }

  private mapEvent(row: EventRow): Event {
    return {
      ...row,
      engine: row.engine as Event["engine"],
      schedule_kind: row.schedule_kind as Event["schedule_kind"],
      status: row.status as Event["status"],
      mentions: parseMentions(row.mentions),
    };
  }

  private mapRun(row: RunRow): Run {
    return {
      ...row,
      engine: row.engine as Run["engine"],
      role: row.role as Run["role"],
      status: row.status as Run["status"],
    };
  }

  /**
   * Turn a partial patch into a `SET a = @a, b = @b` clause and a bound-values map, serializing
   * any JSON columns named in `jsonKeys`. Returns empty `keys` for a no-op patch.
   */
  private buildPatch(
    patch: Record<string, unknown>,
    jsonKeys: string[],
  ): { keys: string[]; setClause: string; values: Record<string, Bind> } {
    const keys = Object.keys(patch);
    const values: Record<string, Bind> = {};
    for (const key of keys) {
      const value = patch[key];
      values[key] = jsonKeys.includes(key)
        ? serializeMentions(value as string[] | null | undefined)
        : (value as Bind);
    }
    return { keys, setClause: keys.map((k) => `${k} = @${k}`).join(", "), values };
  }
}
