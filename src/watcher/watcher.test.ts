/**
 * Watcher tests — the single recording pipeline's DoD + edges, driven DETERMINISTICALLY.
 *
 * Strategy (architect test plan): drive {@link Watcher.handleFileEvent} directly (it holds all the
 * decision logic and is the same surface reconcile drives), use `vi.useFakeTimers()` for the idle
 * window, a real {@link Store} on a tmp db, and real temp transcript files under a temp root. No
 * chokidar in the core tests → zero FS-watch flakiness. A separate, light real-chokidar smoke test
 * (real timers) proves the plumbing end-to-end.
 *
 * The watcher is engine-agnostic, so these tests use a FAKE engine whose transcript root is a temp
 * dir — this keeps them out of the real `~/.claude/projects` and proves nothing claude-specific leaks
 * into the watcher. The REAL `ClaudeEngine.identifyTranscript` is covered in `claude.test.ts`.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Watcher } from "./watcher.js";
import { readTranscriptCwd } from "../engines/claude.js";
import { Store } from "../store/store.js";
import type { AgentEngine, TranscriptEvent, TranscriptIdentity } from "../engines/types.js";

/** A silent logger — keeps test output clean while still exercising the log calls. */
const silent = { log: () => {}, error: () => {} };

/** Fixed clock for deterministic `started_at`/`ended_at` assertions. */
const NOW = "2026-06-14T21:00:00.000Z";

/**
 * A minimal engine over a temp transcript root. `identifyTranscript` mirrors the real claude one
 * (stem = sessionId, cwd read from content) without claude's `~/.claude/projects` path coupling, so
 * the watcher can be exercised against a temp dir. `start`/`parseTranscript` are never reached by the
 * watcher and throw/empty to prove it.
 */
class FakeEngine implements AgentEngine {
  readonly id = "claude" as const;
  constructor(private readonly root: string) {}
  transcriptRoots(): string[] {
    return [this.root];
  }
  identifyTranscript(path: string): TranscriptIdentity | null {
    if (!path.startsWith(this.root + sep) || !path.endsWith(".jsonl")) return null;
    return { sessionId: basename(path, ".jsonl"), cwd: readTranscriptCwd(path) };
  }
  resolveTranscriptPath(sessionId: string): string | null {
    // Mirrors the test layout `<root>/proj/<sessionId>.jsonl`; unused by the watcher itself.
    return join(this.root, "proj", `${sessionId}.jsonl`);
  }
  start(): Promise<never> {
    throw new Error("FakeEngine.start should not be called by the watcher");
  }
  // eslint-disable-next-line require-yield
  async *parseTranscript(): AsyncIterable<TranscriptEvent> {
    throw new Error("FakeEngine.parseTranscript should not be called by the watcher");
  }
}

const IDLE_MS = 1000;

let root: string;
let dbPath: string;
let store: Store;
let engine: FakeEngine;
let watcher: Watcher;

beforeEach(() => {
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), "greg-watch-root-"));
  dbPath = join(tmpdir(), `greg-watch-${randomUUID()}.db`);
  store = new Store(dbPath);
  engine = new FakeEngine(root);
  watcher = new Watcher({ store, engines: [engine], logger: silent, idleMs: IDLE_MS, now: () => NOW });
});

afterEach(() => {
  vi.useRealTimers();
  store.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
  }
  rmSync(root, { recursive: true, force: true });
});

/** Write a transcript file `<root>/proj/<sessionId>.jsonl`; first line carries `cwd` unless omitted. */
function writeTranscript(
  sessionId: string,
  opts: { cwd?: string; extraLines?: object[] } = {},
): { path: string; size: number } {
  const dir = join(root, "proj");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  const lines: string[] = [];
  if (opts.cwd !== undefined) {
    lines.push(JSON.stringify({ type: "user", cwd: opts.cwd, message: { content: "hi" } }));
  }
  for (const obj of opts.extraLines ?? []) lines.push(JSON.stringify(obj));
  writeFileSync(path, lines.length ? lines.join("\n") + "\n" : "");
  return { path, size: statSync(path).size };
}

/** Append one JSONL line and return the new file size. */
function appendLine(path: string, obj: object): number {
  appendFileSync(path, JSON.stringify(obj) + "\n");
  return statSync(path).size;
}

/** Pre-create a LAUNCHED run exactly as `scheduler.fire` does: event running + run row up-front. */
function preCreateLaunched(sessionId: string, cwd: string): { eventId: string; runId: string } {
  const event = store.createEvent({
    title: "scheduled run",
    engine: "claude",
    cwd,
    prompt: "do the thing",
    schedule_kind: "once",
    scheduled_at: NOW,
    status: "running",
  });
  const run = store.createRun({
    event_id: event.id,
    engine: "claude",
    session_id: sessionId,
    role: "run",
    status: "running",
    started_at: NOW,
  });
  return { eventId: event.id, runId: run.id };
}

describe("launched run — recorded by sessionId (re-attach, no duplicate)", () => {
  it("re-attaches the pre-created run, tracks offset, and finalizes done on idle", () => {
    const sessionId = "launched-1";
    const { eventId, runId } = preCreateLaunched(sessionId, "/work/repo");
    const { path, size } = writeTranscript(sessionId, { cwd: "/work/repo" });

    watcher.handleFileEvent(path, "add", size);

    // Same run re-attached — no new run, no new event.
    expect(store.listRuns()).toHaveLength(1);
    expect(store.listEvents()).toHaveLength(1);
    const attached = store.getRunBySession(sessionId)!;
    expect(attached.id).toBe(runId);
    expect(attached.transcript_path).toBe(path);
    expect(attached.transcript_offset).toBe(size);
    expect(attached.status).toBe("running");

    // Idle window → finalize.
    vi.advanceTimersByTime(IDLE_MS);
    const done = store.getRun(runId)!;
    expect(done.status).toBe("done");
    expect(done.ended_at).toBe(NOW);
    expect(store.getEvent(eventId)!.status).toBe("done");
  });
});

describe("ad-hoc discovery — a session gregorian never launched", () => {
  it("creates Event(adhoc,running)+Run(role=run) with cwd from the transcript, then finalizes done", () => {
    const sessionId = "adhoc-1";
    const { path, size } = writeTranscript(sessionId, { cwd: "/home/me/side-project" });

    watcher.handleFileEvent(path, "add", size);

    const events = store.listEvents();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.schedule_kind).toBe("adhoc");
    expect(event.status).toBe("running");
    expect(event.prompt).toBeNull();
    expect(event.cwd).toBe("/home/me/side-project");

    const run = store.getRunBySession(sessionId)!;
    expect(run.role).toBe("run");
    expect(run.status).toBe("running");
    expect(run.event_id).toBe(event.id);
    expect(run.transcript_path).toBe(path);
    expect(run.transcript_offset).toBe(size);
    expect(run.started_at).toBe(NOW);

    vi.advanceTimersByTime(IDLE_MS);
    expect(store.getRunBySession(sessionId)!.status).toBe("done");
    expect(store.getEvent(event.id)!.status).toBe("done");
    expect(store.getRunBySession(sessionId)!.exit_code).toBeNull(); // watcher can't observe ad-hoc exit (D3)
  });

  it("DEFERS discovery until a cwd-bearing line exists, then discovers on the next event", () => {
    const sessionId = "adhoc-defer";
    // First write has NO cwd line — identity.cwd is null → defer (no event/run yet).
    const first = writeTranscript(sessionId, { extraLines: [{ type: "system", subtype: "init" }] });
    expect(readTranscriptCwd(first.path)).toBeNull();

    watcher.handleFileEvent(first.path, "add", first.size);
    expect(store.listRuns()).toHaveLength(0);
    expect(store.listEvents()).toHaveLength(0);

    // A later line carries cwd → now it discovers.
    const newSize = appendLine(first.path, { type: "user", cwd: "/late/cwd", message: { content: "x" } });
    watcher.handleFileEvent(first.path, "change", newSize);

    expect(store.listEvents()).toHaveLength(1);
    expect(store.getEvent(store.listEvents()[0]!.id)!.cwd).toBe("/late/cwd");
    expect(store.getRunBySession(sessionId)!.transcript_offset).toBe(newSize);
  });
});

describe("self-ingestion guard — summarizer sessions are skipped", () => {
  it("never records, never finalizes a role=summarizer session", () => {
    const sessionId = "summ-1";
    const event = store.createEvent({
      title: "minutes",
      engine: "claude",
      cwd: "/work/repo",
      schedule_kind: "adhoc",
      status: "running",
    });
    const run = store.createRun({
      event_id: event.id,
      engine: "claude",
      session_id: sessionId,
      role: "summarizer",
      status: "running",
      started_at: NOW,
    });
    const { path, size } = writeTranscript(sessionId, { cwd: "/work/repo" });

    watcher.handleFileEvent(path, "add", size);

    // No new rows, no mutation, and crucially: no idle timer armed → no finalize.
    expect(store.listRuns()).toHaveLength(1);
    expect(store.listEvents()).toHaveLength(1);
    expect(store.getRun(run.id)!.status).toBe("running");
    expect(store.getRun(run.id)!.transcript_path).toBeNull();

    vi.advanceTimersByTime(IDLE_MS * 5);
    expect(store.getRun(run.id)!.status).toBe("running"); // still running — guard held
  });
});

describe("dedup survives a simulated restart (re-attach, no double-count)", () => {
  it("re-attaching the same session after stop+new-watcher keeps one run and resumes the offset", async () => {
    const sessionId = "restart-1";
    preCreateLaunched(sessionId, "/work/repo");
    const { path, size: size1 } = writeTranscript(sessionId, { cwd: "/work/repo" });

    watcher.handleFileEvent(path, "add", size1);
    expect(store.getRunBySession(sessionId)!.transcript_offset).toBe(size1);
    await watcher.stop();

    // New watcher over the SAME store/root — reconcile drives handleFileEvent at boot for in-flight runs.
    const size2 = appendLine(path, { type: "user", cwd: "/work/repo", message: { content: "more" } });
    const restarted = new Watcher({ store, engines: [engine], logger: silent, idleMs: IDLE_MS, now: () => NOW });
    restarted.handleFileEvent(path, "change", size2);

    expect(store.listRuns()).toHaveLength(1); // STILL one run — no duplicate
    expect(store.listEvents()).toHaveLength(1);
    expect(store.getRunBySession(sessionId)!.transcript_offset).toBe(size2); // resumed forward
  });

  it("never rewinds the offset (monotonic) on an out-of-order/smaller event", () => {
    const sessionId = "restart-monotonic";
    preCreateLaunched(sessionId, "/work/repo");
    const { path, size } = writeTranscript(sessionId, {
      cwd: "/work/repo",
      extraLines: [{ type: "user", cwd: "/work/repo", message: { content: "padding to grow size" } }],
    });

    watcher.handleFileEvent(path, "change", size);
    expect(store.getRunBySession(sessionId)!.transcript_offset).toBe(size);

    // A stale/smaller event must not rewind the offset.
    watcher.handleFileEvent(path, "change", 1);
    expect(store.getRunBySession(sessionId)!.transcript_offset).toBe(size);
  });
});

describe("slow-agent liveness — re-stat before finalize", () => {
  it("re-arms (not done) when the transcript grew after the idle timer armed, then finalizes once stable", () => {
    const sessionId = "slow-1";
    const { path, size: size1 } = writeTranscript(sessionId, { cwd: "/work/repo" });
    watcher.handleFileEvent(path, "add", size1); // discovers ad-hoc, arms idle at offset size1

    // The agent pauses past idleMs, THEN resumes — grow the file on disk WITHOUT a new event.
    const size2 = appendLine(path, { type: "user", cwd: "/work/repo", message: { content: "resumed work" } });
    expect(size2).toBeGreaterThan(size1);

    vi.advanceTimersByTime(IDLE_MS); // timer fires → liveness re-stat sees growth → re-arm, NOT done
    let run = store.getRunBySession(sessionId)!;
    expect(run.status).toBe("running");
    expect(run.transcript_offset).toBe(size2);

    vi.advanceTimersByTime(IDLE_MS); // now stable (no further growth) → finalize
    run = store.getRunBySession(sessionId)!;
    expect(run.status).toBe("done");
    expect(run.ended_at).toBe(NOW);
  });
});

describe("ignored inputs — never create spurious runs", () => {
  it("ignores a non-transcript file under the root (identity null)", () => {
    const dir = join(root, "proj");
    mkdirSync(dir, { recursive: true });
    const txt = join(dir, "notes.txt");
    writeFileSync(txt, "not a transcript");
    watcher.handleFileEvent(txt, "add", statSync(txt).size);
    expect(store.listRuns()).toHaveLength(0);
    expect(store.listEvents()).toHaveLength(0);
  });

  it("ignores a path outside every engine root", () => {
    const outside = join(tmpdir(), `greg-outside-${randomUUID()}.jsonl`);
    writeFileSync(outside, JSON.stringify({ cwd: "/x" }) + "\n");
    try {
      watcher.handleFileEvent(outside, "add", statSync(outside).size);
      expect(store.listRuns()).toHaveLength(0);
      expect(store.listEvents()).toHaveLength(0);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("ignores a late write to an already-finalized run (no resurrection)", () => {
    const sessionId = "terminal-1";
    const { runId } = preCreateLaunched(sessionId, "/work/repo");
    store.updateRun(runId, { status: "done", ended_at: NOW });
    const { path, size } = writeTranscript(sessionId, { cwd: "/work/repo" });

    watcher.handleFileEvent(path, "change", size);
    const run = store.getRun(runId)!;
    expect(run.status).toBe("done");
    expect(run.transcript_path).toBeNull(); // untouched
  });
});

describe("unlink — a transcript removed mid-run", () => {
  it("clears the idle timer and leaves the run running for reconcile", () => {
    const sessionId = "unlink-1";
    const { path, size } = writeTranscript(sessionId, { cwd: "/work/repo" });
    watcher.handleFileEvent(path, "add", size); // discover + arm idle
    const run = store.getRunBySession(sessionId)!;
    expect(run.status).toBe("running");

    rmSync(path, { force: true });
    // Drive the private unlink handler the way chokidar's `unlink` event would.
    (watcher as unknown as { handleUnlink(p: string): void }).handleUnlink(path);

    vi.advanceTimersByTime(IDLE_MS * 3); // timer was cleared → no finalize
    expect(store.getRunBySession(sessionId)!.status).toBe("running");
  });
});

describe("real chokidar smoke test (real timers) — plumbing end-to-end", () => {
  // `retry`: this is the one test that drives REAL fsevents. macOS occasionally delivers no events at
  // all for a freshly-created temp dir within a watcher's lifetime — irreducible at the OS layer. A
  // retry starts a fresh watcher (new temp dir → new fsevents registration), which all but guarantees a
  // pass. Deterministic coverage of the watcher's logic lives in the fake-timer tests above; this only
  // proves the chokidar wiring end-to-end.
  it("discovers a freshly written transcript and finalizes it on idle", { timeout: 20000, retry: 3 }, async () => {
    vi.useRealTimers();
    const smokeRoot = mkdtempSync(join(tmpdir(), "greg-watch-smoke-"));
    const smokeDb = join(tmpdir(), `greg-watch-smoke-${randomUUID()}.db`);
    const smokeStore = new Store(smokeDb);
    const w = new Watcher({
      store: smokeStore,
      engines: [new FakeEngine(smokeRoot)],
      logger: silent,
      idleMs: 120,
      now: () => NOW,
    });
    try {
      await w.start();
      const dir = join(smokeRoot, "proj");
      mkdirSync(dir, { recursive: true });
      const sessionId = "smoke-1";
      const file = join(dir, `${sessionId}.jsonl`);
      const line = JSON.stringify({ type: "user", cwd: "/smoke/cwd", message: { content: "hi" } }) + "\n";
      writeFileSync(file, line);

      // On macOS, chokidar's `ready` can fire just before fsevents is truly armed, so a file written
      // immediately after `start()` can miss its initial event. A real agent keeps writing, so we mirror
      // that: re-append until the watcher delivers an event and discovers the run. Once discovered we stop
      // appending, and the idle window (120ms) finalizes it. This closes the ready-race deterministically.
      await waitFor(() => {
        appendFileSync(file, line);
        return smokeStore.getRunBySession(sessionId)?.role === "run";
      }, 8000);
      await waitFor(() => smokeStore.getRunBySession(sessionId)?.status === "done", 8000);
      expect(smokeStore.getRunBySession(sessionId)!.status).toBe("done");
    } finally {
      await w.stop();
      smokeStore.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(smokeDb + suffix)) rmSync(smokeDb + suffix);
      }
      rmSync(smokeRoot, { recursive: true, force: true });
    }
  });
});

/** Poll `cond` until true or `timeoutMs` elapses (real-timer helper for the smoke test). */
async function waitFor(cond: () => boolean | undefined, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
