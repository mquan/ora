/**
 * MinutesService tests (R1). The service bridges a finalized run to its recorded minutes via the
 * `claude -p` summarizer pass. These tests drive {@link MinutesService.generateFor} with a fake engine
 * (canned transcript stream) and a stub {@link ClaudeRunner}, proving:
 *   - it registers a `role=summarizer` guard run BEFORE summarizing (self-ingestion guard) and writes
 *     the result into `run.minutes`;
 *   - it is idempotent (a run that already has minutes is a no-op — no second guard run);
 *   - no fabricated minutes: an empty/unusable transcript leaves `run.minutes` null and records the
 *     reason on the guard run's `error`;
 *   - (F3) an unresolvable transcript path → log + return with NO guard run at all.
 */

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Store } from "../store/store.js";
import { MinutesService } from "./minutes.js";
import type { ClaudeRunner } from "../minutes/summarizer.js";
import type { AgentEngine, TranscriptEvent, TranscriptIdentity } from "../engines/types.js";
import type { Run } from "../types.js";

const silent = { log: () => {}, error: () => {} };
const NOW = "2026-07-01T12:00:00.000Z";
const CANNED = "The agent listed files and made no changes. Nothing was committed. The run was a no-op.";

/** A fake engine: canned transcript events, and a togglable transcript-path resolver (for the F3 case). */
class FakeEngine implements AgentEngine {
  readonly id = "claude" as const;
  constructor(
    private readonly events: TranscriptEvent[],
    private readonly pathResolvable = true,
  ) {}
  resolveTranscriptPath(sessionId: string): string | null {
    return this.pathResolvable ? `/fake/${sessionId}.jsonl` : null;
  }
  async *parseTranscript(): AsyncIterable<TranscriptEvent> {
    for (const ev of this.events) yield ev;
  }
  transcriptRoots(): string[] {
    return ["/fake"];
  }
  identifyTranscript(): TranscriptIdentity | null {
    return null;
  }
  start(): Promise<never> {
    throw new Error("FakeEngine.start should not be called by the minutes service");
  }
}

/** A {@link ClaudeRunner} that resolves canned stdout — never spawns a real `claude`. */
const okRunner: ClaudeRunner = async () => ({ exitCode: 0, stdout: CANNED, stderr: "" });

let dbPath: string;
let store: Store;

beforeEach(() => {
  dbPath = join(tmpdir(), `greg-minutes-${randomUUID()}.db`);
  store = new Store(dbPath);
});

afterEach(() => {
  store.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
  }
});

/** Create a finalized `role=run` run (with a transcript path) ready for minutes generation. */
function finishedRun(over: { transcriptPath?: string | null } = {}): Run {
  const event = store.createEvent({
    title: "scheduled run",
    engine: "claude",
    cwd: "/work/repo",
    prompt: "list files",
    schedule_kind: "once",
    scheduled_at: NOW,
    status: "done",
  });
  return store.createRun({
    event_id: event.id,
    engine: "claude",
    session_id: randomUUID(),
    role: "run",
    status: "done",
    started_at: NOW,
    ended_at: NOW,
    transcript_path: "transcriptPath" in over ? over.transcriptPath ?? null : "/fake/run.jsonl",
  });
}

const messageEvents: TranscriptEvent[] = [
  { type: "message", role: "assistant", text: "listed the files", raw: {} },
];

const summarizerRuns = (): Run[] => store.listRuns().filter((r) => r.role === "summarizer");

describe("MinutesService.generateFor", () => {
  it("registers a summarizer guard run, summarizes, and writes minutes to the real run", async () => {
    const run = finishedRun();
    const minutes = new MinutesService({
      store,
      resolveEngine: () => new FakeEngine(messageEvents),
      runner: okRunner,
      logger: silent,
      now: () => NOW,
    });

    await minutes.generateFor(run);

    // The real run now carries the generated minutes.
    expect(store.getRun(run.id)!.minutes).toBe(CANNED);

    // Exactly one guard run, role=summarizer, finalized done — the watcher skips it by role.
    const guards = summarizerRuns();
    expect(guards).toHaveLength(1);
    expect(guards[0]!.event_id).toBe(run.event_id);
    expect(guards[0]!.status).toBe("done");
    expect(guards[0]!.session_id).not.toBe(run.session_id);
  });

  it("is idempotent — a run that already has minutes is a no-op (no second guard run)", async () => {
    const run = finishedRun();
    const minutes = new MinutesService({
      store,
      resolveEngine: () => new FakeEngine(messageEvents),
      runner: okRunner,
      logger: silent,
      now: () => NOW,
    });

    await minutes.generateFor(run);
    const afterFirst = store.getRun(run.id)!;
    await minutes.generateFor(afterFirst); // run.minutes is now set → skip

    expect(summarizerRuns()).toHaveLength(1); // no second guard run
  });

  it("no fabricated minutes: an empty transcript leaves run.minutes null and fails the guard run", async () => {
    const run = finishedRun();
    const minutes = new MinutesService({
      store,
      resolveEngine: () => new FakeEngine([]), // nothing renderable → unusable transcript
      runner: okRunner,
      logger: silent,
      now: () => NOW,
    });

    await minutes.generateFor(run);

    expect(store.getRun(run.id)!.minutes).toBeNull(); // never invented
    const guards = summarizerRuns();
    expect(guards).toHaveLength(1);
    expect(guards[0]!.status).toBe("failed");
    expect(guards[0]!.error).toContain("empty or unusable transcript");
  });

  it("(F3) no resolvable transcript path → no guard run, no minutes", async () => {
    const run = finishedRun({ transcriptPath: null });
    const minutes = new MinutesService({
      store,
      resolveEngine: () => new FakeEngine(messageEvents, /* pathResolvable */ false),
      runner: okRunner,
      logger: silent,
      now: () => NOW,
    });

    await minutes.generateFor(run);

    expect(store.getRun(run.id)!.minutes).toBeNull();
    expect(summarizerRuns()).toHaveLength(0); // never spawned a pass over nothing
  });

  it("only summarizes role=run — a summarizer run passed in is ignored", async () => {
    const run = finishedRun();
    const guard = store.createRun({
      event_id: run.event_id,
      engine: "claude",
      session_id: randomUUID(),
      role: "summarizer",
      status: "done",
      started_at: NOW,
    });
    const minutes = new MinutesService({
      store,
      resolveEngine: () => new FakeEngine(messageEvents),
      runner: okRunner,
      logger: silent,
      now: () => NOW,
    });

    await minutes.generateFor(store.getRun(guard.id)!);

    // No new runs created (the guard wasn't itself summarized).
    expect(summarizerRuns()).toHaveLength(1);
    expect(store.getRun(run.id)!.minutes).toBeNull();
  });
});
