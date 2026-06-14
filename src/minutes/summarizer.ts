/**
 * Minutes summarizer (design §A3) — turns a finished run's transcript + git diff into a short,
 * factual "minutes" record a human can skim later.
 *
 * Mechanism: condense the engine-agnostic {@link TranscriptEvent} stream + the diff stat into a
 * bounded prompt, then spawn `claude --session-id <SUMM-uuid> -p <prompt>` capturing STDOUT — this
 * reuses the user's existing CLI login (no `ANTHROPIC_API_KEY`, the OSS-onboarding bet). Unlike the
 * RUN engines (which spawn detached and treat the on-disk transcript as the record of truth), the
 * summarizer needs the printed result, so it captures stdout and waits.
 *
 * Self-ingestion guard: the summarizer's own `claude -p` ALSO writes a transcript. This module does
 * not touch the watcher; it merely returns the `sessionId` it used so the daemon (t8) can register
 * that id as `role=summarizer` and have the watcher skip it (no run row). Pass `opts.sessionId` to
 * make registration race-free (register BEFORE spawning); otherwise one is generated and returned.
 *
 * No fabricated minutes (design edge case 4): an empty/unusable transcript or blank model output
 * yields `ok:false` with `minutes:null` and a surfaced reason — never invented text. A transcript
 * that has content is summarized even if the underlying run exited non-zero ("minutes generate from
 * whatever transcript exists"); the caller decides the run's own status.
 *
 * Everything is bounded (prompt budget, per-line cap, diff cap, error cap, timeout) and the
 * transcript is consumed as a stream with head/tail retention, so memory stays constant regardless
 * of transcript size. The `claude` spawn sits behind the {@link ClaudeRunner} seam so unit tests
 * stub it deterministically; a gated `[EVAL]` test exercises the real binary for minutes quality.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { EngineKind } from "../types.js";
import type { TranscriptEvent } from "../engines/types.js";

/** Total character budget for the condensed transcript inside the minutes prompt. */
export const MAX_MINUTES_PROMPT_CHARS = 12_000;
/** Per-line cap when rendering a single transcript event into the condensed view. */
export const MAX_LINE_CHARS = 500;
/** Cap on how much of the diff stat we inline into the prompt (a pathological stat can't blow it). */
export const MAX_DIFF_CHARS = MAX_LINE_CHARS * 4;
/** Cap on the surfaced `error` string so a runaway stderr never bloats the result. */
export const MAX_ERROR_CHARS = 2_000;
/** Hard timeout for the summarizer's `claude -p` pass — a hung child must never hang the daemon. */
export const SUMMARIZER_TIMEOUT_MS = 120_000;

/** Inputs to {@link summarize}. Engine-agnostic: the caller supplies a parsed transcript stream. */
export interface SummarizeInput {
  /** The run's transcript, e.g. `engine.parseTranscript(path)`. Consumed once, as a stream. */
  transcript: AsyncIterable<TranscriptEvent>;
  /** `git diff --stat` of the run's changes; `null` when unavailable (ad-hoc / non-repo cwd). */
  diffStat: string | null;
  /** What the agent was asked to do, for grounding the minutes. `null` for ad-hoc runs. */
  prompt?: string | null;
  /** The run's working directory, included as context in the prompt. */
  cwd?: string;
  /** The engine that produced the transcript, included as context. */
  engine?: EngineKind;
}

/** What the injectable {@link ClaudeRunner} resolves to. It must RESOLVE, never reject. */
export interface ClaudeRunnerResult {
  /** Process exit code; `null` when the process never started (spawn error) or was killed. */
  exitCode: number | null;
  /** Captured stdout — the minutes text on success. */
  stdout: string;
  /** Captured stderr — surfaced (bounded) in the failure reason. */
  stderr: string;
  /** True when the run was killed by the timeout backstop. */
  timedOut?: boolean;
  /** True when the process could not be spawned at all (e.g. `claude` not on PATH). */
  spawnError?: boolean;
}

/** Arguments handed to a {@link ClaudeRunner}. */
export interface ClaudeRunnerArgs {
  sessionId: string;
  model: string | null;
  prompt: string;
  cwd?: string;
  timeoutMs: number;
}

/**
 * The seam over `claude -p`. The default implementation spawns the real binary; tests inject a stub
 * for deterministic, auth-free runs. A runner MUST resolve (never reject) so {@link summarize} can
 * always map the outcome to a structured result.
 */
export type ClaudeRunner = (args: ClaudeRunnerArgs) => Promise<ClaudeRunnerResult>;

/** Options for {@link summarize}. */
export interface SummarizeOptions {
  /**
   * Pre-assigned summarizer session id. Supply this (and register watcher exclusion) BEFORE calling
   * to make the self-ingestion guard race-free. Omitted → a fresh id is generated and returned.
   */
  sessionId?: string;
  /** Model for the summarizer pass; `null`/omitted → claude's default. */
  model?: string | null;
  /** Override the `claude` spawn (tests). Defaults to {@link defaultClaudeRunner}. */
  runner?: ClaudeRunner;
  /** Timeout for the summarizer pass. Defaults to {@link SUMMARIZER_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** The outcome of a summarization pass. */
export interface SummarizeResult {
  /** True only when real minutes were produced. */
  ok: boolean;
  /** The minutes text, or `null` on any failure (never fabricated). */
  minutes: string | null;
  /** The summarizer session id used — register this for watcher exclusion. */
  sessionId: string;
  /** claude's exit code; `null` when no claude pass ran (empty transcript) or it never started. */
  exitCode: number | null;
  /** A named, bounded failure reason; `null` on success. */
  error: string | null;
  /** True when the transcript was clipped to fit the prompt budget. */
  truncated: boolean;
}

/** Generate a summarizer session id. Exposed so the daemon can pre-register watcher exclusion. */
export function newSummarizerSessionId(): string {
  return randomUUID();
}

/** Clamp a string to a max length, marking the clip so a reader knows content was dropped. */
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… (truncated)` : s;
}

/** Collapse internal whitespace/newlines so one event renders as one readable line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Render a single transcript event to one compact line, or `null` to skip it. `system`/`unknown`
 * events are pure noise for minutes and are dropped; everything else becomes a typed, capped line.
 */
function renderEvent(ev: TranscriptEvent): string | null {
  const text = ev.text ? clip(oneLine(ev.text), MAX_LINE_CHARS) : "";
  switch (ev.type) {
    case "message": {
      if (!text) return null;
      const who = ev.role ?? "message";
      return `${who}: ${text}`;
    }
    case "tool_use": {
      const name = ev.toolName ?? "tool";
      return `tool[${name}]: ${text}`;
    }
    case "tool_result":
      return text ? `result: ${text}` : null;
    default:
      // system / unknown → omitted from the human-facing condensation.
      return null;
  }
}

/** Result of {@link condenseTranscript}. */
export interface CondensedTranscript {
  /** The condensed, budget-bounded transcript text. */
  text: string;
  /** How many transcript events produced a renderable line. */
  eventCount: number;
  /** True when lines were dropped to fit the budget. */
  truncated: boolean;
}

/**
 * Condense a transcript stream into a bounded block of text using HEAD + TAIL retention: the start
 * of a run (the task) and the end (the result) matter most, so we keep leading lines until roughly
 * half the budget, then keep the most recent lines in a bounded ring buffer. Memory stays constant
 * regardless of transcript size — we never hold the whole stream. `eventCount` counts only lines
 * that rendered (so an all-noise transcript reports `0`, which the caller treats as "unusable").
 */
export async function condenseTranscript(
  events: AsyncIterable<TranscriptEvent>,
  budget = MAX_MINUTES_PROMPT_CHARS,
): Promise<CondensedTranscript> {
  const headBudget = Math.floor(budget / 2);
  const head: string[] = [];
  let headChars = 0;
  let headFull = false;

  // Bounded tail ring buffer — at most `budget` chars worth of recent lines.
  const tail: string[] = [];
  let tailChars = 0;

  let eventCount = 0;
  let dropped = 0;

  for await (const ev of events) {
    const line = renderEvent(ev);
    if (line === null) continue;
    eventCount += 1;

    if (!headFull && headChars + line.length + 1 <= headBudget) {
      head.push(line);
      headChars += line.length + 1;
      continue;
    }
    headFull = true;

    // Push into the tail ring, evicting oldest tail lines past the remaining budget.
    tail.push(line);
    tailChars += line.length + 1;
    const tailBudget = budget - headChars;
    while (tailChars > tailBudget && tail.length > 1) {
      const removed = tail.shift() as string;
      tailChars -= removed.length + 1;
      dropped += 1;
    }
  }

  const truncated = dropped > 0;
  const parts = [...head];
  if (truncated) parts.push(`… (${dropped} intermediate steps omitted) …`);
  parts.push(...tail);
  return { text: parts.join("\n"), eventCount, truncated };
}

/**
 * Build the minutes prompt — a deterministic, grounded, anti-fabrication instruction asking for
 * exactly three sentences. Exported so the prompt shape can be asserted in tests.
 */
export function buildMinutesPrompt(args: {
  condensed: string;
  diffStat: string | null;
  prompt?: string | null;
  cwd?: string;
  engine?: EngineKind;
}): string {
  const asked = args.prompt?.trim() ? args.prompt.trim() : "(ad-hoc session — no recorded prompt)";
  const diff = args.diffStat?.trim()
    ? clip(args.diffStat.trim(), MAX_DIFF_CHARS)
    : "(no file changes recorded)";
  const cwd = args.cwd ? `\nWorking directory: ${args.cwd}` : "";
  const engine = args.engine ? `\nEngine: ${args.engine}` : "";

  return [
    'You are writing the "minutes" for a completed AI agent run — a short, factual record a human',
    "can skim later to remember what this run did.",
    "",
    `The agent was asked to: ${asked}${cwd}${engine}`,
    "",
    "Below is a condensed transcript of what the agent actually did, then the git diff stat of what",
    "changed on disk.",
    "",
    "=== TRANSCRIPT (condensed) ===",
    args.condensed,
    "",
    "=== GIT DIFF STAT ===",
    diff,
    "",
    "Write exactly three sentences of minutes describing what the agent did and what changed. Be",
    "concrete and specific — name files, decisions, and outcomes. Do not add a preamble, a heading,",
    "or bullet points; output only the three sentences. If the transcript shows the run failed or",
    "accomplished little, say so plainly rather than inventing accomplishments.",
  ].join("\n");
}

/**
 * Default {@link ClaudeRunner}: spawn `claude --session-id <id> [--model m] -p <prompt>`, capture
 * stdout/stderr, enforce the timeout (SIGKILL), and ALWAYS resolve. No `ANTHROPIC_API_KEY` is set —
 * the child inherits the daemon env and reuses the user's CLI login. stdin is closed (`ignore`) so
 * `claude -p` runs fully non-interactively.
 */
export const defaultClaudeRunner: ClaudeRunner = (args) =>
  new Promise<ClaudeRunnerResult>((resolve) => {
    const argv = ["--session-id", args.sessionId];
    if (args.model) argv.push("--model", args.model);
    argv.push("-p", args.prompt);

    let child;
    try {
      child = spawn("claude", argv, {
        cwd: args.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      // spawn can throw synchronously on a malformed invocation — treat as a spawn failure.
      resolve({ exitCode: null, stdout: "", stderr: String(err), spawnError: true });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (r: ClaudeRunnerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, args.timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.once("error", (err) => {
      // ENOENT (claude not on PATH) and friends arrive here, not as a throw.
      finish({ exitCode: null, stdout, stderr: stderr || String(err), spawnError: true });
    });
    child.once("close", (code) => {
      finish({ exitCode: timedOut ? null : code, stdout, stderr, timedOut });
    });
  });

/** Trim + bound an error reason for storage. */
function asError(reason: string): string {
  return clip(reason.trim(), MAX_ERROR_CHARS);
}

/**
 * Summarize a finished run into minutes. See the module header for the full contract. Returns a
 * structured result; never throws (a failing runner or condense maps to `ok:false`).
 */
export async function summarize(
  input: SummarizeInput,
  opts: SummarizeOptions = {},
): Promise<SummarizeResult> {
  const sessionId = opts.sessionId ?? newSummarizerSessionId();
  const runner = opts.runner ?? defaultClaudeRunner;
  const timeoutMs = opts.timeoutMs ?? SUMMARIZER_TIMEOUT_MS;

  const condensed = await condenseTranscript(input.transcript);

  // No usable transcript → no claude pass, no fabricated minutes.
  if (condensed.eventCount === 0) {
    return {
      ok: false,
      minutes: null,
      sessionId,
      exitCode: null,
      error: "empty or unusable transcript — no minutes generated",
      truncated: condensed.truncated,
    };
  }

  const prompt = buildMinutesPrompt({
    condensed: condensed.text,
    diffStat: input.diffStat,
    prompt: input.prompt,
    cwd: input.cwd,
    engine: input.engine,
  });

  const fail = (error: string, exitCode: number | null): SummarizeResult => ({
    ok: false,
    minutes: null,
    sessionId,
    exitCode,
    error: asError(error),
    truncated: condensed.truncated,
  });

  const run = await runner({ sessionId, model: opts.model ?? null, prompt, cwd: input.cwd, timeoutMs });

  if (run.timedOut) {
    return fail(`summarizer timed out after ${timeoutMs}ms${run.stderr ? `: ${run.stderr}` : ""}`, null);
  }
  if (run.spawnError) {
    return fail(`claude failed to start: ${run.stderr || "spawn error"}`, run.exitCode);
  }
  if (run.exitCode !== 0) {
    return fail(`claude exited ${run.exitCode}${run.stderr ? `: ${run.stderr}` : ""}`, run.exitCode);
  }

  const minutes = run.stdout.trim();
  if (minutes.length === 0) {
    return fail("summarizer produced no output", run.exitCode);
  }

  return {
    ok: true,
    minutes,
    sessionId,
    exitCode: run.exitCode,
    error: null,
    truncated: condensed.truncated,
  };
}
