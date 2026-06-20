/**
 * Codex same-cwd concurrency correlation — the codex-hardening DoD, driven DETERMINISTICALLY.
 *
 * The soft spot this hardens: two codex runs launched in the SAME cwd both get `pending:` rows, and codex
 * cannot pre-assign its session id, so the watcher must attribute each appearing rollout to the right
 * pending row — or, when the launches are genuinely concurrent (spawned within the confidence window) and
 * order can't be trusted, record BOTH and flag the whole group `correlation='ambiguous'` (never lose a
 * run, never silently mis-attribute). We drive {@link Watcher.handleFileEvent} directly (the surface that
 * holds the claim logic) over a real {@link Store} + temp rollout files — zero chokidar / timer flakiness.
 *
 * DoD coverage:
 *  - far-apart launches (spawn gap > window) → each rollout attributed to its OWN event, NO flag;
 *  - simultaneous launches (within window)   → both recorded (bijection), session ids backfilled, BOTH
 *    flagged `correlation='ambiguous'` — the "fail loudly" path;
 *  - the window is injectable: two co-pending rows whose spawns are far apart disambiguate cleanly even
 *    when both are eligible for the first rollout (the WINDOW governs, not merely "≥2 pending").
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Watcher } from "./watcher.js";
import { CodexEngine } from "../engines/codex.js";
import { Store } from "../store/store.js";
import { pendingSession } from "../types.js";
import type { AgentEngine, TranscriptEvent, TranscriptIdentity } from "../engines/types.js";

const silent = { log: () => {}, error: () => {} };
const NOW = "2026-06-14T21:00:00.000Z";
const IDLE_MS = 60_000; // large: the correlation assertions read state immediately, before any idle finalize.

/** A codex-shaped fake: id=codex, cannot pre-assign, identity carries cwd + startedAt from line 1. */
class FakeCodexEngine implements AgentEngine {
  readonly id = "codex" as const;
  readonly preassignsSessionId = false;
  constructor(private readonly root: string) {}
  transcriptRoots(): string[] {
    return [this.root];
  }
  identifyTranscript(path: string): TranscriptIdentity | null {
    if (!path.startsWith(this.root + sep) || !path.endsWith(".jsonl")) return null;
    const sessionId = basename(path, ".jsonl");
    let cwd: string | null = null;
    let startedAt: string | undefined;
    try {
      const first = readFileSync(path, "utf8").split("\n")[0] ?? "";
      if (first.trim()) {
        const meta = JSON.parse(first) as { payload?: { cwd?: string; timestamp?: string } };
        cwd = meta.payload?.cwd ?? null;
        startedAt = meta.payload?.timestamp;
      }
    } catch {
      // too-fresh / partial → cwd stays null (watcher defers), mirroring the real engine.
    }
    return { sessionId, cwd, startedAt };
  }
  resolveTranscriptPath(): string | null {
    return null;
  }
  start(): Promise<never> {
    throw new Error("FakeCodexEngine.start should not be called by the watcher");
  }
  // eslint-disable-next-line require-yield
  async *parseTranscript(): AsyncIterable<TranscriptEvent> {
    throw new Error("FakeCodexEngine.parseTranscript should not be called by the watcher");
  }
}

let root: string;
let dbPath: string;
let store: Store;
let engine: FakeCodexEngine;
let watcher: Watcher;

beforeEach(() => {
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), "greg-codex-conc-root-"));
  dbPath = join(tmpdir(), `greg-codex-conc-${randomUUID()}.db`);
  store = new Store(dbPath);
  engine = new FakeCodexEngine(root);
  // Default ambiguity window (5s) for the far-apart + simultaneous cases; a tight window is injected inline.
  watcher = new Watcher({ store, engines: [engine], logger: silent, idleMs: IDLE_MS, now: () => NOW });
});

afterEach(async () => {
  await watcher.stop();
  vi.useRealTimers();
  store.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(dbPath + suffix);
    } catch {
      /* not present */
    }
  }
  rmSync(root, { recursive: true, force: true });
});

/** Pre-create a PENDING launched codex run exactly as `scheduler.fire` does for codex. */
function preCreatePendingCodex(cwd: string, startedAt: string): { eventId: string; runId: string; sentinel: string } {
  const event = store.createEvent({
    title: "scheduled codex run",
    engine: "codex",
    cwd,
    prompt: "do the thing",
    schedule_kind: "once",
    scheduled_at: startedAt,
    status: "running",
  });
  const sentinel = pendingSession(randomUUID());
  const run = store.createRun({
    event_id: event.id,
    engine: "codex",
    session_id: sentinel,
    role: "run",
    status: "running",
    started_at: startedAt,
  });
  return { eventId: event.id, runId: run.id, sentinel };
}

/** Write a codex rollout `<root>/<realUuid>.jsonl` whose first line is a session_meta with cwd + timestamp. */
function writeRollout(realUuid: string, cwd: string, startedAt: string): { path: string; size: number } {
  const path = join(root, `${realUuid}.jsonl`);
  writeFileSync(
    path,
    JSON.stringify({ type: "session_meta", payload: { id: realUuid, cwd, timestamp: startedAt } }) +
      "\n" +
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      }) +
      "\n",
  );
  return { path, size: statSync(path).size };
}

const U1 = "019ed001-0000-7000-a000-000000000001";
const U2 = "019ed002-0000-7000-a000-000000000002";

describe("codex same-cwd concurrency correlation", () => {
  it("far-apart launches: each rollout attributed to its OWN event, no ambiguity flag, no double-record", () => {
    // Spawns 30s apart (≫ the 5s default window).
    const p1 = preCreatePendingCodex("/work/x", "2026-06-14T21:00:00.000Z");
    const p2 = preCreatePendingCodex("/work/x", "2026-06-14T21:00:30.000Z");

    // Rollout 1 starts just after p1's spawn but BEFORE p2's → the causal guard leaves only p1 eligible.
    const r1 = writeRollout(U1, "/work/x", "2026-06-14T21:00:05.000Z");
    watcher.handleFileEvent(r1.path, "add", r1.size);
    // Rollout 2 starts after p2's spawn (p1 already claimed).
    const r2 = writeRollout(U2, "/work/x", "2026-06-14T21:00:35.000Z");
    watcher.handleFileEvent(r2.path, "add", r2.size);

    const run1 = store.getRunBySession(U1)!;
    const run2 = store.getRunBySession(U2)!;

    // FIFO attribution: earliest rollout → earliest-spawned run, each to its own scheduled event.
    expect(run1.id).toBe(p1.runId);
    expect(run2.id).toBe(p2.runId);
    expect(run1.event_id).toBe(p1.eventId);
    expect(run2.event_id).toBe(p2.eventId);

    // Disambiguated by spawn time → NO flag on either.
    expect(run1.correlation).toBeNull();
    expect(run2.correlation).toBeNull();

    // No loss, no double-record: exactly the two pending rows were claimed (sentinels gone), nothing new.
    expect(store.listRuns()).toHaveLength(2);
    expect(store.listEvents()).toHaveLength(2);
    expect(store.getRunBySession(p1.sentinel)).toBeUndefined();
    expect(store.getRunBySession(p2.sentinel)).toBeUndefined();
  });

  it("simultaneous launches: both recorded (bijection), session ids backfilled, BOTH flagged ambiguous", () => {
    // Spawns 1ms apart (well within the 5s default window) → genuinely concurrent, order untrustworthy.
    const p1 = preCreatePendingCodex("/work/y", "2026-06-14T21:00:00.000Z");
    const p2 = preCreatePendingCodex("/work/y", "2026-06-14T21:00:00.001Z");

    // Both rollouts start AFTER both spawns → both pending rows are causally eligible for each rollout.
    const r1 = writeRollout(U1, "/work/y", "2026-06-14T21:00:02.000Z");
    watcher.handleFileEvent(r1.path, "add", r1.size); // sees [p1,p2] within window → flags p1, pre-flags p2
    const r2 = writeRollout(U2, "/work/y", "2026-06-14T21:00:03.000Z");
    watcher.handleFileEvent(r2.path, "add", r2.size); // sole remaining is p2, but it's sticky-ambiguous

    const run1 = store.getRunBySession(U1)!;
    const run2 = store.getRunBySession(U2)!;

    // Bijection: each rollout claimed a DISTINCT pending row / distinct event — both recorded, none lost.
    expect(run1.id).toBe(p1.runId);
    expect(run2.id).toBe(p2.runId);
    expect(new Set([run1.event_id, run2.event_id]).size).toBe(2);
    expect(store.listRuns()).toHaveLength(2);
    expect(store.getRunBySession(p1.sentinel)).toBeUndefined();
    expect(store.getRunBySession(p2.sentinel)).toBeUndefined();

    // Session ids backfilled to the real rollout uuids (no longer the `pending:` sentinels).
    expect(run1.session_id).toBe(U1);
    expect(run2.session_id).toBe(U2);
    expect(run1.session_id).not.toMatch(/^pending:/);
    expect(run2.session_id).not.toMatch(/^pending:/);

    // The "fail loudly" bar: the WHOLE concurrent group carries the marker, not just the first claimed.
    expect(run1.correlation).toBe("ambiguous");
    expect(run2.correlation).toBe("ambiguous");
  });

  it("window is injectable: co-pending rows with far-apart spawns disambiguate (no false-positive flag)", async () => {
    // A TIGHT 10ms window: two spawns 1s apart are NOT concurrent even though both are pending + eligible.
    const tight = new Watcher({
      store,
      engines: [engine],
      logger: silent,
      idleMs: IDLE_MS,
      now: () => NOW,
      ambiguityWindowMs: 10,
    });
    try {
      const p1 = preCreatePendingCodex("/work/z", "2026-06-14T21:00:00.000Z");
      const p2 = preCreatePendingCodex("/work/z", "2026-06-14T21:00:01.000Z"); // 1s later ≫ 10ms window

      // Both rollouts start after BOTH spawns → both rows are causally eligible for r1.
      const r1 = writeRollout(U1, "/work/z", "2026-06-14T21:00:02.000Z");
      tight.handleFileEvent(r1.path, "add", r1.size); // [p1,p2] eligible, but 1s gap > 10ms → not concurrent
      const r2 = writeRollout(U2, "/work/z", "2026-06-14T21:00:02.500Z");
      tight.handleFileEvent(r2.path, "add", r2.size);

      const run1 = store.getRunBySession(U1)!;
      const run2 = store.getRunBySession(U2)!;
      expect(run1.id).toBe(p1.runId); // FIFO still attaches earliest-spawned first
      expect(run2.id).toBe(p2.runId);
      // The window — not merely "≥2 pending" — decides ambiguity, so neither is flagged.
      expect(run1.correlation).toBeNull();
      expect(run2.correlation).toBeNull();
    } finally {
      await tight.stop();
    }
  });

  it("the real CodexEngine roots transcripts under ~/.codex/sessions (the watcher subscribes to these)", () => {
    // Regression for "wire codex transcriptRoots into the watcher": the watcher subscribes to exactly
    // whatever an engine's transcriptRoots() returns (proven by the claim tests above over a temp root),
    // and the DEFAULT daemon wires a real CodexEngine — so this pins the directory it watches.
    expect(new CodexEngine().transcriptRoots()).toEqual([join(homedir(), ".codex", "sessions")]);
  });
});
