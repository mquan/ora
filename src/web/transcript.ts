/**
 * Reads a run's transcript into the normalized {@link TranscriptEvent} array the web viewer renders
 * (the transcript/minutes viewer ships in a later task; this is its data source). It reuses the engine
 * seam — `resolveEngine(run.engine).parseTranscript(path)` — so it never re-implements per-engine JSONL
 * parsing and a new engine is supported for free.
 *
 * No silent failures (design HOLD-SCOPE): every degraded case returns a 200-shaped result with a named
 * `reason` instead of throwing — null transcript path, a deleted file, a corrupt/partial JSONL line, or
 * an engine that isn't implemented yet. The HTTP layer reserves 404 for an unknown run id only.
 *
 * Bounded memory: parsing stops at {@link DEFAULT_MAX_ENTRIES} entries OR {@link DEFAULT_MAX_BYTES} of
 * accumulated content, whichever comes first, and sets `truncated`. A pathological transcript can never
 * exhaust the daemon — matching the minutes summarizer's constant-memory stance.
 */

import { statSync } from "node:fs";

import type { Run } from "../types.js";
import type { EngineResolver } from "../daemon/scheduler.js";
import type { TranscriptEvent } from "../engines/types.js";

/** Hard caps so one huge transcript can't exhaust daemon memory. */
export const DEFAULT_MAX_ENTRIES = 5000;
export const DEFAULT_MAX_BYTES = 5_000_000;

/** What the transcript route returns. Every field is always present except the optional `reason`. */
export interface TranscriptResult {
  /** The transcript file path, or `null` when the run never produced one. */
  path: string | null;
  /** Size of the transcript file on disk in bytes, or `0` when there is no readable file. */
  byteSize: number;
  /** Parsed, normalized entries (possibly truncated — see `truncated`). */
  entries: TranscriptEvent[];
  /** `true` when the caps cut parsing short, or a parse error stopped it mid-stream. */
  truncated: boolean;
  /** Present only on a degraded read — a named, human-readable explanation (never silent). */
  reason?: string;
}

export interface ReadTranscriptOptions {
  maxEntries?: number;
  maxBytes?: number;
}

/** Best-effort on-disk size; `0` if the file is missing/unreadable. */
function fileByteSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Read + normalize a run's transcript. Pure data access — the HTTP layer wraps the JSON envelope and
 * status code around this. Never throws for an expected degraded state.
 */
export async function readRunTranscript(
  run: Run,
  resolveEngine: EngineResolver,
  opts: ReadTranscriptOptions = {},
): Promise<TranscriptResult> {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const path = run.transcript_path;
  if (!path) {
    return { path: null, byteSize: 0, entries: [], truncated: false, reason: "no transcript recorded" };
  }

  const byteSize = fileByteSize(path);

  // The engine might not be implemented yet (e.g. a codex run before that adapter lands). Resolving is
  // the only step that can legitimately throw for a "known" run, so guard it explicitly.
  let engine;
  try {
    engine = resolveEngine(run.engine);
  } catch {
    return { path, byteSize, entries: [], truncated: false, reason: `engine '${run.engine}' not available` };
  }

  const entries: TranscriptEvent[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for await (const event of engine.parseTranscript(path)) {
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      entries.push(event);
      bytes += Buffer.byteLength(JSON.stringify(event));
      if (bytes >= maxBytes) {
        truncated = true;
        break;
      }
    }
  } catch (err) {
    // A deleted file (ENOENT) or a corrupt JSONL line surfaces here. Return whatever parsed so far with
    // a named reason — never a 500, never fabricated content.
    const code = (err as NodeJS.ErrnoException)?.code;
    const reason =
      code === "ENOENT"
        ? "transcript file not found"
        : `transcript could not be fully read (${(err as Error).message})`;
    return { path, byteSize, entries, truncated: true, reason };
  }

  return { path, byteSize, entries, truncated };
}
