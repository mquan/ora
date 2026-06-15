/**
 * Shared CLI formatting helpers — kept in one place (A-DRY) so `list` and `show` render the same
 * values identically.
 */

/**
 * Human-readable duration between two ISO timestamps, e.g. `420ms`, `1.4s`, `2m 3s`, `1h 5m`. Returns
 * `—` when either bound is missing (a run that never started/finished) or the values don't parse.
 */
export function formatDuration(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt || !endedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "—";

  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

/** A short, stable id prefix for display (the user passes a prefix to `gregorian show`). */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Collapse newlines + clip a string so it fits one table cell. */
export function clipInline(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
