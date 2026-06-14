/**
 * Transcript watcher — gregorian's single recording pipeline (design §A1, P4b).
 *
 * One {@link Watcher} subscribes (via chokidar) to every engine's {@link AgentEngine.transcriptRoots}
 * and drives run lifecycle for BOTH kinds of session, joining on `session_id`:
 *   - LAUNCHED runs — the scheduler already wrote a `running` `run` row up-front; the watcher
 *     re-attaches by sessionId, tracks the transcript offset, and finalizes on idle.
 *   - AD-HOC runs — a `claude` session the user started themselves (gregorian never launched it).
 *     The watcher DISCOVERS it: creates an `Event(adhoc, running)` + `Run(role=run, running)` reading
 *     the cwd from the transcript, then records it like any other run.
 *
 * Engine-agnostic by construction: it only ever calls `engine.transcriptRoots()` and
 * `engine.identifyTranscript(path)`, so codex (m3) drops in unchanged — no claude path convention
 * leaks in here. It depends on exactly three things — {@link Store}, {@link AgentEngine}[], and
 * chokidar — and has NO coupling to the scheduler or daemon (those wire it up separately; the
 * `daemon-lifecycle` task's `reconcile` re-attaches in-flight runs at boot by calling
 * {@link Watcher.handleFileEvent} directly).
 *
 *     chokidar (add | change | unlink)        idle timer (per session)
 *   transcriptRoots ───────────┐                      │ idleMs
 *   (per engine)               ▼                      ▼
 *                       handleFileEvent(path,kind,size)   finalize(sessionId)
 *                               │                      │  liveness re-stat:
 *            engine.identifyTranscript(path)           │  grew? → re-arm
 *                               │ {sessionId, cwd}     │  stable? → run+event done
 *               store.getRunBySession(sessionId)
 *          ┌────────────────────┼─────────────────────────┐
 *    role=summarizer       role=run (running)          no run
 *      → SKIP              → re-attach + (re)arm        → ad-hoc discover (needs cwd) + arm
 *    (self-ingest guard)
 *
 * Robustness: every file event is wrapped in try/catch and chokidar's `error` is subscribed, so one
 * bad/half-written file can never crash the watcher or the daemon (a daemon component must be
 * legible and crash-proof — design + plan F2). Each transition is logged.
 *
 * Determinism note: the whole {@link handleFileEvent} path is SYNCHRONOUS (`identifyTranscript` reads
 * the file with a bounded sync read; better-sqlite3 is synchronous), so an event handler runs to
 * completion without interleaving. That, plus the UNIQUE `session_id` index, makes the no-double-count
 * dedup invariant hold even under rapid back-to-back events.
 */

import { mkdirSync, statSync } from "node:fs";
import { sep } from "node:path";

import { watch, type FSWatcher } from "chokidar";

import type { Store } from "../store/store.js";
import type { AgentEngine } from "../engines/types.js";
import type { Run, RunUpdate } from "../types.js";

/** Default idle window before a session with no new transcript writes is finalized. */
export const DEFAULT_IDLE_MS = 60_000;

/**
 * Minimal logging seam. Structurally identical to the scheduler's `Logger`, but redeclared here so
 * the watcher stays self-contained (no import edge into the scheduler/daemon — the architecture keeps
 * the watcher's deps to Store + AgentEngine + chokidar only).
 */
export interface Logger {
  log(msg: string): void;
  error(msg: string): void;
}

/** Default console logger; silence it in tests by injecting a no-op {@link Logger}. */
export const consoleLogger: Logger = {
  log: (m) => console.log(`[gregorian:watcher] ${m}`),
  error: (m) => console.error(`[gregorian:watcher] ${m}`),
};

/** Injected dependencies — no globals, so the watcher is unit/integration testable in isolation. */
export interface WatcherDeps {
  store: Store;
  /** Every engine whose transcript roots should be watched (claude today; codex in m3). */
  engines: AgentEngine[];
  /** Defaults to {@link consoleLogger}. */
  logger?: Logger;
  /** Idle window in ms; defaults to {@link DEFAULT_IDLE_MS}. */
  idleMs?: number;
  /** ISO-timestamp source (`started_at`/`ended_at`); defaults to wall clock. Injectable for tests. */
  now?: () => string;
}

/** The two chokidar events that carry transcript growth. `unlink` is handled separately. */
export type FileEventKind = "add" | "change";

export class Watcher {
  private readonly store: Store;
  private readonly engines: AgentEngine[];
  private readonly logger: Logger;
  private readonly idleMs: number;
  private readonly now: () => string;

  /** One armed idle timer per live session; reset on every observed write, cleared on finalize/stop. */
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private watcher: FSWatcher | undefined;

  constructor(deps: WatcherDeps) {
    this.store = deps.store;
    this.engines = deps.engines;
    this.logger = deps.logger ?? consoleLogger;
    this.idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * Begin watching every engine's transcript roots. Roots are created if missing (a fresh machine may
   * not have `~/.claude/projects` yet). `ignoreInitial:true` — record only NEW activity from here
   * forward; the watcher must NOT replay the user's whole transcript history as ad-hoc runs at boot
   * (plan F1; boot re-attach of in-flight runs is reconcile's job). `alwaysStat:true` so `add`/`change`
   * carry the byte size → `transcript_offset` with no extra `stat`. `depth:2` bounds the recursive
   * watch (claude layout is `root/<slug>/<sessionId>.jsonl`).
   */
  async start(): Promise<void> {
    const roots = [...new Set(this.engines.flatMap((e) => e.transcriptRoots()))];
    for (const root of roots) {
      try {
        mkdirSync(root, { recursive: true });
      } catch (err) {
        this.logger.error(`could not ensure transcript root ${root}: ${(err as Error).message}`);
      }
    }

    const w = watch(roots, { ignoreInitial: true, alwaysStat: true, depth: 2 });
    w.on("add", (path, stats) => this.handleFileEvent(path, "add", stats?.size ?? 0));
    w.on("change", (path, stats) => this.handleFileEvent(path, "change", stats?.size ?? 0));
    w.on("unlink", (path) => this.handleUnlink(path));
    w.on("error", (err) => this.logger.error(`chokidar error: ${(err as Error).message}`));
    this.watcher = w;

    await new Promise<void>((resolve) => w.once("ready", () => resolve()));
    this.logger.log(`watching ${roots.length} transcript root(s): ${roots.join(", ")}`);
  }

  /** Close chokidar and clear all idle timers — idempotent. */
  async stop(): Promise<void> {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }
  }

  /**
   * The decision core — also the PUBLIC re-attach surface `reconcile` (daemon-lifecycle) drives at
   * boot. Synchronous and fully guarded: a throw anywhere is logged, never propagated, so a single
   * malformed file cannot tear down the watcher or the daemon.
   */
  handleFileEvent(path: string, _kind: FileEventKind, size: number): void {
    try {
      const engine = this.engineForPath(path);
      if (!engine) return; // not under any watched root
      const identity = engine.identifyTranscript(path);
      if (!identity) {
        this.logger.log(`ignored non-transcript ${path}`);
        return;
      }
      const { sessionId, cwd } = identity;
      const existing = this.store.getRunBySession(sessionId);

      if (existing) {
        if (existing.role === "summarizer") {
          // Self-ingestion guard: gregorian's own minutes pass — never record it.
          this.logger.log(`skipped summarizer session ${sessionId}`);
          return;
        }
        if (existing.status !== "running") {
          // Already finalized (or failed) — a late write must not resurrect it.
          this.logger.log(`ignored terminal run ${existing.id} (status=${existing.status})`);
          return;
        }
        this.reattach(existing, path, size);
        this.armIdle(sessionId, path);
        return;
      }

      // No run row → ad-hoc discovery. cwd is required to create the event; if the transcript is too
      // fresh to carry one yet, DEFER — a later `change` event will carry content (architect A1).
      if (cwd === null) {
        this.logger.log(`deferred ad-hoc ${sessionId} — no cwd in transcript yet`);
        return;
      }
      this.discoverAdhoc(sessionId, path, size, cwd, engine);
    } catch (err) {
      this.logger.error(`handleFileEvent failed for ${path}: ${(err as Error).message}`);
    }
  }

  /**
   * A watched transcript was removed mid-run. Clear its idle timer so a stale timer can't finalize
   * from a vanished file; leave the run `running` for reconcile to sort out (plan F3).
   */
  private handleUnlink(path: string): void {
    try {
      const engine = this.engineForPath(path);
      if (!engine) return;
      const identity = engine.identifyTranscript(path); // cwd will be null (file gone); sessionId from name
      if (!identity) return;
      if (this.idleTimers.has(identity.sessionId)) {
        this.clearIdle(identity.sessionId);
        this.logger.log(`transcript removed for ${identity.sessionId}; cleared idle timer (left running)`);
      }
    } catch (err) {
      this.logger.error(`handleUnlink failed for ${path}: ${(err as Error).message}`);
    }
  }

  /**
   * Re-attach to an existing `running` run (launched, or a previously-discovered ad-hoc): fill in the
   * `transcript_path` if it was unknown, advance `transcript_offset` MONOTONICALLY (never rewind — an
   * out-of-order or restart event must not lose progress, architect A5). Status is left untouched.
   */
  private reattach(run: Run, path: string, size: number): void {
    const patch: RunUpdate = {};
    if (run.transcript_path === null) patch.transcript_path = path;
    if (size > run.transcript_offset) patch.transcript_offset = size;
    if (Object.keys(patch).length > 0) this.store.updateRun(run.id, patch);
    this.logger.log(`re-attached run ${run.id} (session ${run.session_id}) at offset ${Math.max(size, run.transcript_offset)}`);
  }

  /**
   * Discover an ad-hoc session: create its `Event(adhoc, running)` then its `Run(role=run, running)`,
   * reading the cwd from the transcript. The UNIQUE `session_id` index makes a concurrent insert
   * impossible to double-count: if a constraint error fires (belt-and-suspenders — the sync handler
   * can't actually race in-process under the single-writer daemon), fall back to re-attach.
   */
  private discoverAdhoc(
    sessionId: string,
    path: string,
    size: number,
    cwd: string,
    engine: AgentEngine,
  ): void {
    const startedAt = this.now();
    try {
      const event = this.store.createEvent({
        title: adhocTitle(engine.id, cwd),
        engine: engine.id,
        cwd,
        prompt: null,
        schedule_kind: "adhoc",
        status: "running",
      });
      this.store.createRun({
        event_id: event.id,
        engine: engine.id,
        session_id: sessionId,
        role: "run",
        status: "running",
        started_at: startedAt,
        transcript_path: path,
        transcript_offset: size,
      });
      this.logger.log(`discovered ad-hoc session ${sessionId} (event ${event.id}) cwd=${cwd}`);
      this.armIdle(sessionId, path);
    } catch (err) {
      const existing = this.store.getRunBySession(sessionId);
      if (existing) {
        this.logger.log(`ad-hoc create lost a race for ${sessionId}; re-attaching instead`);
        if (existing.status === "running" && existing.role === "run") {
          this.reattach(existing, path, size);
          this.armIdle(sessionId, path);
        }
        return;
      }
      throw err; // genuinely unexpected — surface via the outer guard
    }
  }

  /**
   * Finalize a session after the idle window — but LIVENESS-CHECK first: re-stat the transcript, and
   * if it grew past the recorded offset (a slow agent that paused longer than `idleMs` then resumed),
   * advance the offset and re-arm rather than declaring a false `done` (decision D2). If the file
   * vanished, leave the run `running` for reconcile (mirrors the unlink path). Only the watcher's own
   * authority — the run + its event status — is set; `exit_code` stays as-is (null for ad-hoc; the
   * watcher cannot observe an ad-hoc process exit, decision D3).
   */
  private finalize(sessionId: string, path: string): void {
    try {
      this.idleTimers.delete(sessionId);
      const run = this.store.getRunBySession(sessionId);
      if (!run || run.status !== "running" || run.role === "summarizer") return;

      const size = this.fileSize(path);
      if (size === null) {
        this.logger.log(`finalize skipped for ${sessionId}: transcript gone (left running)`);
        return;
      }
      if (size > run.transcript_offset) {
        this.store.updateRun(run.id, { transcript_offset: size });
        this.logger.log(`liveness re-arm for ${sessionId}: grew to ${size} after idle window`);
        this.armIdle(sessionId, path);
        return;
      }

      const endedAt = this.now();
      this.store.updateRun(run.id, {
        status: "done",
        ended_at: endedAt,
        transcript_offset: Math.max(run.transcript_offset, size),
      });
      this.store.updateEvent(run.event_id, { status: "done" });
      this.logger.log(`finalized run ${run.id} (session ${sessionId}) → done at offset ${Math.max(run.transcript_offset, size)}`);
    } catch (err) {
      this.logger.error(`finalize failed for ${sessionId}: ${(err as Error).message}`);
    }
  }

  /** (Re)arm the idle timer for a session, capturing the current path for the liveness re-stat. */
  private armIdle(sessionId: string, path: string): void {
    this.clearIdle(sessionId);
    this.idleTimers.set(
      sessionId,
      setTimeout(() => this.finalize(sessionId, path), this.idleMs),
    );
  }

  /** Clear and forget a session's idle timer, if any. */
  private clearIdle(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(sessionId);
    }
  }

  /** Current byte size of `path`, or `null` if it can't be stat'd (missing/unreadable). */
  private fileSize(path: string): number | null {
    try {
      return statSync(path).size;
    } catch {
      return null;
    }
  }

  /** The engine whose transcript roots contain `path`, or `undefined` if none do. */
  private engineForPath(path: string): AgentEngine | undefined {
    for (const engine of this.engines) {
      for (const root of engine.transcriptRoots()) {
        if (path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)) return engine;
      }
    }
    return undefined;
  }
}

/** A human-skimmable title for a discovered ad-hoc event (the `event.title` column is NOT NULL). */
function adhocTitle(engine: string, cwd: string): string {
  const tail = cwd.split(sep).filter(Boolean).pop() ?? cwd;
  return `ad-hoc ${engine} (${tail})`;
}
