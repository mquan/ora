import { describe, it, expect } from "vitest";
import {
  toCalendarItems,
  blockPosition,
  weekDays,
  monthMatrix,
  startOfWeek,
  sameDay,
} from "./calendarModel";
import type { OraEvent, Run } from "./types";

function event(over: Partial<OraEvent> = {}): OraEvent {
  return {
    id: "e1",
    title: "nightly tidy",
    engine: "claude",
    model: null,
    cwd: "/tmp/x",
    prompt: "tidy up",
    mentions: null,
    schedule_kind: "once",
    scheduled_at: "2026-06-16T09:00:00.000Z",
    recurrence_rule_id: null,
    status: "scheduled",
    created_at: "2026-06-16T08:00:00.000Z",
    ...over,
  };
}

function run(over: Partial<Run> = {}): Run {
  return {
    id: "r1",
    event_id: "e1",
    engine: "claude",
    session_id: "s1",
    role: "run",
    transcript_path: null,
    started_at: "2026-06-16T09:00:00.000Z",
    ended_at: "2026-06-16T09:30:00.000Z",
    exit_code: 0,
    diff_stat: null,
    minutes: null,
    status: "done",
    error: null,
    ...over,
  };
}

const NOW = new Date("2026-06-16T12:00:00.000Z");

describe("toCalendarItems", () => {
  it("places a done run at its start/end with done status", () => {
    const items = toCalendarItems([event()], [run()], NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "r1",
      eventId: "e1",
      status: "done",
      live: false,
      scheduledOnly: false,
    });
    expect(items[0].start.toISOString()).toBe("2026-06-16T09:00:00.000Z");
    expect(items[0].end.toISOString()).toBe("2026-06-16T09:30:00.000Z");
  });

  it("extends a running run to `now` and marks it live", () => {
    const items = toCalendarItems([event({ status: "running" })], [run({ status: "running", ended_at: null })], NOW);
    expect(items[0].live).toBe(true);
    expect(items[0].status).toBe("running");
    expect(items[0].end.toISOString()).toBe(NOW.toISOString());
  });

  it("emits one block per started run for a multi-run event", () => {
    const runs = [
      run({ id: "r1", started_at: "2026-06-15T09:00:00.000Z", ended_at: "2026-06-15T09:10:00.000Z" }),
      run({ id: "r2", started_at: "2026-06-16T09:00:00.000Z", ended_at: "2026-06-16T09:10:00.000Z" }),
    ];
    const items = toCalendarItems([event()], runs, NOW);
    expect(items.map((i) => i.id)).toEqual(["r1", "r2"]); // sorted by start
  });

  it("places a not-yet-run scheduled event at scheduled_at (scheduledOnly)", () => {
    const items = toCalendarItems([event({ status: "scheduled" })], [], NOW);
    expect(items[0]).toMatchObject({ id: "e1", status: "scheduled", scheduledOnly: true });
    expect(items[0].start.toISOString()).toBe("2026-06-16T09:00:00.000Z");
  });

  it("carries a missed event's status onto the block", () => {
    const items = toCalendarItems([event({ status: "missed" })], [], NOW);
    expect(items[0].status).toBe("missed");
  });

  it("ignores summarizer runs (ora's own minutes pass)", () => {
    const items = toCalendarItems([event()], [run({ role: "summarizer" })], NOW);
    // No `run`-role run started → falls back to the scheduled placement, not the summarizer.
    expect(items[0].scheduledOnly).toBe(true);
  });

  it("skips an adhoc event with no scheduled_at and no started run", () => {
    const items = toCalendarItems(
      [event({ schedule_kind: "adhoc", scheduled_at: null, status: "scheduled" })],
      [],
      NOW,
    );
    expect(items).toHaveLength(0);
  });

  it("places an adhoc event at its run's start", () => {
    const items = toCalendarItems(
      [event({ schedule_kind: "adhoc", scheduled_at: null, status: "done" })],
      [run()],
      NOW,
    );
    expect(items[0].start.toISOString()).toBe("2026-06-16T09:00:00.000Z");
    expect(items[0].scheduledOnly).toBe(false);
  });

  it("treats a run with a null started_at as not-yet-placed", () => {
    const items = toCalendarItems([event({ status: "scheduled" })], [run({ started_at: null, status: "running" })], NOW);
    expect(items[0].scheduledOnly).toBe(true); // falls back to scheduled placement
  });
});

describe("blockPosition", () => {
  it("computes top/height for a 1-hour block at 09:00 local", () => {
    const day = new Date(2026, 5, 16);
    const start = new Date(2026, 5, 16, 9, 0);
    const end = new Date(2026, 5, 16, 10, 0);
    const { topPct, heightPct } = blockPosition({ start, end }, day);
    expect(topPct).toBeCloseTo((9 / 24) * 100, 5);
    expect(heightPct).toBeCloseTo((1 / 24) * 100, 5);
  });

  it("enforces a minimum height for an instant block", () => {
    const day = new Date(2026, 5, 16);
    const at = new Date(2026, 5, 16, 9, 0);
    const { heightPct } = blockPosition({ start: at, end: at }, day);
    expect(heightPct).toBeGreaterThan(0);
    expect(heightPct).toBeCloseTo((15 / 1440) * 100, 5); // 15-min floor
  });

  it("clamps a block that runs past midnight to the day", () => {
    const day = new Date(2026, 5, 16);
    const start = new Date(2026, 5, 16, 23, 0);
    const end = new Date(2026, 5, 17, 2, 0);
    const { topPct, heightPct } = blockPosition({ start, end }, day);
    expect(topPct).toBeCloseTo((23 / 24) * 100, 5);
    expect(topPct + heightPct).toBeLessThanOrEqual(100.0001);
  });
});

describe("date grid helpers", () => {
  it("weekDays returns 7 consecutive days starting Sunday", () => {
    const days = weekDays(new Date(2026, 5, 16)); // Tue Jun 16 2026
    expect(days).toHaveLength(7);
    expect(days[0].getDay()).toBe(0); // Sunday
    expect(sameDay(days[2], new Date(2026, 5, 16))).toBe(true); // Tue is index 2
  });

  it("startOfWeek lands on Sunday", () => {
    expect(startOfWeek(new Date(2026, 5, 16)).getDay()).toBe(0);
  });

  it("monthMatrix is always 6 rows of 7", () => {
    const m = monthMatrix(new Date(2026, 5, 1));
    expect(m).toHaveLength(6);
    expect(m.every((w) => w.length === 7)).toBe(true);
  });
});
