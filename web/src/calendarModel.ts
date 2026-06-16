/**
 * Pure calendar logic — NO React, NO DOM, NO ambient clock (every time-dependent function takes `now` as a
 * parameter), so it's deterministically unit-testable. This is the heart of "agent runs ARE calendar events":
 * it joins events↔runs into positioned blocks spanning past (recorded runs) and future (scheduled events) on
 * one surface.
 *
 * Item model (see task Decision 5): an event WITH started runs yields one block per run (start = run.started_at,
 * end = run.ended_at, or `now` while it's still running); an event with NO started run is placed at its
 * scheduled_at. Color derives from the run's status, or the event's status when there's no run yet.
 */

import type { GregorianEvent, Run } from "./types";

/** The visual status of a calendar block — drives its color. */
export type ItemStatus = "scheduled" | "running" | "done" | "failed" | "missed";

export interface CalendarItem {
  /** Stable key: the run id when run-backed, else the event id. */
  id: string;
  eventId: string;
  title: string;
  engine: string;
  start: Date;
  /** End of the block. For a still-running run this is `now` (the block grows until it finishes). */
  end: Date;
  status: ItemStatus;
  /** True while the backing run is in progress — the UI pulses these. */
  live: boolean;
  /** True when this block came from a scheduled event with no run yet (future / not-yet-fired). */
  scheduledOnly: boolean;
}

const MS_PER_DAY = 86_400_000;
const MIN_BLOCK_MS = 15 * 60_000; // floor so an instant/short run is still clickable

function parse(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Join events and runs into positioned calendar blocks. `runs` may be the global `/runs` list — we group by
 * `event_id` ourselves. Summarizer runs (gregorian's own minutes pass) are never shown.
 */
export function toCalendarItems(events: GregorianEvent[], runs: Run[], now: Date): CalendarItem[] {
  const runsByEvent = new Map<string, Run[]>();
  for (const run of runs) {
    if (run.role && run.role !== "run") continue;
    const list = runsByEvent.get(run.event_id);
    if (list) list.push(run);
    else runsByEvent.set(run.event_id, [run]);
  }

  const items: CalendarItem[] = [];
  for (const event of events) {
    const eventRuns = (runsByEvent.get(event.id) ?? []).filter((r) => parse(r.started_at) !== null);

    if (eventRuns.length > 0) {
      for (const run of eventRuns) {
        const start = parse(run.started_at)!;
        const live = run.status === "running";
        const ended = parse(run.ended_at);
        const end = live ? now : (ended ?? new Date(start.getTime() + MIN_BLOCK_MS));
        items.push({
          id: run.id,
          eventId: event.id,
          title: event.title,
          engine: event.engine,
          start,
          end: new Date(Math.max(end.getTime(), start.getTime() + MIN_BLOCK_MS)),
          status: runStatus(run.status),
          live,
          scheduledOnly: false,
        });
      }
      continue;
    }

    // No started run yet — place at the scheduled time if we have one (adhoc events with no run can't be placed).
    const scheduled = parse(event.scheduled_at);
    if (!scheduled) continue;
    items.push({
      id: event.id,
      eventId: event.id,
      title: event.title,
      engine: event.engine,
      start: scheduled,
      end: new Date(scheduled.getTime() + MIN_BLOCK_MS),
      status: eventStatus(event.status),
      live: event.status === "running",
      scheduledOnly: true,
    });
  }

  items.sort((a, b) => a.start.getTime() - b.start.getTime());
  return items;
}

function runStatus(s: Run["status"]): ItemStatus {
  return s; // running | done | failed are all valid ItemStatus values
}

function eventStatus(s: GregorianEvent["status"]): ItemStatus {
  return s; // scheduled | running | done | failed | missed
}

// ─── Date grid helpers (all local-time; `weekStartsOn` = 0 = Sunday, Google-Calendar US default) ───

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

export function startOfWeek(d: Date, weekStartsOn = 0): Date {
  const day = startOfDay(d);
  const diff = (day.getDay() - weekStartsOn + 7) % 7;
  return addDays(day, -diff);
}

/** The 7 day-starts of the week containing `anchor`. */
export function weekDays(anchor: Date, weekStartsOn = 0): Date[] {
  const start = startOfWeek(anchor, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** A 6×7 month grid (always 6 rows so the layout doesn't jump month to month). */
export function monthMatrix(anchor: Date, weekStartsOn = 0): Date[][] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridStart = startOfWeek(first, weekStartsOn);
  const weeks: Date[][] = [];
  for (let w = 0; w < 6; w++) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(gridStart, w * 7 + i)));
  }
  return weeks;
}

/** Fraction (0..1) of the way through the local day for a given instant. */
export function dayFraction(d: Date): number {
  return (d.getHours() * 60 + d.getMinutes()) / 1440;
}

/**
 * Top/height percentages for a block within a single day column, clamped to the day. A block that starts
 * before or ends after the day is clamped to [day, day+1) so multi-day/midnight-crossing blocks render sanely.
 */
export function blockPosition(
  item: { start: Date; end: Date },
  day: Date,
): { topPct: number; heightPct: number } {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + MS_PER_DAY;
  const start = Math.max(item.start.getTime(), dayStart);
  const end = Math.min(Math.max(item.end.getTime(), start + MIN_BLOCK_MS), dayEnd);
  const topPct = ((start - dayStart) / MS_PER_DAY) * 100;
  const heightPct = Math.max(((end - start) / MS_PER_DAY) * 100, (MIN_BLOCK_MS / MS_PER_DAY) * 100);
  return { topPct, heightPct };
}

/** Items that intersect `day` (by local calendar day of their start). */
export function itemsForDay(items: CalendarItem[], day: Date): CalendarItem[] {
  return items.filter((it) => sameDay(it.start, day));
}
