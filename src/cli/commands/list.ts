/**
 * `gregorian list` — show scheduled + recorded events on one timeline.
 *
 * Pulls `/events` and `/runs` from the daemon and renders an aligned table: when it fires, the engine,
 * the event status, and (from its latest run) the exit code + transcript path — the m1 recording-lite
 * fields. If the daemon is down the user gets a clear, actionable message, not a stack trace.
 */

import { daemonRequest } from "../../daemon/daemon.js";
import type { Event, Run } from "../../types.js";

/** Latest run for an event (runs arrive oldest-first), or undefined if it never fired. */
function latestRun(runs: Run[]): Run | undefined {
  return runs.length > 0 ? runs[runs.length - 1] : undefined;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function renderTable(events: Event[], runsByEvent: Map<string, Run[]>): string {
  const header = ["WHEN", "ENGINE", "STATUS", "EXIT", "TITLE", "TRANSCRIPT"];
  const rows = events.map((e) => {
    const run = latestRun(runsByEvent.get(e.id) ?? []);
    return [
      e.scheduled_at ?? "—",
      e.engine,
      e.status,
      run?.exit_code != null ? String(run.exit_code) : "—",
      e.title.length > 40 ? `${e.title.slice(0, 39)}…` : e.title,
      run?.transcript_path ?? "—",
    ];
  });

  // Column widths from header + all rows (last column left unpadded — long paths shouldn't add trailing space).
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
    process.stderr.write(`gregorian list: ${(err as Error).message}\n`);
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
