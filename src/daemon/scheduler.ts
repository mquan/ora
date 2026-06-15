/**
 * Scheduler — croner wiring + the fire path.
 *
 * Owns one in-memory one-shot croner job per armed `once` event. When a job fires, {@link Scheduler.fire}
 * pre-assigns a session id, writes a `running` Run up-front (a fire is never invisible), launches the
 * engine DETACHED via the adapter base, and — **recording-lite (m1)** — finalizes from
 * `RunHandle.result()` (the daemon-alive path). The m2 transcript-watcher later supersedes this for
 * restart-survival; missed-fire grace + in-flight re-attach are m2 (`reconcile.ts`) and are explicitly
 * NOT done here.
 *
 * croner is in-memory only, so {@link Scheduler.armPending} re-arms future `scheduled` events from the
 * DB on daemon boot — a restart must not drop a future schedule. Past-due events are LOGGED and left
 * for m2 reconcile rather than silently armed onto a croner that would never fire.
 */

import { Cron } from "croner";
import { randomUUID } from "node:crypto";

import type { Store } from "../store/store.js";
import type { EngineKind, Event, Run } from "../types.js";
import type { AgentEngine, RunHandle } from "../engines/types.js";
import { ClaudeEngine } from "../engines/claude.js";

/** Thrown when an event names an engine m1 can't launch (codex arrives in m3). Never a silent skip. */
export class UnsupportedEngineError extends Error {
  constructor(engine: string) {
    super(`engine '${engine}' is not supported yet (m1 launches claude only; codex lands in m3)`);
    this.name = "UnsupportedEngineError";
  }
}

/** Maps an {@link EngineKind} to its concrete adapter. Injected so tests can stub the launch. */
export type EngineResolver = (engine: EngineKind) => AgentEngine;

/** Default resolver: a single shared {@link ClaudeEngine}; anything else → {@link UnsupportedEngineError}. */
export function defaultEngineResolver(): EngineResolver {
  const claude = new ClaudeEngine();
  return (engine) => {
    if (engine === "claude") return claude;
    throw new UnsupportedEngineError(engine);
  };
}

/** Minimal logging seam — console by default, silenceable in tests. */
export interface Logger {
  log(msg: string): void;
  error(msg: string): void;
}

export const consoleLogger: Logger = {
  log: (m) => console.log(`[gregorian] ${m}`),
  error: (m) => console.error(`[gregorian] ${m}`),
};

export class Scheduler {
  private readonly jobs = new Map<string, Cron>();
  private stopped = false;

  constructor(
    private readonly store: Store,
    private readonly resolveEngine: EngineResolver = defaultEngineResolver(),
    private readonly logger: Logger = consoleLogger,
    /**
     * Optional hook invoked when `fire()` finalizes a run (done OR failed-with-transcript). The daemon
     * wires it to the minutes service (R1). Minutes generate even for a non-zero exit (design edge case
     * 4) — the summarizer decides whether the transcript is usable. Spawn failures (no transcript) do
     * NOT call this.
     */
    private readonly onFinalize?: (run: Run) => void,
  ) {}

  /**
   * Arm a one-shot job for a future `once` event. No-ops (with a log) for ad-hoc events, missing/invalid
   * times, or past-due times — the last is m2's missed-fire territory, surfaced not swallowed. Idempotent:
   * re-arming an event replaces its existing job.
   */
  arm(event: Event): void {
    if (event.schedule_kind !== "once" || !event.scheduled_at) {
      this.logger.error(`refusing to arm event ${event.id}: not a 'once' event with a scheduled_at`);
      return;
    }
    const when = new Date(event.scheduled_at);
    if (Number.isNaN(when.getTime())) {
      this.logger.error(`refusing to arm event ${event.id}: unparseable scheduled_at '${event.scheduled_at}'`);
      return;
    }
    if (when.getTime() <= Date.now()) {
      this.logger.log(
        `event ${event.id} is past-due (${event.scheduled_at}); deferring to m2 reconcile (missed-fire)`,
      );
      return;
    }
    this.disarm(event.id);
    const job = new Cron(when, { name: event.id }, () => {
      void this.fire(event);
    });
    this.jobs.set(event.id, job);
    this.logger.log(`armed event ${event.id} (${event.engine}) for ${event.scheduled_at}`);
  }

  /** Stop and forget the job for `eventId`, if any. */
  disarm(eventId: string): void {
    const job = this.jobs.get(eventId);
    if (job) {
      job.stop();
      this.jobs.delete(eventId);
    }
  }

  /** Whether an event currently has a live armed job (used by tests + diagnostics). */
  has(eventId: string): boolean {
    return this.jobs.has(eventId);
  }

  /** Number of currently armed jobs. */
  armedCount(): number {
    return this.jobs.size;
  }

  /** Re-arm every pending future `scheduled` event from the DB (croner is in-memory only). */
  armPending(): void {
    const pending = this.store.listEvents({ status: "scheduled" });
    for (const event of pending) this.arm(event);
    this.logger.log(`armPending: ${this.jobs.size} of ${pending.length} scheduled event(s) armed`);
  }

  /**
   * Fire handler: record a `running` run, launch the engine detached, finalize on exit. Every failure
   * mode is visible — a spawn error marks the run/event `failed`; a finalize during shutdown is deferred
   * to m2 reconcile (logged, not lost).
   */
  async fire(event: Event): Promise<void> {
    this.jobs.delete(event.id); // one-shot consumed
    const sessionId = randomUUID();
    this.logger.log(`firing event ${event.id} (${event.engine}) → session ${sessionId}`);

    const run = this.store.createRun({
      event_id: event.id,
      engine: event.engine,
      session_id: sessionId,
      role: "run",
      status: "running",
      started_at: new Date().toISOString(),
    });
    this.store.updateEvent(event.id, { status: "running" });

    let handle: RunHandle;
    try {
      handle = await this.resolveEngine(event.engine).start(event, {
        sessionId,
        beforeSnapshot: true,
      });
    } catch (err) {
      // Resolve/spawn failed before a handle existed (unsupported engine, missing binary, bad cwd).
      this.failRun(run.id, event.id, `engine start failed: ${(err as Error).message}`);
      return;
    }

    const result = await handle.result();
    if (this.stopped) {
      this.logger.log(`daemon stopping; deferring finalize of run ${run.id} to m2 reconcile`);
      return;
    }
    try {
      const status = result.exitCode === 0 ? "done" : "failed";
      this.store.updateRun(run.id, {
        status,
        exit_code: result.exitCode,
        transcript_path: result.transcriptPath,
        diff_stat: result.diffStat,
        ended_at: new Date().toISOString(),
      });
      this.store.updateEvent(event.id, { status });
      this.logger.log(
        `event ${event.id} ${status} (exit ${result.exitCode}) transcript ${result.transcriptPath ?? "—"}`,
      );

      // R1: trigger minutes on this finalize path. The watcher's idle finalize may also fire for the
      // same run — minutes generation is idempotent (run.minutes guard), so whichever wins is fine.
      if (this.onFinalize) {
        const finalized = this.store.getRun(run.id);
        if (finalized) this.onFinalize(finalized);
      }
    } catch (err) {
      // e.g. Store closed mid-finalize (shutdown race) — log, never crash the daemon.
      this.logger.error(`failed to finalize run ${run.id}: ${(err as Error).message}`);
    }
  }

  /** Mark a run + its event `failed` with a logged reason; tolerant of a closed store. */
  private failRun(runId: string, eventId: string, message: string): void {
    this.logger.error(message);
    try {
      this.store.updateRun(runId, {
        status: "failed",
        exit_code: null,
        ended_at: new Date().toISOString(),
        error: message, // R5: a failed run records WHY (ENOENT cwd, unsupported engine, spawn error).
      });
      this.store.updateEvent(eventId, { status: "failed" });
    } catch (err) {
      this.logger.error(`failed to mark run ${runId} failed: ${(err as Error).message}`);
    }
  }

  /** Stop all jobs and refuse further finalize writes (shutdown). */
  stop(): void {
    this.stopped = true;
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }
}
