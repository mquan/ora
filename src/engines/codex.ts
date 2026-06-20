/**
 * The Codex engine adapter — ora's second concrete engine behind the frozen
 * {@link AgentAdapterBase} contract.
 *
 * Codex differs from claude in one load-bearing way: it CANNOT pre-assign the transcript correlation
 * key. `codex exec` chooses its own session UUID and only reveals it by writing
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`. So `preassignsSessionId = false` and
 * `resolveTranscriptPath` returns `null` (the path embeds an unknowable timestamp + uuid). Correlation
 * for a launched run therefore flows through the watcher's pending-claim (scheduler writes a `pending:`
 * row; the watcher backfills the real id when the rollout appears), not a pre-shared key.
 *
 * Everything reachable from a path stays O(1): the session UUID is parsed straight from the filename
 * ({@link sessionIdFromRolloutPath}), and cwd + start time come from the FIRST line (`session_meta`) via
 * {@link readSessionMeta}. Detached spawning + the git before/after snapshot live in the base — never
 * re-implemented here.
 */

import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { createInterface } from "node:readline";

import { AgentAdapterBase } from "./base.js";
import type { SpawnSpec, TranscriptEvent, TranscriptIdentity } from "./types.js";
import type { Event } from "../types.js";

/**
 * Cap on the stringified text kept for a `tool_use`/`tool_result` entry — a tool call or its output can
 * carry a large payload, and the unified stream is for human reading + the minutes pass, not faithful
 * replay (`raw` keeps the untruncated original). Mirrors claude's identically-named bound.
 */
export const MAX_TOOL_TEXT = 2000;

/**
 * Hard safety cap for the first-line read in {@link readSessionMeta}. codex's `session_meta` line embeds
 * a large `base_instructions` blob (multiple KiB, version-dependent), so a small fixed window like
 * claude's 64 KiB cwd scan could truncate it and never surface the cwd — leaving a launched run unable to
 * attach. We read the FIRST COMPLETE line up to this generous bound instead.
 */
export const MAX_META_SCAN_BYTES = 4 * 1024 * 1024;

/** The trailing UUID of a codex rollout filename: `rollout-<ISO-with-dashes>-<uuid>.jsonl`. */
const ROLLOUT_RE =
  /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Recover the codex session UUID from a rollout path — the same id `codex exec resume` takes, embedded
 * in the filename stem as the last five dash-groups. Returns `null` when the basename is not a codex
 * rollout (so {@link CodexEngine.identifyTranscript} can reject unrelated `.jsonl` files). Pure + O(1);
 * exported for isolated unit testing.
 */
export function sessionIdFromRolloutPath(path: string): string | null {
  const m = ROLLOUT_RE.exec(basename(path));
  return m ? m[1]!.toLowerCase() : null;
}

/** What {@link readSessionMeta} recovers from a rollout's `session_meta` line. */
export interface SessionMeta {
  /** The run's working directory (codex realpaths it). `null` if the meta line isn't readable yet. */
  cwd: string | null;
  /** The session start time (ISO), used as the watcher's spawn-window guard. */
  startedAt?: string;
}

/**
 * Read codex's `session_meta` (always line 1 of a rollout) for the run's cwd + start time. Accumulates
 * chunks until the FIRST newline (or {@link MAX_META_SCAN_BYTES}), parses that one complete line, and
 * pulls `payload.cwd` + `payload.timestamp` (falling back to the top-level `timestamp`). Returns `null`
 * on a missing/too-fresh/unparseable file (no complete first line yet) — never throws; the watcher then
 * defers, exactly as it does for a fresh claude transcript. Exported for isolated unit testing.
 */
export function readSessionMeta(path: string): SessionMeta | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const CHUNK = 64 * 1024;
    const buf = Buffer.alloc(CHUNK);
    let acc = "";
    let total = 0;
    let newlineIdx = -1;
    while (total < MAX_META_SCAN_BYTES) {
      const n = readSync(fd, buf, 0, CHUNK, total);
      if (n === 0) break; // EOF before any newline
      acc += buf.toString("utf8", 0, n);
      total += n;
      newlineIdx = acc.indexOf("\n");
      if (newlineIdx !== -1) break;
    }
    // Only parse a COMPLETE line — an unterminated first line is a live half-written flush; defer.
    if (newlineIdx === -1) return null;
    const trimmed = acc.slice(0, newlineIdx).trim();
    if (trimmed.length === 0) return null;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== "object") return null;
    const line = obj as Record<string, unknown>;
    if (line.type !== "session_meta") return null; // not the meta line (shouldn't happen — it's line 1)
    const payload =
      line.payload && typeof line.payload === "object"
        ? (line.payload as Record<string, unknown>)
        : {};
    const cwd =
      typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : null;
    const startedAt =
      (typeof payload.timestamp === "string" && payload.timestamp) ||
      (typeof line.timestamp === "string" && line.timestamp) ||
      undefined;
    return { cwd, startedAt: startedAt || undefined };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close
      }
    }
  }
}

/**
 * Build the headless prompt for codex: the event's prompt followed by a mentions block of
 * `Reference: <path>` lines. Unlike claude, codex does NOT resolve `/skill` mentions, so there is no
 * verbatim skill passthrough; doc-CONTENT inlining is intentionally deferred (out of scope for the
 * minimal adapter). Pure string transform, no filesystem reads. Exported for isolated unit testing.
 */
export function composePromptCodex(event: Event): string {
  const base = event.prompt ?? "";
  const mentions = event.mentions ?? [];
  const parts: string[] = [];
  if (base) parts.push(base);
  if (mentions.length > 0) {
    parts.push(mentions.map((m) => `Reference: ${m}`).join("\n"));
  }
  return parts.join("\n\n");
}

/** Truncate a string to {@link MAX_TOOL_TEXT}, marking that it was clipped. */
function truncate(s: string): string {
  return s.length > MAX_TOOL_TEXT ? `${s.slice(0, MAX_TOOL_TEXT)}… (truncated)` : s;
}

/** Map codex's {user|assistant|developer|system|tool} role onto the unified three-role space. */
function mapRole(role: unknown): "user" | "assistant" | "system" {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  return "system"; // developer, system, tool, … → system
}

/** Flatten codex message content (a string, or blocks `{type:input_text|output_text, text}`) to text. */
function flattenContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (typeof b.text === "string") return b.text;
        }
        return JSON.stringify(block);
      })
      .join("\n");
  }
  return String(content);
}

/** Flatten a `reasoning` payload's `summary` array (or `content`) into one readable string. */
function flattenReasoning(payload: Record<string, unknown>): string {
  const summary = payload.summary;
  if (Array.isArray(summary)) {
    const text = summary
      .map((s) => {
        if (typeof s === "string") return s;
        if (s && typeof s === "object" && typeof (s as Record<string, unknown>).text === "string") {
          return (s as Record<string, unknown>).text as string;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  if (payload.content != null) return flattenContent(payload.content);
  return "";
}

/** Flatten a `function_call_output` payload's `output` (string, or `{output|content: string}`). */
function flattenOutput(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return truncate(output);
  if (typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o.output === "string") return truncate(o.output);
    if (typeof o.content === "string") return truncate(o.content);
  }
  return truncate(JSON.stringify(output));
}

/**
 * Map one parsed codex rollout line into zero or more unified {@link TranscriptEvent}s. Pure (no I/O) so
 * it is unit-tested in isolation; {@link CodexEngine.parseTranscript} is the streaming shell over it.
 *
 * `response_item` IS the canonical content stream (`message`, `reasoning`, `function_call`(+`_output`),
 * `custom_tool_call`(+`_output`)). `event_msg` largely DUPLICATES `response_item` (and `session_meta` /
 * `turn_context` are metadata), so they all become a lossless `unknown` carrying `raw` — this avoids
 * double-counting the same model output. `raw` is always the whole source line so nothing is lost.
 */
export function mapLine(obj: unknown): TranscriptEvent[] {
  if (!obj || typeof obj !== "object") return [{ type: "unknown", raw: obj }];
  const line = obj as Record<string, unknown>;
  const timestamp = typeof line.timestamp === "string" ? line.timestamp : undefined;

  if (line.type !== "response_item") {
    // session_meta, event_msg (duplicate stream), turn_context, anything else → lossless unknown.
    return [{ type: "unknown", raw: obj }];
  }
  const payload =
    line.payload && typeof line.payload === "object"
      ? (line.payload as Record<string, unknown>)
      : null;
  if (!payload) return [{ type: "unknown", raw: obj }];

  switch (payload.type) {
    case "message":
      return [
        {
          type: "message",
          role: mapRole(payload.role),
          text: flattenContent(payload.content),
          timestamp,
          raw: obj,
        },
      ];

    case "reasoning":
      return [
        { type: "message", role: "assistant", text: flattenReasoning(payload), timestamp, raw: obj },
      ];

    case "function_call":
    case "custom_tool_call": {
      const args = payload.arguments ?? payload.input ?? {};
      return [
        {
          type: "tool_use",
          role: "assistant",
          toolName: typeof payload.name === "string" ? payload.name : undefined,
          text: truncate(typeof args === "string" ? args : JSON.stringify(args)),
          timestamp,
          raw: obj,
        },
      ];
    }

    case "function_call_output":
    case "custom_tool_call_output":
      return [
        { type: "tool_result", role: "user", text: flattenOutput(payload.output), timestamp, raw: obj },
      ];

    default:
      // reasoning variants / ghost_snapshot / future payload types → lossless unknown.
      return [{ type: "unknown", raw: obj }];
  }
}

/**
 * The concrete Codex adapter. Extends the frozen base; supplies only the engine-specific seam. The two
 * differences from claude that matter most: `preassignsSessionId = false` (the scheduler records a
 * pending row) and `resolveTranscriptPath` → `null` (the path is not predictable up-front).
 */
export class CodexEngine extends AgentAdapterBase {
  readonly id = "codex" as const;

  /** codex cannot pin its rollout UUID at launch → the scheduler records a `pending:` row to backfill. */
  readonly preassignsSessionId = false;

  /** The single directory codex writes all dated rollout folders under. */
  private sessionsRoot(): string {
    return join(homedir(), ".codex", "sessions");
  }

  transcriptRoots(): string[] {
    return [this.sessionsRoot()];
  }

  /**
   * NOT predictable for codex: the rollout filename embeds an ISO timestamp + a codex-chosen UUID, neither
   * known at launch. Always `null` — correlation flows through the watcher's pending-claim instead. (The
   * interface explicitly permits `null` here.)
   */
  resolveTranscriptPath(): null {
    return null;
  }

  /**
   * Recover a launched/ad-hoc run's identity from a rollout path. Rejects (→ `null`) anything not under
   * `~/.codex/sessions`, not a `*.jsonl`, or whose name is not a `rollout-…-<uuid>.jsonl`. `sessionId` is
   * the filename's trailing UUID (no read needed); `cwd` + `startedAt` come from the `session_meta` line,
   * with `cwd:null` when the file is too fresh to have flushed it (the watcher then defers).
   */
  identifyTranscript(path: string): TranscriptIdentity | null {
    const root = this.sessionsRoot();
    if (!path.startsWith(root + sep) || !path.endsWith(".jsonl")) return null;
    const sessionId = sessionIdFromRolloutPath(path);
    if (sessionId === null) return null;
    const meta = readSessionMeta(path);
    return { sessionId, cwd: meta?.cwd ?? null, startedAt: meta?.startedAt };
  }

  /**
   * Headless launch flags. `exec` is the non-interactive surface; `--skip-git-repo-check` lets a run fire
   * in a non-repo cwd (e.g. `/tmp/x`); `-s workspace-write` lets the run do real work in its workspace
   * while staying bounded (no network, no out-of-workspace writes). The pre-assigned `sessionId` is
   * unused — codex picks its own. Deliberately NOT set: `--ephemeral` (would skip the rollout the watcher
   * relies on) and `--json` (the base spawns detached with `stdio:"ignore"`, so stdout can't be captured).
   */
  protected buildSpawn(event: Event): SpawnSpec {
    const args = ["exec", "--skip-git-repo-check", "-s", "workspace-write"];
    if (event.model) args.push("-m", event.model);
    args.push(composePromptCodex(event));
    return { command: "codex", args };
  }

  /**
   * Stream the rollout line-by-line (`readline` over a read stream, so a huge transcript never loads
   * whole) and map each line via {@link mapLine}. Best-effort + crash-proof, identical posture to claude:
   * a malformed / half-written line → one `unknown`; a missing file → an empty stream, not an error.
   */
  async *parseTranscript(path: string): AsyncIterable<TranscriptEvent> {
    const stream = createReadStream(path, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let obj: unknown;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          yield { type: "unknown", raw: trimmed };
          continue;
        }
        for (const event of mapLine(obj)) yield event;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw err;
    } finally {
      rl.close();
      stream.destroy();
    }
  }
}
