/**
 * CLI render tests (R5 list + R7 show). Both render functions are pure (no daemon I/O), so they are
 * unit-tested directly. Covers: `show`'s detail block (duration, exit code, full error, full minutes),
 * and `list`'s table (the new ID + DUR + short-ERROR columns, and that the internal `role=summarizer`
 * guard run is filtered out of the displayed run).
 */

import { describe, expect, it } from "vitest";

import { renderDetail } from "./commands/show.js";
import { renderTable } from "./commands/list.js";
import type { Event, Run } from "../types.js";

const START = "2026-07-01T12:00:00.000Z";
const END = "2026-07-01T12:00:03.000Z"; // +3s → DUR "3.0s"

function mkEvent(over: Partial<Event> = {}): Event {
  return {
    id: "abcdef1234567890",
    title: "list files",
    engine: "claude",
    model: null,
    cwd: "/work/repo",
    prompt: "list files",
    mentions: null,
    schedule_kind: "once",
    scheduled_at: START,
    recurrence_rule_id: null,
    status: "done",
    created_at: START,
    ...over,
  };
}

function mkRun(over: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    event_id: "abcdef1234567890",
    engine: "claude",
    session_id: "sess-1",
    role: "run",
    transcript_path: "/home/me/.claude/projects/-work-repo/sess-1.jsonl",
    transcript_offset: 100,
    started_at: START,
    ended_at: END,
    exit_code: 0,
    diff_stat: null,
    minutes: null,
    status: "done",
    error: null,
    correlation: null,
    ...over,
  };
}

describe("renderDetail (ora show)", () => {
  it("renders duration, exit code, and the full minutes for a completed run", () => {
    const event = mkEvent();
    const run = mkRun({ minutes: "The agent listed the files and changed nothing." });

    const out = renderDetail(event, [run]);

    expect(out).toContain("duration     3.0s");
    expect(out).toContain("exit code    0");
    expect(out).toContain("transcript   /home/me/.claude/projects/-work-repo/sess-1.jsonl");
    expect(out).toContain("minutes:");
    expect(out).toContain("The agent listed the files and changed nothing.");
  });

  it("renders the FULL error reason for a failed run", () => {
    const event = mkEvent({ status: "failed" });
    const run = mkRun({
      status: "failed",
      exit_code: null,
      minutes: null,
      error: "interrupted: daemon restarted and the transcript was not found",
    });

    const out = renderDetail(event, [run]);

    expect(out).toContain("error:");
    expect(out).toContain("interrupted: daemon restarted and the transcript was not found");
    expect(out).toContain("(none generated)"); // no minutes
  });

  it("shows placeholders when the event never ran", () => {
    const out = renderDetail(mkEvent({ status: "scheduled" }), []);
    expect(out).toContain("duration     —");
    expect(out).toContain("exit code    —");
    expect(out).toContain("(none generated)");
  });

  it("surfaces an ambiguous-correlation warning, and omits it for a normal run", () => {
    const event = mkEvent();
    const flagged = renderDetail(event, [mkRun({ correlation: "ambiguous" })]);
    expect(flagged).toContain("correlation: ambiguous");

    const normal = renderDetail(event, [mkRun({ correlation: null })]);
    expect(normal).not.toContain("correlation: ambiguous");
  });

  it("prefers the role=run run and ignores the summarizer guard run", () => {
    const event = mkEvent();
    const real = mkRun({ minutes: "real minutes here" });
    const guard = mkRun({ id: "guard-1", role: "summarizer", minutes: "SHOULD NOT SHOW" });

    const out = renderDetail(event, [real, guard]);

    expect(out).toContain("real minutes here");
    expect(out).not.toContain("SHOULD NOT SHOW");
  });
});

describe("renderTable (ora list)", () => {
  it("has the ID + DUR + EXIT + NOTES columns and renders the run's duration", () => {
    const event = mkEvent();
    const map = new Map<string, Run[]>([[event.id, [mkRun()]]]);

    const out = renderTable([event], map);
    const [header, row] = out.split("\n");

    for (const col of ["ID", "WHEN", "ENGINE", "STATUS", "DUR", "EXIT", "TITLE", "NOTES"]) {
      expect(header).toContain(col);
    }
    expect(row).toContain("abcdef12"); // 8-char short id
    expect(row).toContain("3.0s"); // duration
  });

  it("flags an ambiguous-correlation run in the NOTES column", () => {
    const event = mkEvent();
    const map = new Map<string, Run[]>([[event.id, [mkRun({ correlation: "ambiguous" })]]]);

    const row = renderTable([event], map).split("\n")[1]!;
    expect(row).toContain("ambiguous correlation");
  });

  it("filters the summarizer guard run — the displayed run is the role=run", () => {
    const event = mkEvent();
    const real = mkRun({ exit_code: 0, status: "done" });
    const guard = mkRun({ id: "guard-1", role: "summarizer", exit_code: 0 });
    const map = new Map<string, Run[]>([[event.id, [real, guard]]]);

    const out = renderTable([event], map);
    const row = out.split("\n")[1]!;

    // The duration comes from the real run; the table renders one data row, not the guard.
    expect(out.split("\n")).toHaveLength(2);
    expect(row).toContain("3.0s");
  });

  it("shows a short (clipped) error for a failed run", () => {
    const event = mkEvent({ status: "failed" });
    const longError = "engine start failed: spawn claude ENOENT in a very long directory path that overflows";
    const map = new Map<string, Run[]>([
      [event.id, [mkRun({ status: "failed", exit_code: null, error: longError })]],
    ]);

    const out = renderTable([event], map);
    const row = out.split("\n")[1]!;

    expect(row).toContain("engine start failed"); // the head of the reason is visible
    expect(row).toContain("…"); // …and it was clipped to fit the cell
  });
});
