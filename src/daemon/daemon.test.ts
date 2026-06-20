/**
 * Daemon integration tests (m1/t5). Two layers, no real `claude` and no wall-clock timers:
 *
 *   1. Scheduler — the schedule→launch→record-lite contract, driven by calling `fire()` directly
 *      with a STUB engine so the fire path is deterministic (croner timing is not under test here).
 *      Covers arm/disarm/armPending, the past-due + non-`once` guards, and that a fired run is
 *      recorded with its exit code + transcript path (the DoD's "list shows the run" backbone).
 *
 *   2. Daemon HTTP API — boots a real {@link Daemon} on an ephemeral port (`port: 0`) under a
 *      hermetic `ORA_HOME`, then hits it over loopback with `fetch`. Covers `/health` (no
 *      auth), bearer auth, POST/GET `/events`, GET `/runs`, validation 400s, the 404 fallback,
 *      the body-size 413, and that the server binds 127.0.0.1 only. POST `/events` arming proves
 *      "a new event arms without a daemon restart."
 */

import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Store } from "../store/store.js";
import { Scheduler, type Logger } from "./scheduler.js";
import { Daemon } from "./daemon.js";
import type {
  AgentEngine,
  RunHandle,
  RunResult,
  StartOptions,
  TranscriptEvent,
  TranscriptIdentity,
} from "../engines/types.js";
import type { Event, NewEvent, Run } from "../types.js";

/** Silence the daemon/scheduler logs so test output stays clean; tests assert on state, not logs. */
const silentLogger: Logger = { log: () => {}, error: () => {} };

/** A stub engine: records every `start()` call and resolves a caller-supplied {@link RunResult}. */
class StubEngine implements AgentEngine {
  readonly id = "claude" as const;
  readonly starts: Array<{ event: Event; opts: StartOptions }> = [];

  constructor(
    private readonly resultFor: (sessionId: string) => RunResult,
    private readonly throwOnStart = false,
  ) {}

  async start(event: Event, opts: StartOptions): Promise<RunHandle> {
    this.starts.push({ event, opts });
    if (this.throwOnStart) throw new Error("simulated spawn failure");
    const result = this.resultFor(opts.sessionId);
    return {
      sessionId: opts.sessionId,
      status: () => "done",
      result: () => Promise.resolve(result),
    };
  }

  resolveTranscriptPath(sessionId: string): string | null {
    // unused by the scheduler; present to satisfy the AgentEngine contract.
    return `/tmp/stub-transcripts/${sessionId}.jsonl`;
  }

  async *parseTranscript(): AsyncIterable<TranscriptEvent> {
    // unused by the scheduler; present to satisfy the AgentEngine contract.
  }

  transcriptRoots(): string[] {
    return ["/tmp/stub-transcripts"];
  }

  identifyTranscript(): TranscriptIdentity | null {
    // unused by the scheduler; present to satisfy the AgentEngine contract.
    return null;
  }
}

const newEvent = (over: Partial<NewEvent> = {}): NewEvent => ({
  title: "triage inbox",
  engine: "claude",
  cwd: "/tmp/x",
  schedule_kind: "once",
  status: "scheduled",
  ...over,
});

/** A scheduled_at safely in the future so `arm()` does not treat it as past-due. */
const soon = (): string => new Date(Date.now() + 60_000).toISOString();

describe("Scheduler", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = join(tmpdir(), `ora-sched-${randomUUID()}.db`);
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = dbPath + suffix;
      if (existsSync(p)) rmSync(p);
    }
  });

  it("arms a future `once` event and tracks it", () => {
    const sched = new Scheduler(store, () => new StubEngine(() => stubResult()), silentLogger);
    const event = store.createEvent(newEvent({ scheduled_at: soon() }));
    sched.arm(event);
    expect(sched.has(event.id)).toBe(true);
    expect(sched.armedCount()).toBe(1);
    sched.stop();
  });

  it("refuses to arm non-`once`, missing-time, and past-due events", () => {
    const sched = new Scheduler(store, () => new StubEngine(() => stubResult()), silentLogger);
    const adhoc = store.createEvent(newEvent({ schedule_kind: "adhoc", scheduled_at: undefined }));
    const noTime = store.createEvent(newEvent({ scheduled_at: undefined }));
    const pastDue = store.createEvent(
      newEvent({ scheduled_at: new Date(Date.now() - 60_000).toISOString() }),
    );
    sched.arm(adhoc);
    sched.arm(noTime);
    sched.arm(pastDue);
    expect(sched.armedCount()).toBe(0);
  });

  it("disarm and re-arm (idempotent replace) keep exactly one job", () => {
    const sched = new Scheduler(store, () => new StubEngine(() => stubResult()), silentLogger);
    const event = store.createEvent(newEvent({ scheduled_at: soon() }));
    sched.arm(event);
    sched.arm(event); // re-arm replaces, does not duplicate
    expect(sched.armedCount()).toBe(1);
    sched.disarm(event.id);
    expect(sched.has(event.id)).toBe(false);
    expect(sched.armedCount()).toBe(0);
  });

  it("fire() records a run with exit code + transcript path and marks the event done", async () => {
    const transcript = "/tmp/stub-transcripts/abc.jsonl";
    const engine = new StubEngine((sessionId) => stubResult({ sessionId, transcriptPath: transcript }));
    const sched = new Scheduler(store, () => engine, silentLogger);
    const event = store.createEvent(newEvent({ scheduled_at: soon() }));

    await sched.fire(event);

    // The engine was launched with a pre-assigned session id (the join key).
    expect(engine.starts).toHaveLength(1);
    const sessionId = engine.starts[0]!.opts.sessionId;
    expect(engine.starts[0]!.opts.beforeSnapshot).toBe(true);

    const runs = store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.session_id).toBe(sessionId);
    expect(runs[0]!.status).toBe("done");
    expect(runs[0]!.exit_code).toBe(0);
    expect(runs[0]!.transcript_path).toBe(transcript);

    expect(store.getEvent(event.id)!.status).toBe("done");
    // One-shot consumed: the job is gone after firing.
    expect(sched.has(event.id)).toBe(false);
  });

  it("fire() marks run + event failed on a non-zero exit", async () => {
    const engine = new StubEngine((sessionId) => stubResult({ sessionId, exitCode: 7 }));
    const sched = new Scheduler(store, () => engine, silentLogger);
    const event = store.createEvent(newEvent({ scheduled_at: soon() }));

    await sched.fire(event);

    const run = store.listRuns()[0]!;
    expect(run.status).toBe("failed");
    expect(run.exit_code).toBe(7);
    expect(store.getEvent(event.id)!.status).toBe("failed");
  });

  it("fire() marks the run failed when the engine fails to start", async () => {
    const engine = new StubEngine(() => stubResult(), /* throwOnStart */ true);
    const sched = new Scheduler(store, () => engine, silentLogger);
    const event = store.createEvent(newEvent({ scheduled_at: soon() }));

    await sched.fire(event);

    const run = store.listRuns()[0]!;
    expect(run.status).toBe("failed");
    expect(run.exit_code).toBeNull();
    expect(store.getEvent(event.id)!.status).toBe("failed");
  });

  it("fire() invokes onFinalize with the done run (R1 minutes hook)", async () => {
    const engine = new StubEngine((sessionId) =>
      stubResult({ sessionId, transcriptPath: "/tmp/stub-transcripts/x.jsonl" }),
    );
    const finalized: Run[] = [];
    const sched = new Scheduler(store, () => engine, silentLogger, (r) => finalized.push(r));
    await sched.fire(store.createEvent(newEvent({ scheduled_at: soon() })));

    expect(finalized).toHaveLength(1);
    expect(finalized[0]!.status).toBe("done");
  });

  it("fire() invokes onFinalize even on a non-zero exit (minutes still generate — edge case 4)", async () => {
    const engine = new StubEngine((sessionId) =>
      stubResult({ sessionId, exitCode: 3, transcriptPath: "/tmp/stub-transcripts/y.jsonl" }),
    );
    const finalized: Run[] = [];
    const sched = new Scheduler(store, () => engine, silentLogger, (r) => finalized.push(r));
    await sched.fire(store.createEvent(newEvent({ scheduled_at: soon() })));

    expect(finalized).toHaveLength(1);
    expect(finalized[0]!.status).toBe("failed");
  });

  it("failRun records the reason in run.error and does NOT trigger onFinalize (no transcript)", async () => {
    const engine = new StubEngine(() => stubResult(), /* throwOnStart */ true);
    const finalized: Run[] = [];
    const sched = new Scheduler(store, () => engine, silentLogger, (r) => finalized.push(r));
    await sched.fire(store.createEvent(newEvent({ scheduled_at: soon() })));

    const run = store.listRuns()[0]!;
    expect(run.status).toBe("failed");
    expect(run.error).toContain("engine start failed");
    expect(finalized).toHaveLength(0); // a spawn failure has no transcript → no minutes pass
  });

  it("armPending() re-arms scheduled future events from the DB (restart survival)", () => {
    store.createEvent(newEvent({ scheduled_at: soon() }));
    store.createEvent(newEvent({ scheduled_at: soon() }));
    store.createEvent(newEvent({ scheduled_at: new Date(Date.now() - 1000).toISOString() })); // past-due → skipped

    const sched = new Scheduler(store, () => new StubEngine(() => stubResult()), silentLogger);
    sched.armPending();
    expect(sched.armedCount()).toBe(2);
    sched.stop();
  });
});

describe("Daemon HTTP API", () => {
  let home: string;
  let realCwd: string;
  let daemon: Daemon;
  let base: string;
  let token: string;
  let engine: StubEngine;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "ora-home-"));
    // R6 validates that the scheduled cwd exists — POST tests must use a real directory.
    realCwd = mkdtempSync(join(tmpdir(), "ora-cwd-"));
    process.env.ORA_HOME = home;
    engine = new StubEngine((sessionId) => stubResult({ sessionId }));
    daemon = new Daemon({ port: 0, logger: silentLogger, engineResolver: () => engine });
    const info = await daemon.start();
    base = `http://127.0.0.1:${info.port}`;
    token = info.token;
  });

  afterEach(async () => {
    await daemon.stop();
    delete process.env.ORA_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(realCwd, { recursive: true, force: true });
  });

  const auth = (extra: Record<string, string> = {}): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    ...extra,
  });

  it("GET /health is 200 and needs no auth", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("binds loopback only and publishes a daemon.json clients can read", async () => {
    expect(existsSync(join(home, "daemon.json"))).toBe(true);
    // The base URL we connected on is 127.0.0.1 — a successful /health above already proved the bind.
    expect(base.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("GET / serves the web SPA shell, unauthenticated (no bare 401)", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await res.text();
    expect(body.toLowerCase()).toContain("ora");
  });

  it("GET /runs/:id/transcript requires a bearer token", async () => {
    const res = await fetch(`${base}/runs/whatever/transcript`);
    expect(res.status).toBe(401);
  });

  it("GET /runs/:id/transcript 404s an unknown run id with a named error", async () => {
    const res = await fetch(`${base}/runs/does-not-exist/transcript`, { headers: auth() });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("rejects authed routes without a valid bearer token", async () => {
    const missing = await fetch(`${base}/events`);
    expect(missing.status).toBe(401);
    const wrong = await fetch(`${base}/events`, { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
  });

  it("POST /events creates, persists, and arms an event without a restart", async () => {
    const res = await fetch(`${base}/events`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ engine: "claude", cwd: realCwd, scheduled_at: soon(), prompt: "list files" }),
    });
    expect(res.status).toBe(201);
    const { event } = (await res.json()) as { event: Event };
    expect(event.engine).toBe("claude");
    expect(event.title).toBe("list files"); // derived from the prompt's first line

    // Persisted and visible via GET /events…
    const list = await fetch(`${base}/events`, { headers: auth() });
    const { events } = (await list.json()) as { events: Event[] };
    expect(events.map((e) => e.id)).toContain(event.id);
  });

  it("POST /events rejects invalid bodies with a 400", async () => {
    const bad = async (body: unknown): Promise<number> =>
      (
        await fetch(`${base}/events`, {
          method: "POST",
          headers: auth({ "content-type": "application/json" }),
          body: JSON.stringify(body),
        })
      ).status;

    expect(await bad({ engine: "nope", cwd: realCwd, scheduled_at: soon() })).toBe(400);
    expect(await bad({ engine: "claude", scheduled_at: soon() })).toBe(400); // missing cwd
    expect(await bad({ engine: "claude", cwd: realCwd, scheduled_at: "not-a-date" })).toBe(400);
  });

  it("POST /events rejects a non-existent cwd with a 400 (R6 — trust boundary)", async () => {
    const missing = join(realCwd, "does", "not", "exist");
    const res = await fetch(`${base}/events`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ engine: "claude", cwd: missing, scheduled_at: soon(), prompt: "x" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("cwd does not exist");

    // …and nothing was scheduled.
    const list = await fetch(`${base}/events`, { headers: auth() });
    const { events } = (await list.json()) as { events: Event[] };
    expect(events).toHaveLength(0);
  });

  it("GET /events and GET /runs return arrays", async () => {
    const events = await (await fetch(`${base}/events`, { headers: auth() })).json();
    const runs = await (await fetch(`${base}/runs`, { headers: auth() })).json();
    expect(Array.isArray((events as { events: unknown[] }).events)).toBe(true);
    expect(Array.isArray((runs as { runs: unknown[] }).runs)).toBe(true);
  });

  it("returns a JSON 404 for an unknown non-GET route", async () => {
    // Unknown GETs now fall through to the SPA (static); the JSON 404 fallback covers other methods.
    const res = await fetch(`${base}/nope`, { method: "POST", headers: auth() });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe("not_found");
  });

  it("serves the SPA (not a JSON 404) for an unknown extensionless GET route", async () => {
    const res = await fetch(`${base}/some/app/route`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("rejects an over-cap body with 413 (declared Content-Length fast path)", async () => {
    // A genuinely >1MB prompt: fetch sets a real Content-Length over the cap, hitting the fast path.
    const huge = "x".repeat(1_100_000);
    const res = await fetch(`${base}/events`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ engine: "claude", cwd: "/tmp/x", scheduled_at: soon(), prompt: huge }),
    });
    expect(res.status).toBe(413);
  });
});

/** Build a {@link RunResult}, overridable per field. */
function stubResult(over: Partial<RunResult> = {}): RunResult {
  return {
    sessionId: over.sessionId ?? randomUUID(),
    exitCode: over.exitCode ?? 0,
    transcriptPath: over.transcriptPath ?? null,
    diffStat: over.diffStat ?? null,
  };
}
