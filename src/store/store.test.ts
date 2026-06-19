/**
 * Store tests. WAL requires a real file (not `:memory:`), so each test opens a Store on a
 * unique temp-file path and closes + unlinks it after. Covers CRUD on all three tables, the
 * WAL pragma, the unique `session_id` dedup constraint, foreign-key enforcement, and the
 * JSON `mentions` round-trip.
 */

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Store } from "./store.js";
import { pendingSession } from "../types.js";
import type { NewEvent, NewRecurrenceRule, NewRun } from "../types.js";

let dbPath: string;
let store: Store;

beforeEach(() => {
  dbPath = join(tmpdir(), `gregorian-test-${randomUUID()}.db`);
  store = new Store(dbPath);
});

afterEach(() => {
  store.close();
  // WAL leaves -wal and -shm sidecars; remove all three.
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (existsSync(p)) rmSync(p);
  }
});

const newEvent = (over: Partial<NewEvent> = {}): NewEvent => ({
  title: "triage inbox",
  engine: "claude",
  cwd: "/tmp/x",
  schedule_kind: "once",
  status: "scheduled",
  ...over,
});

const newRun = (eventId: string, over: Partial<NewRun> = {}): NewRun => ({
  event_id: eventId,
  engine: "claude",
  session_id: randomUUID(),
  role: "run",
  status: "running",
  ...over,
});

const newRule = (over: Partial<NewRecurrenceRule> = {}): NewRecurrenceRule => ({
  cron_spec: "0 9 * * *",
  engine: "claude",
  cwd: "/tmp/x",
  prompt: "daily triage",
  ...over,
});

describe("Store: pragmas", () => {
  it("enables WAL journal mode", () => {
    expect(store.journalMode().toLowerCase()).toBe("wal");
  });
});

describe("Store: recurrence_rule", () => {
  it("creates, reads, and lists rules with mentions round-trip", () => {
    const created = store.createRecurrenceRule(newRule({ mentions: ["/qa", "docs/spec.md"] }));
    expect(created.id).toBeTruthy();

    const fetched = store.getRecurrenceRule(created.id);
    expect(fetched).toEqual(created);
    expect(fetched?.mentions).toEqual(["/qa", "docs/spec.md"]);

    store.createRecurrenceRule(newRule());
    expect(store.listRecurrenceRules()).toHaveLength(2);
  });

  it("defaults model and mentions to null", () => {
    const rule = store.createRecurrenceRule(newRule());
    expect(rule.model).toBeNull();
    expect(rule.mentions).toBeNull();
    expect(store.getRecurrenceRule(rule.id)?.mentions).toBeNull();
  });
});

describe("Store: event", () => {
  it("creates with defaults, reads back, and round-trips mentions", () => {
    const ev = store.createEvent(newEvent({ prompt: "go", mentions: ["/qa"] }));
    expect(ev.prompt).toBe("go");

    const fetched = store.getEvent(ev.id);
    expect(fetched).toEqual(ev);
    expect(fetched?.mentions).toEqual(["/qa"]);
    // unset optionals default to null
    expect(fetched?.model).toBeNull();
    expect(fetched?.scheduled_at).toBeNull();
    expect(fetched?.recurrence_rule_id).toBeNull();
  });

  it("filters listEvents by status", () => {
    store.createEvent(newEvent({ status: "scheduled" }));
    store.createEvent(newEvent({ status: "running" }));
    store.createEvent(newEvent({ status: "running" }));

    expect(store.listEvents()).toHaveLength(3);
    expect(store.listEvents({ status: "running" })).toHaveLength(2);
    expect(store.listEvents({ status: "done" })).toHaveLength(0);
  });

  it("applies a partial update and returns the refreshed row", () => {
    const ev = store.createEvent(newEvent());
    const updated = store.updateEvent(ev.id, { status: "done", mentions: ["/ship"] });
    expect(updated?.status).toBe("done");
    expect(updated?.mentions).toEqual(["/ship"]);
    // unchanged fields preserved
    expect(updated?.title).toBe(ev.title);
  });

  it("returns undefined for an unknown event id", () => {
    expect(store.getEvent("nope")).toBeUndefined();
    expect(store.updateEvent("nope", { status: "done" })).toBeUndefined();
  });
});

describe("Store: run", () => {
  it("creates with defaults, reads by id and by session", () => {
    const ev = store.createEvent(newEvent());
    const run = store.createRun(newRun(ev.id, { session_id: "sess-1" }));
    expect(run.transcript_offset).toBe(0); // default
    expect(run.transcript_path).toBeNull();

    expect(store.getRun(run.id)).toEqual(run);
    expect(store.getRunBySession("sess-1")).toEqual(run);
    expect(store.getRunBySession("missing")).toBeUndefined();
  });

  it("updates status and recording fields", () => {
    const ev = store.createEvent(newEvent());
    const run = store.createRun(newRun(ev.id));
    const updated = store.updateRun(run.id, {
      status: "done",
      exit_code: 0,
      minutes: "archived 30, flagged 3",
      transcript_offset: 4096,
    });
    expect(updated?.status).toBe("done");
    expect(updated?.exit_code).toBe(0);
    expect(updated?.minutes).toBe("archived 30, flagged 3");
    expect(updated?.transcript_offset).toBe(4096);
  });

  it("enforces the unique session_id constraint (watcher dedup)", () => {
    const ev = store.createEvent(newEvent());
    store.createRun(newRun(ev.id, { session_id: "dup" }));
    expect(() => store.createRun(newRun(ev.id, { session_id: "dup" }))).toThrow(/UNIQUE/i);
  });

  it("enforces the event_id foreign key", () => {
    expect(() => store.createRun(newRun("no-such-event"))).toThrow(/FOREIGN KEY/i);
  });
});

describe("pending launched-run correlation (codex)", () => {
  it("lists only running, role=run, pending-session runs for the given engine — oldest first", () => {
    const ev = store.createEvent(newEvent({ engine: "codex", cwd: "/work/x" }));
    const pendingA = store.createRun(
      newRun(ev.id, { engine: "codex", session_id: pendingSession("a"), started_at: "2026-01-01T00:00:01Z" }),
    );
    const pendingB = store.createRun(
      newRun(ev.id, { engine: "codex", session_id: pendingSession("b"), started_at: "2026-01-01T00:00:00Z" }),
    );
    // Excluded: a real (already-correlated) codex run, a done pending run, a summarizer, a claude pending.
    store.createRun(newRun(ev.id, { engine: "codex", session_id: "real-uuid" }));
    store.createRun(newRun(ev.id, { engine: "codex", session_id: pendingSession("done"), status: "done" }));
    store.createRun(newRun(ev.id, { engine: "codex", session_id: pendingSession("sum"), role: "summarizer" }));
    store.createRun(newRun(ev.id, { engine: "claude", session_id: pendingSession("claude") }));

    const pending = store.listPendingLaunchedRuns("codex");
    // Oldest started_at first → B before A.
    expect(pending.map((r) => r.id)).toEqual([pendingB.id, pendingA.id]);

    // The query is engine-scoped: asking for "claude" returns only the claude pending row,
    // never the codex ones. (In production the scheduler never creates claude pending rows —
    // claude pre-assigns its session id — so this list is empty in practice; the store method
    // itself just filters by the engine argument.)
    expect(store.listPendingLaunchedRuns("claude").map((r) => r.session_id)).toEqual([
      pendingSession("claude"),
    ]);
  });

  it("attachLaunchedRun backfills the real session id + transcript path/offset, dropping the placeholder", () => {
    const ev = store.createEvent(newEvent({ engine: "codex", cwd: "/work/x" }));
    const sentinel = pendingSession("xyz");
    const run = store.createRun(newRun(ev.id, { engine: "codex", session_id: sentinel }));

    const attached = store.attachLaunchedRun(run.id, "real-codex-uuid", "/codex/rollout.jsonl", 4096);

    expect(attached?.session_id).toBe("real-codex-uuid");
    expect(attached?.transcript_path).toBe("/codex/rollout.jsonl");
    expect(attached?.transcript_offset).toBe(4096);
    expect(store.getRunBySession("real-codex-uuid")?.id).toBe(run.id);
    expect(store.getRunBySession(sentinel)).toBeUndefined();
    // No longer pending after correlation.
    expect(store.listPendingLaunchedRuns("codex")).toHaveLength(0);
  });
});
