/**
 * Boot-time reconcile (design lifecycle: open → reconcile → arm → start watcher → serve).
 *
 * Runs ONCE at daemon boot, BEFORE arming croner. Each item is processed in its own try/catch so one
 * bad row can never abort the pass (F4), and every action is logged (zero silent failure):
 *
 *   1. In-flight runs (status=running, role=run) that survived as detached children → re-attach to the
 *      watcher by session_id so its idle+liveness finalize takes over. Transcript present → re-attach;
 *      transcript truly gone → mark failed with a recorded `interrupted` reason. No loss (R2).
 *   2. Orphaned summarizer runs (role=summarizer, running) left by a crash → mark terminal (R2).
 *   3. Missed `once` fires (scheduled_at < now): within grace → fire now, fire-and-forget (F5: never
 *      await, boot must not block on a run); past grace → status=missed. A scheduled fire never
 *      silently vanishes (R3).
 *
 * Then re-materialize recurrence occurrences for the rolling window (R4). Returns a summary for the
 * daemon's boot log and for tests.
 */

import { statSync } from "node:fs";

import type { Store } from "../store/store.js";
import { isPendingSession } from "../types.js";
import { consoleLogger, type EngineResolver, type Logger, type Scheduler } from "./scheduler.js";
import type { Watcher } from "../watcher/watcher.js";
import { materializeRecurrences } from "./recurrence.js";

/** Default missed-fire grace window: fire a once-event up to 1h late, else mark it missed (design). */
export const DEFAULT_GRACE_MS = 60 * 60 * 1000;

export interface ReconcileDeps {
  store: Store;
  resolveEngine: EngineResolver;
  scheduler: Scheduler;
  watcher: Watcher;
  /** Missed-fire grace window in ms; defaults to {@link DEFAULT_GRACE_MS}. */
  graceMs?: number;
  /** Clock; defaults to wall clock. Injectable for deterministic tests. */
  now?: () => Date;
  logger?: Logger;
}

export interface ReconcileSummary {
  reattached: number;
  interrupted: number;
  orphanedSummarizers: number;
  graceFired: number;
  missed: number;
  materialized: number;
}

export function reconcile(deps: ReconcileDeps): ReconcileSummary {
  const { store, resolveEngine, scheduler, watcher } = deps;
  const logger = deps.logger ?? consoleLogger;
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  const now = deps.now ?? (() => new Date());
  const nowMs = now().getTime();

  const summary: ReconcileSummary = {
    reattached: 0,
    interrupted: 0,
    orphanedSummarizers: 0,
    graceFired: 0,
    missed: 0,
    materialized: 0,
  };

  // 1 + 2: sweep running runs (only the running set — small even after a crash).
  for (const run of store.listRuns().filter((r) => r.status === "running")) {
    try {
      if (isPendingSession(run.session_id)) {
        // A launched codex run still awaiting its rollout (no real id, no transcript path yet). It has no
        // predictable path to re-attach by, and it is NOT lost — the watcher will claim it once the
        // rollout appears. Leave it running. (Cleanup of a spawn-failed pending row that never produces a
        // rollout is owned by the codex-hardening task — TODO.)
        logger.log(`reconcile: run ${run.id} awaiting codex rollout (pending) — left running`);
        continue;
      }
      if (run.role === "summarizer") {
        // 2: orphaned summarizer guard — mark terminal so it never lingers.
        store.updateRun(run.id, {
          status: "failed",
          ended_at: now().toISOString(),
          error: "interrupted: summarizer did not finish before daemon restart",
        });
        summary.orphanedSummarizers += 1;
        continue;
      }

      // 1: in-flight launched/ad-hoc run.
      const event = store.getEvent(run.event_id);
      if (!event) {
        logger.error(`reconcile: run ${run.id} has no event ${run.event_id}; skipping`);
        continue;
      }
      const engine = resolveEngine(event.engine);
      const path = run.transcript_path ?? engine.resolveTranscriptPath(run.session_id, event.cwd);
      const size = path ? fileSize(path) : null;
      if (path && size !== null) {
        // Re-attach: prime the watcher's decision core (arms idle/liveness, same surface a live event hits).
        watcher.handleFileEvent(path, "add", size);
        summary.reattached += 1;
        logger.log(`reconcile: re-attached in-flight run ${run.id} (session ${run.session_id})`);
      } else {
        // Truly lost — no transcript on disk. Never leave it hanging.
        store.updateRun(run.id, {
          status: "failed",
          ended_at: now().toISOString(),
          error: "interrupted: daemon restarted and the transcript was not found",
        });
        store.updateEvent(run.event_id, { status: "failed" });
        summary.interrupted += 1;
        logger.log(`reconcile: marked lost in-flight run ${run.id} failed (no transcript)`);
      }
    } catch (err) {
      logger.error(`reconcile: failed to process run ${run.id}: ${(err as Error).message}`);
    }
  }

  // 3: missed-fire policy for past-due scheduled `once` events.
  for (const event of store.listEvents({ status: "scheduled" })) {
    try {
      if (event.schedule_kind !== "once" || !event.scheduled_at) continue;
      const when = new Date(event.scheduled_at).getTime();
      if (Number.isNaN(when) || when >= nowMs) continue; // future/unparseable — armPending handles future
      if (nowMs - when <= graceMs) {
        // Within grace → fire now, detached. NEVER await (F5) — boot must not block on a run.
        void scheduler.fire(event);
        summary.graceFired += 1;
        logger.log(`reconcile: grace-firing missed event ${event.id} (${event.scheduled_at})`);
      } else {
        store.updateEvent(event.id, { status: "missed" });
        summary.missed += 1;
        logger.log(`reconcile: event ${event.id} past grace (${event.scheduled_at}) → missed`);
      }
    } catch (err) {
      logger.error(
        `reconcile: failed to process scheduled event ${event.id}: ${(err as Error).message}`,
      );
    }
  }

  // R4: bring recurrence occurrences current for the rolling window.
  try {
    summary.materialized = materializeRecurrences({ store, scheduler, now: now(), logger }).created;
  } catch (err) {
    logger.error(`reconcile: recurrence materialization failed: ${(err as Error).message}`);
  }

  logger.log(
    `reconcile: ${summary.reattached} re-attached, ${summary.interrupted} interrupted, ` +
      `${summary.orphanedSummarizers} orphaned-summarizer, ${summary.graceFired} grace-fired, ` +
      `${summary.missed} missed, ${summary.materialized} occurrences materialized`,
  );
  return summary;
}

/** Current byte size of `path`, or `null` if it can't be stat'd (missing/unreadable). */
function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}
