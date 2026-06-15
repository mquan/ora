/**
 * MinutesService — the daemon's bridge from a finalized run to its recorded minutes (design §A3, R1).
 *
 * Both finalize paths call `onRunFinalized(run)` fire-and-forget: the scheduler's daemon-alive exit
 * and the watcher's idle/liveness finalize. The service runs gregorian's own `claude -p` summarizer
 * pass over the run's transcript + diff and writes the result into `run.minutes` — at most ONCE per
 * run (idempotent: skips a run that already has minutes or is mid-generation).
 *
 * Self-ingestion guard: the summarizer's own `claude -p` writes a transcript too. BEFORE spawning it
 * we register a `role=summarizer` run under the SAME event, so the watcher (which keys session_id →
 * role) skips it and never records a spurious run. A crashed daemon can leave that guard run
 * `running`; reconcile sweeps it terminal (R2).
 *
 * Total + crash-proof: `generateFor` wraps its whole body so a fire-and-forget call can never surface
 * an unhandled rejection (F2). No fabricated minutes (design edge case 4) — an empty/unusable
 * transcript leaves `run.minutes` null and records the reason on the guard run's `error`.
 */

import type { Store } from "../store/store.js";
import { consoleLogger, type EngineResolver, type Logger } from "./scheduler.js";
import { summarize, newSummarizerSessionId, type ClaudeRunner } from "../minutes/summarizer.js";
import type { Run } from "../types.js";

/** Injected dependencies — store + engine resolver, with an injectable summarizer spawn for tests. */
export interface MinutesServiceDeps {
  store: Store;
  resolveEngine: EngineResolver;
  /** Override the summarizer's `claude -p` spawn (tests inject a deterministic stub). */
  runner?: ClaudeRunner;
  logger?: Logger;
  /** ISO-timestamp source (`started_at`/`ended_at`); defaults to wall clock. Injectable for tests. */
  now?: () => string;
}

export class MinutesService {
  private readonly store: Store;
  private readonly resolveEngine: EngineResolver;
  private readonly runner?: ClaudeRunner;
  private readonly logger: Logger;
  private readonly now: () => string;

  /** Run ids currently being summarized — guards against concurrent double-generation. */
  private readonly inFlight = new Set<string>();
  /** Pending generation promises — `idle()` awaits them (tests/diagnostics; NOT awaited by stop()). */
  private readonly pending = new Set<Promise<void>>();

  constructor(deps: MinutesServiceDeps) {
    this.store = deps.store;
    this.resolveEngine = deps.resolveEngine;
    this.runner = deps.runner;
    this.logger = deps.logger ?? consoleLogger;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * Fire-and-forget entry the scheduler + watcher call on a run's terminal transition. Tracks the
   * promise so {@link idle} can await it, and swallows any rejection (defence in depth over
   * `generateFor`'s own guard) so a background minutes pass can never crash the daemon.
   */
  onRunFinalized(run: Run): void {
    const p = this.generateFor(run).catch((err) => {
      this.logger.error(`minutes generation crashed for run ${run.id}: ${(err as Error).message}`);
    });
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** Await all in-flight minutes generations. For tests + diagnostics — daemon stop() does NOT call this (F9). */
  async idle(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  /**
   * Generate + persist minutes for one finalized run. Idempotent and total (never throws). Only
   * `role=run` runs get minutes; a run that already has minutes, or is mid-generation, is skipped.
   */
  async generateFor(run: Run): Promise<void> {
    if (run.role !== "run") return;
    if (run.minutes !== null) return;
    if (this.inFlight.has(run.id)) return;
    this.inFlight.add(run.id);
    try {
      // Re-read: the run may have gained a transcript_path / minutes since the caller captured it.
      const fresh = this.store.getRun(run.id);
      if (!fresh || fresh.role !== "run" || fresh.minutes !== null) return;

      const event = this.store.getEvent(fresh.event_id);
      if (!event) {
        this.logger.error(`minutes: no event ${fresh.event_id} for run ${fresh.id}`);
        return;
      }

      const engine = this.resolveEngine(event.engine);
      const path =
        fresh.transcript_path ?? engine.resolveTranscriptPath(fresh.session_id, event.cwd);
      if (!path) {
        // (F3) No transcript to summarize — log and stop. No guard run, no fabricated minutes.
        this.logger.log(`minutes: no transcript path for run ${fresh.id}; skipping`);
        return;
      }

      // Self-ingestion guard: register the summarizer session BEFORE spawning so the watcher skips it.
      const summarizerSessionId = newSummarizerSessionId();
      const guard = this.store.createRun({
        event_id: fresh.event_id,
        engine: event.engine,
        session_id: summarizerSessionId,
        role: "summarizer",
        status: "running",
        started_at: this.now(),
      });

      const result = await summarize(
        {
          transcript: engine.parseTranscript(path),
          diffStat: fresh.diff_stat,
          prompt: event.prompt,
          cwd: event.cwd,
          engine: event.engine,
        },
        { sessionId: summarizerSessionId, runner: this.runner },
      );

      // Finalize the guard run (so it never lingers `running`); carry any failure reason.
      this.store.updateRun(guard.id, {
        status: result.ok ? "done" : "failed",
        ended_at: this.now(),
        exit_code: result.exitCode,
        error: result.error,
      });

      if (result.ok && result.minutes) {
        this.store.updateRun(fresh.id, { minutes: result.minutes });
        this.logger.log(`minutes recorded for run ${fresh.id} (${result.minutes.length} chars)`);
      } else {
        this.logger.log(`no minutes for run ${fresh.id}: ${result.error ?? "unknown reason"}`);
      }
    } catch (err) {
      this.logger.error(`minutes generation failed for run ${run.id}: ${(err as Error).message}`);
    } finally {
      this.inFlight.delete(run.id);
    }
  }
}
