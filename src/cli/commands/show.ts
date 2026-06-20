/**
 * `ora show <id>` — detail view for one event + its run(s) (R7).
 *
 * Resolves <id> as a unique EVENT-id prefix (the `list` table shows the short id), fetches the event +
 * runs from the daemon (`GET /events/:id`), and renders: status, scheduled/started/ended times,
 * duration, exit code, the FULL error reason, the transcript path, and the FULL minutes. This is the
 * display home for the minutes (the summarizer had no surface until now) and the failure reason. If the
 * daemon is down or the id is unknown/ambiguous, the user gets a clear message, not a stack trace.
 */

import { daemonRequest, DaemonNotRunningError } from "../../daemon/daemon.js";
import { formatDuration, shortId } from "../format.js";
import type { Event, Run } from "../../types.js";

/** The latest user-facing run (role=run), or undefined if the event never ran. */
function latestRun(runs: Run[]): Run | undefined {
  const visible = runs.filter((r) => r.role === "run");
  return visible.length > 0 ? visible[visible.length - 1] : undefined;
}

/** Render the detail block. Pure (no I/O) so it is unit-tested directly. */
export function renderDetail(event: Event, runs: Run[]): string {
  const run = latestRun(runs);
  const lines: string[] = [];
  const field = (label: string, value: string): void => {
    lines.push(`${label.padEnd(12)} ${value}`);
  };

  field("id", event.id);
  field("title", event.title);
  field("engine", event.model ? `${event.engine} (${event.model})` : event.engine);
  field("status", event.status);
  field("cwd", event.cwd);
  field("scheduled", event.scheduled_at ?? "—");
  field("started", run?.started_at ?? "—");
  field("ended", run?.ended_at ?? "—");
  field("duration", run ? formatDuration(run.started_at, run.ended_at) : "—");
  field("exit code", run?.exit_code != null ? String(run.exit_code) : "—");
  field("transcript", run?.transcript_path ?? "—");
  if (event.prompt) field("prompt", event.prompt);

  if (run?.correlation === "ambiguous") {
    lines.push(
      "",
      "⚠ correlation: ambiguous — ≥2 concurrent same-cwd launches were awaiting a transcript; this " +
        "run's attribution is best-effort (FIFO) and could be swapped with a sibling run.",
    );
  }
  if (run?.error) {
    lines.push("", "error:", run.error);
  }
  lines.push("", "minutes:", run?.minutes ?? "(none generated)");

  return lines.join("\n");
}

export async function showCommand(args: string[]): Promise<number> {
  const idArg = args[0];
  if (!idArg) {
    process.stderr.write("ora show: an event id (or unique prefix) is required\n");
    return 1;
  }

  let events: Event[];
  try {
    ({ events } = await daemonRequest<{ events: Event[] }>("/events"));
  } catch (err) {
    process.stderr.write(
      `ora show: ${err instanceof DaemonNotRunningError ? err.message : (err as Error).message}\n`,
    );
    return 1;
  }

  // Resolve the prefix: prefer an exact id match (a full id is also a prefix of itself).
  const matches = events.filter((e) => e.id === idArg || e.id.startsWith(idArg));
  const exact = matches.find((e) => e.id === idArg);
  const resolved = exact ?? (matches.length === 1 ? matches[0] : undefined);
  if (!resolved) {
    if (matches.length === 0) {
      process.stderr.write(`ora show: no event matching '${idArg}'\n`);
    } else {
      const ids = matches.map((e) => shortId(e.id)).join(", ");
      process.stderr.write(
        `ora show: '${idArg}' is ambiguous (${ids}) — use more characters\n`,
      );
    }
    return 1;
  }

  let detail: { event: Event; runs: Run[] };
  try {
    detail = await daemonRequest<{ event: Event; runs: Run[] }>(
      `/events/${encodeURIComponent(resolved.id)}`,
    );
  } catch (err) {
    process.stderr.write(`ora show: ${(err as Error).message}\n`);
    return 1;
  }

  process.stdout.write(renderDetail(detail.event, detail.runs) + "\n");
  return 0;
}
