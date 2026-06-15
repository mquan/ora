/**
 * Recurrence materialization tests (R4). A `recurrence_rule` is a template; each occurrence is its own
 * one-off `event` carrying a `recurrence_rule_id`. These tests prove the rolling-window enumeration,
 * idempotent re-materialization (safe on every boot + tick), the 7d/10-occurrence caps, and the
 * data-model invariant "completing occurrence N writes ONLY to N".
 *
 * Deterministic by construction: a fixed `now`, an every-minute cron (so occurrence counts are
 * timezone-independent), a real {@link Store} on a tmp db, and NO scheduler (materialization is what's
 * under test; arming is covered in daemon.test).
 */

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Store } from "../store/store.js";
import { materializeRecurrences } from "./recurrence.js";
import type { NewRecurrenceRule } from "../types.js";

const silent = { log: () => {}, error: () => {} };

/** :30s past the minute so the next every-minute fires land cleanly at :00 (no boundary flakiness). */
const NOW = new Date("2026-07-01T12:00:30.000Z");
/** A 5-minute window expressed in days — the WINDOW bound, distinct from the occurrence cap. */
const FIVE_MIN_DAYS = 5 / (24 * 60);

let dbPath: string;
let store: Store;

beforeEach(() => {
  dbPath = join(tmpdir(), `greg-recur-${randomUUID()}.db`);
  store = new Store(dbPath);
});

afterEach(() => {
  store.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
  }
});

const newRule = (over: Partial<NewRecurrenceRule> = {}): NewRecurrenceRule => ({
  cron_spec: "* * * * *", // every minute — count within a window is timezone-independent
  engine: "claude",
  cwd: "/work/repo",
  prompt: "tick",
  ...over,
});

describe("materializeRecurrences", () => {
  it("creates one occurrence event per fire within the rolling window", () => {
    const rule = store.createRecurrenceRule(newRule());

    const summary = materializeRecurrences({
      store,
      now: NOW,
      windowDays: FIVE_MIN_DAYS, // 5-minute horizon → 5 every-minute fires (12:01..12:05)
      logger: silent,
    });

    expect(summary.created).toBe(5);
    const occurrences = store.listEventsByRule(rule.id);
    expect(occurrences).toHaveLength(5);
    // Each occurrence is its own one-off event back-linked to the rule.
    for (const e of occurrences) {
      expect(e.schedule_kind).toBe("once");
      expect(e.recurrence_rule_id).toBe(rule.id);
      expect(e.status).toBe("scheduled");
      expect(e.prompt).toBe("tick");
      expect(new Date(e.scheduled_at!).getTime()).toBeLessThanOrEqual(
        NOW.getTime() + 5 * 60_000,
      );
      expect(new Date(e.scheduled_at!).getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it("is idempotent — a second pass at the same `now` creates no duplicates", () => {
    const rule = store.createRecurrenceRule(newRule());

    const first = materializeRecurrences({ store, now: NOW, windowDays: FIVE_MIN_DAYS, logger: silent });
    const second = materializeRecurrences({ store, now: NOW, windowDays: FIVE_MIN_DAYS, logger: silent });

    expect(first.created).toBe(5);
    expect(second.created).toBe(0);
    expect(store.listEventsByRule(rule.id)).toHaveLength(5);
  });

  it("respects the 10-occurrence cap when the window would allow more", () => {
    store.createRecurrenceRule(newRule());

    // A 7-day window holds thousands of every-minute fires, so the max-occurrence cap binds first.
    const summary = materializeRecurrences({
      store,
      now: NOW,
      windowDays: 7,
      maxOccurrences: 10,
      logger: silent,
    });

    expect(summary.created).toBe(10);
  });

  it("skips a malformed cron_spec without aborting other rules (zero silent failure)", () => {
    const bad = store.createRecurrenceRule(newRule({ cron_spec: "not a cron" }));
    const good = store.createRecurrenceRule(newRule());

    const summary = materializeRecurrences({
      store,
      now: NOW,
      windowDays: FIVE_MIN_DAYS,
      logger: silent,
    });

    expect(store.listEventsByRule(bad.id)).toHaveLength(0); // bad rule produced nothing…
    expect(store.listEventsByRule(good.id)).toHaveLength(5); // …but the good rule still materialized
    expect(summary.created).toBe(5);
  });

  it("completing occurrence N writes ONLY to N — the rule template and siblings are untouched", () => {
    const rule = store.createRecurrenceRule(newRule());
    materializeRecurrences({ store, now: NOW, windowDays: FIVE_MIN_DAYS, logger: silent });

    const occurrences = store.listEventsByRule(rule.id);
    expect(occurrences).toHaveLength(5);
    const target = occurrences[2]!; // the middle occurrence "completes"

    // Record + finalize a run on occurrence N only.
    const run = store.createRun({
      event_id: target.id,
      engine: "claude",
      session_id: randomUUID(),
      role: "run",
      status: "running",
      started_at: NOW.toISOString(),
    });
    store.updateRun(run.id, { status: "done", ended_at: NOW.toISOString(), minutes: "did the tick" });
    store.updateEvent(target.id, { status: "done" });

    // The rule template is unchanged…
    const ruleAfter = store.getRecurrenceRule(rule.id)!;
    expect(ruleAfter.cron_spec).toBe("* * * * *");
    expect(ruleAfter.prompt).toBe("tick");

    // …and every sibling occurrence is still scheduled with no run of its own.
    for (const sib of occurrences.filter((e) => e.id !== target.id)) {
      expect(store.getEvent(sib.id)!.status).toBe("scheduled");
      expect(store.listRunsByEvent(sib.id)).toHaveLength(0);
    }
    // Only occurrence N has the completed run.
    expect(store.listRunsByEvent(target.id)).toHaveLength(1);
    expect(store.getEvent(target.id)!.status).toBe("done");
  });
});
