/**
 * `ora list` — show scheduled + recorded events on one timeline.
 *
 * Pulls `/events` and `/runs` from the daemon and renders an aligned table: a short id (to address
 * `ora show`), when it fires, the engine, the event status, the run DURATION + exit code, the
 * title, and a NOTES column carrying a SHORT failure reason and/or the ambiguous-correlation flag
 * (codex same-cwd concurrency). The full transcript path, full error, and minutes live in
 * `ora show <id>`. If the daemon is down the user gets a clear, actionable message, not a stack trace.
 */

import { daemonRequest } from "../../daemon/daemon.js";
import { clipInline, formatDuration, shortId } from "../format.js";
import type { Event, Run } from "../../types.js";

/**
 * Latest user-facing run for an event. Filters to `role='run'` so the internal `role='summarizer'`
 * guard run (ora's own minutes pass) never shows up as the event's run.
 */
function latestRun(runs: Run[]): Run | undefined {
  const visible = runs.filter((r) => r.role === "run");
  return visible.length > 0 ? visible[visible.length - 1] : undefined;
}

/**
 * The NOTES cell: the catch-all "what to know about this run" column. Carries the ambiguous-correlation
 * flag (codex same-cwd concurrency — attribution is best-effort) and/or a SHORT failure reason. Both can
 * be present at once. `—` when the run is clean.
 */
function notesCell(run: Run | undefined): string {
  if (!run) return "—";
  const notes: string[] = [];
  if (run.correlation === "ambiguous") notes.push("⚠ ambiguous correlation");
  if (run.error) notes.push(clipInline(run.error, 40));
  return notes.length > 0 ? notes.join(" · ") : "—";
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** Render the timeline table. Pure (no I/O) so it is unit-tested directly. */
export function renderTable(events: Event[], runsByEvent: Map<string, Run[]>): string {
  const header = ["ID", "WHEN", "ENGINE", "STATUS", "DUR", "EXIT", "TITLE", "NOTES"];
  const rows = events.map((e) => {
    const run = latestRun(runsByEvent.get(e.id) ?? []);
    return [
      shortId(e.id),
      e.scheduled_at ?? "—",
      e.engine,
      e.status,
      run ? formatDuration(run.started_at, run.ended_at) : "—",
      run?.exit_code != null ? String(run.exit_code) : "—",
      clipInline(e.title, 40),
      notesCell(run),
    ];
  });

  // Column widths from header + all rows (last column left unpadded — long text shouldn't add trailing space).
  const widths = header.map((h, col) =>
    Math.max(h.length, ...rows.map((r) => (r[col] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((c, col) => (col === cells.length - 1 ? c : pad(c, widths[col] ?? 0)))
      .join("  ")
      .trimEnd();

  return [line(header), ...rows.map(line)].join("\n");
}

export async function listCommand(): Promise<number> {
  let events: Event[];
  let runs: Run[];
  try {
    ({ events } = await daemonRequest<{ events: Event[] }>("/events"));
    ({ runs } = await daemonRequest<{ runs: Run[] }>("/runs"));
  } catch (err) {
    process.stderr.write(`ora list: ${(err as Error).message}\n`);
    return 1;
  }

  if (events.length === 0) {
    process.stdout.write("No events scheduled.\n");
    return 0;
  }

  const runsByEvent = new Map<string, Run[]>();
  for (const run of runs) {
    const bucket = runsByEvent.get(run.event_id) ?? [];
    bucket.push(run);
    runsByEvent.set(run.event_id, bucket);
  }

  process.stdout.write(renderTable(events, runsByEvent) + "\n");
  return 0;
}
