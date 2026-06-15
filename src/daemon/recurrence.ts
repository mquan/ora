/**
 * Recurrence materialization (design data-model + lifecycle, R4).
 *
 * A `recurrence_rule` is a template; each occurrence is its OWN one-off `event` (schedule_kind=once)
 * carrying a `recurrence_rule_id` back-link, so it appears as its own timeline item. This module rolls
 * the materialization horizon forward: the next 7 days OR next 10 occurrences (whichever is smaller)
 * per rule, IDEMPOTENTLY — an occurrence already present (same rule + scheduled_at) is never
 * duplicated, so it is safe to call on every boot and on a periodic tick.
 *
 * "Completing occurrence N writes only to N" is inherent in the data model: each occurrence is a
 * distinct event/run and recording a run never touches the rule template or sibling occurrences. We
 * assert that invariant in tests rather than enforcing it with new code.
 *
 * Deferred (per task scope): creating rules (CLI `--every` / a write route) is NOT built here — the
 * m5 web UI owns that surface. Materialization is built + wired + tested so the lifecycle is complete
 * and m5 can create rules against it. Tests create rules via the store directly.
 */

import { Cron } from "croner";

import type { Store } from "../store/store.js";
import { consoleLogger, type Logger, type Scheduler } from "./scheduler.js";

/** Rolling window: occurrences within the next 7 days are materialized… */
export const DEFAULT_WINDOW_DAYS = 7;
/** …but never more than the next 10 occurrences per rule — whichever bound is hit first. */
export const DEFAULT_MAX_OCCURRENCES = 10;

export interface MaterializeDeps {
  store: Store;
  /** When provided, each newly materialized occurrence is armed immediately (boot + tick). */
  scheduler?: Pick<Scheduler, "arm">;
  /** Anchor time for enumeration. */
  now: Date;
  windowDays?: number;
  maxOccurrences?: number;
  logger?: Logger;
}

export interface MaterializeSummary {
  created: number;
}

/** Idempotently materialize every recurrence rule's occurrences within the rolling window. */
export function materializeRecurrences(deps: MaterializeDeps): MaterializeSummary {
  const { store, scheduler, now } = deps;
  const logger = deps.logger ?? consoleLogger;
  const windowDays = deps.windowDays ?? DEFAULT_WINDOW_DAYS;
  const maxOccurrences = deps.maxOccurrences ?? DEFAULT_MAX_OCCURRENCES;
  const horizonMs = now.getTime() + windowDays * 24 * 60 * 60 * 1000;

  let created = 0;
  for (const rule of store.listRecurrenceRules()) {
    try {
      const occurrences = nextOccurrences(rule.cron_spec, now, maxOccurrences, horizonMs);
      if (occurrences.length === 0) continue;

      const existing = new Set(
        store
          .listEventsByRule(rule.id)
          .map((e) => e.scheduled_at)
          .filter((s): s is string => s !== null),
      );
      for (const when of occurrences) {
        const iso = when.toISOString();
        if (existing.has(iso)) continue; // already materialized — never duplicate
        const event = store.createEvent({
          title: titleForRule(rule.prompt),
          engine: rule.engine,
          model: rule.model,
          cwd: rule.cwd,
          prompt: rule.prompt,
          mentions: rule.mentions,
          schedule_kind: "once",
          scheduled_at: iso,
          recurrence_rule_id: rule.id,
          status: "scheduled",
        });
        existing.add(iso);
        scheduler?.arm(event);
        created += 1;
      }
    } catch (err) {
      // A malformed cron_spec (or any per-rule failure) is logged + skipped — never aborts the pass.
      logger.error(
        `recurrence: rule ${rule.id} (${rule.cron_spec}) failed to materialize: ${(err as Error).message}`,
      );
    }
  }
  if (created > 0) logger.log(`recurrence: materialized ${created} new occurrence(s)`);
  return { created };
}

/**
 * Enumerate the next occurrences of `cronSpec` strictly after `now`, capped at `max` and bounded by
 * `horizonMs` (whichever is smaller). Uses a PAUSED croner job purely for enumeration and stops it
 * immediately so it never arms a real timer.
 */
function nextOccurrences(cronSpec: string, now: Date, max: number, horizonMs: number): Date[] {
  const cron = new Cron(cronSpec, { paused: true });
  try {
    const runs = cron.nextRuns(max, now);
    return runs.filter((d) => d.getTime() <= horizonMs);
  } finally {
    cron.stop();
  }
}

/** A human-skimmable title for a materialized occurrence (event.title is NOT NULL). */
function titleForRule(prompt: string): string {
  const firstLine = prompt.split("\n")[0]?.trim() ?? "";
  if (firstLine.length === 0) return "recurring run";
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}
