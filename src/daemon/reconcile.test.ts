/**
 * Boot reconcile tests (R2 + R3). Reconcile runs once at boot, before arming croner. These tests drive
 * it against a real {@link Store}, a real {@link Watcher} (no chokidar — reconcile calls
 * `handleFileEvent` directly), and a {@link Scheduler} whose `fire` is spied (no real launch). They
 * cover the four boot recoveries:
 *   - an in-flight launched run whose transcript survived → re-attached, finalizes on idle (no loss);
 *   - an in-flight run whose transcript is truly gone → failed with a recorded `interrupted` reason;
 *   - an orphaned `role=summarizer` guard run → swept terminal (never lingers);
 *   - a past-due `once` event → grace-fired within 1h, else marked `missed` (never silently vanishes).
 *
 * Determinism: `vi.useFakeTimers()` for the idle window + an injected `now` for the grace comparison.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Store } from "../store/store.js";
import { Scheduler } from "./scheduler.js";
import { Watcher } from "../watcher/watcher.js";
import { reconcile } from "./reconcile.js";
import { readTranscriptCwd } from "../engines/claude.js";
import { pendingSession } from "../types.js";
import type { AgentEngine, TranscriptEvent, TranscriptIdentity } from "../engines/types.js";

const silent = { log: () => {}, error: () => {} };
const NOW_ISO = "2026-07-01T12:00:00.000Z";
const NOW = (): Date => new Date(NOW_ISO);
const IDLE_MS = 1000;

/** A fake engine over a temp root — mirrors claude's path↔identity mapping with no real-FS coupling. */
class FakeEngine implements AgentEngine {
  readonly id = "claude" as const;
  constructor(private readonly root: string) {}
  transcriptRoots(): string[] {
    return [this.root];
  }
  resolveTranscriptPath(sessionId: string): string | null {
    return join(this.root, "proj", `${sessionId}.jsonl`);
  }
  identifyTranscript(path: string): TranscriptIdentity | null {
    if (!path.startsWith(this.root + sep) || !path.endsWith(".jsonl")) return null;
    return { sessionId: basename(path, ".jsonl"), cwd: readTranscriptCwd(path) };
  }
  // eslint-disable-next-line require-yield
  async *parseTranscript(): AsyncIterable<TranscriptEvent> {
    throw new Error("unused by reconcile");
  }
  start(): Promise<never> {
    throw new Error("unused by reconcile");
  }
}

let root: string;
let dbPath: string;
let store: Store;
let engine: FakeEngine;
let watcher: Watcher;
let scheduler: Scheduler;

beforeEach(() => {
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), "greg-recon-root-"));
  dbPath = join(tmpdir(), `greg-recon-${randomUUID()}.db`);
  store = new Store(dbPath);
  engine = new FakeEngine(root);
  watcher = new Watcher({ store, engines: [engine], logger: silent, idleMs: IDLE_MS, now: () => NOW_ISO });
  scheduler = new Scheduler(store, () => engine, silent);
});

afterEach(() => {
  vi.useRealTimers();
  store.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
  }
  rmSync(root, { recursive: true, force: true });
});

const runReconcile = (): ReturnType<typeof reconcile> =>
  reconcile({ store, resolveEngine: () => engine, scheduler, watcher, now: NOW, logger: silent });

/** Write a transcript at the engine-resolved path for `sessionId`, carrying a cwd-bearing line. */
function writeTranscript(sessionId: string, cwd: string): string {
  const path = engine.resolveTranscriptPath(sessionId)!;
  mkdirSync(join(root, "proj"), { recursive: true });
  writeFileSync(path, JSON.stringify({ type: "user", cwd, message: { content: "hi" } }) + "\n");
  return path;
}

/** Pre-create an in-flight launched run (event running + run row, transcript_path unknown). */
function inflightRun(sessionId: string, role: "run" | "summarizer" = "run"): { eventId: string; runId: string } {
  const event = store.createEvent({
    title: "scheduled run",
    engine: "claude",
    cwd: "/work/repo",
    prompt: "do the thing",
    schedule_kind: "once",
    scheduled_at: NOW_ISO,
    status: "running",
  });
  const run = store.createRun({
    event_id: event.id,
    engine: "claude",
    session_id: sessionId,
    role,
    status: "running",
    started_at: NOW_ISO,
  });
  return { eventId: event.id, runId: run.id };
}

describe("reconcile — in-flight re-attach (R2)", () => {
  it("re-attaches a running run whose transcript survived and finalizes it on idle (no loss)", () => {
    const { eventId, runId } = inflightRun("reattach-1");
    const path = writeTranscript("reattach-1", "/work/repo");
    const size = statSync(path).size;

    const summary = runReconcile();

    expect(summary.reattached).toBe(1);
    const reattached = store.getRun(runId)!;
    expect(reattached.transcript_path).toBe(path);
    expect(reattached.transcript_offset).toBe(size);
    expect(reattached.status).toBe("running"); // the watcher's idle timer now owns finalization

    vi.advanceTimersByTime(IDLE_MS);
    expect(store.getRun(runId)!.status).toBe("done");
    expect(store.getEvent(eventId)!.status).toBe("done");
  });

  it("marks a running run failed with an `interrupted` reason when the transcript is truly gone", () => {
    const { eventId, runId } = inflightRun("lost-1"); // no transcript written

    const summary = runReconcile();

    expect(summary.interrupted).toBe(1);
    const failed = store.getRun(runId)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("interrupted");
    expect(store.getEvent(eventId)!.status).toBe("failed");
  });
});

describe("reconcile — pending codex launch (awaiting rollout)", () => {
  it("LEAVES a pending launched codex run running — not re-attached, not interrupted", () => {
    const event = store.createEvent({
      title: "scheduled codex run",
      engine: "codex",
      cwd: "/work/repo",
      prompt: "do the thing",
      schedule_kind: "once",
      scheduled_at: NOW_ISO,
      status: "running",
    });
    const run = store.createRun({
      event_id: event.id,
      engine: "codex",
      session_id: pendingSession(randomUUID()), // no real id, no transcript path yet
      role: "run",
      status: "running",
      started_at: NOW_ISO,
    });

    const summary = runReconcile();

    // Not counted as re-attached or interrupted — it's simply left for the watcher to claim later.
    expect(summary.reattached).toBe(0);
    expect(summary.interrupted).toBe(0);
    const after = store.getRun(run.id)!;
    expect(after.status).toBe("running");
    expect(after.error).toBeNull();
    expect(store.getEvent(event.id)!.status).toBe("running");
  });
});

describe("reconcile — orphaned summarizer (R2)", () => {
  it("sweeps a running role=summarizer guard run to terminal so it never lingers", () => {
    const { runId } = inflightRun("summ-1", "summarizer");

    const summary = runReconcile();

    expect(summary.orphanedSummarizers).toBe(1);
    const swept = store.getRun(runId)!;
    expect(swept.status).toBe("failed");
    expect(swept.error).toContain("summarizer did not finish");
  });
});

describe("reconcile — missed-fire policy (R3)", () => {
  it("grace-fires a past-due `once` event within the 1h window (fire-and-forget)", () => {
    const fireSpy = vi.spyOn(scheduler, "fire").mockResolvedValue(undefined);
    const event = store.createEvent({
      title: "missed but recent",
      engine: "claude",
      cwd: "/work/repo",
      prompt: "catch up",
      schedule_kind: "once",
      scheduled_at: new Date(Date.parse(NOW_ISO) - 30 * 60_000).toISOString(), // 30m ago — within grace
      status: "scheduled",
    });

    const summary = runReconcile();

    expect(summary.graceFired).toBe(1);
    expect(summary.missed).toBe(0);
    expect(fireSpy).toHaveBeenCalledTimes(1);
    expect(fireSpy.mock.calls[0]![0]!.id).toBe(event.id);
  });

  it("marks an event `missed` when it is past the grace window (never silently vanishes)", () => {
    const fireSpy = vi.spyOn(scheduler, "fire").mockResolvedValue(undefined);
    const event = store.createEvent({
      title: "long overdue",
      engine: "claude",
      cwd: "/work/repo",
      prompt: "too late",
      schedule_kind: "once",
      scheduled_at: new Date(Date.parse(NOW_ISO) - 2 * 60 * 60_000).toISOString(), // 2h ago — past 1h grace
      status: "scheduled",
    });

    const summary = runReconcile();

    expect(summary.missed).toBe(1);
    expect(summary.graceFired).toBe(0);
    expect(fireSpy).not.toHaveBeenCalled();
    expect(store.getEvent(event.id)!.status).toBe("missed");
  });
});
