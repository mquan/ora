/**
 * The engine seam — gregorian's load-bearing contract.
 *
 * Every agent gregorian can launch or record (claude today, codex next, remote/API in v2)
 * hides behind {@link AgentEngine}. The daemon, watcher, and minutes pass speak only this
 * interface, so adding an engine means writing one adapter and touching zero core code
 * (design doc §"AgentEngine / RunHandle interface (M1)"). These types carry NO behavior —
 * the shared implementation lives in `./base`. Domain shapes (`Event`, `RunStatus`, …) come
 * from `../types`; they are not redefined here.
 */

import type { EngineKind, Event, RunStatus } from "../types.js";

/**
 * A pluggable agent engine. v1 ships only the local Claude adapter, but the contract forbids
 * any subprocess assumption so a v2 remote adapter drops in unchanged.
 */
export interface AgentEngine {
  /** Which engine this is — the discriminator the registry/daemon route on. */
  readonly id: EngineKind;

  /**
   * Launch a run for `event`, DETACHED (own process group, survives a daemon restart), and
   * return a pollable handle. Where the engine supports it, `opts.sessionId` is pre-assigned as
   * the transcript correlation key (claude's `--session-id`). When `opts.beforeSnapshot` is set
   * the base captures a git "before" tree so the run's `diff_stat` can be computed on exit.
   */
  start(event: Event, opts: StartOptions): Promise<RunHandle>;

  /**
   * Map this engine's transcript JSONL into the unified {@link TranscriptEvent} stream the
   * minutes pass (m2) consumes. Async-iterable so huge transcripts stream rather than load whole.
   */
  parseTranscript(path: string): AsyncIterable<TranscriptEvent>;

  /**
   * Absolute directories this engine writes transcripts under, for the watcher (m2) to subscribe.
   * e.g. claude → `~/.claude/projects`, codex → `~/.codex/sessions`.
   */
  transcriptRoots(): string[];
}

/** Inputs to {@link AgentEngine.start}. */
export interface StartOptions {
  /** Pre-assigned correlation key; the watcher joins the transcript to the run by this id. */
  sessionId: string;
  /** Capture a git "before" tree so `RunResult.diffStat` can be computed (launched runs only). */
  beforeSnapshot: boolean;
}

/**
 * A pollable handle to a launched run — NOT a subprocess. `result()` is the daemon-alive
 * convenience path (resolves when the child exits); the watcher independently drives
 * finalization by `sessionId`, so a run is never lost if the daemon dies mid-flight.
 */
export interface RunHandle {
  /** The correlation key this run was launched with. */
  readonly sessionId: string;
  /** Current lifecycle state. Flips from `running` to `done`/`failed` exactly once. */
  status(): RunStatus;
  /** Resolves when the run finishes. Never rejects and never hangs — a failed spawn resolves `failed`. */
  result(): Promise<RunResult>;
}

/** What {@link RunHandle.result} resolves to when a launched run finishes. */
export interface RunResult {
  sessionId: string;
  /** Process exit code; `null` when the process never started (spawn error) or was signalled. */
  exitCode: number | null;
  /** Resolved transcript path, or `null` if the engine could not resolve one. */
  transcriptPath: string | null;
  /** `git diff --stat` of the run's changes; `null` for non-repo cwds or when unavailable. */
  diffStat: string | null;
}

/** Coarse classification of a parsed transcript line. `unknown` keeps forward-compat lossless. */
export type TranscriptEventType =
  | "message"
  | "tool_use"
  | "tool_result"
  | "system"
  | "unknown";

/**
 * One normalized entry from a transcript, consumed by the minutes summarizer (m2/t7) and the
 * web viewer (m5). `raw` always carries the original JSONL object so no engine-specific field
 * is ever lost — new consumers can reach into `raw` without a contract change.
 */
export interface TranscriptEvent {
  type: TranscriptEventType;
  role?: "user" | "assistant" | "system";
  /** Flattened human-readable text, when the entry has any. */
  text?: string;
  /** Tool name for `tool_use`/`tool_result` entries. */
  toolName?: string;
  /** ISO timestamp, when the entry carries one. */
  timestamp?: string;
  /** The untouched source object for this transcript line. */
  raw: unknown;
}

/**
 * What a concrete engine returns from `buildSpawn` — the base turns this into a detached child.
 * Engines supply ONLY this (flags) plus transcript path resolution and parsing.
 */
export interface SpawnSpec {
  command: string;
  args: string[];
  /** Extra environment for the child; merged over `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * An opaque git "before" reference captured at launch. `ref` is a tree object SHA covering the
 * full working tree (tracked + untracked, minus gitignored), or `null` when `cwd` is not a git
 * repository — in which case `diffStat` later resolves to `null` rather than throwing.
 */
export interface GitSnapshot {
  cwd: string;
  ref: string | null;
}
