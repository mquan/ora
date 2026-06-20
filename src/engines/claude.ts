/**
 * The Claude engine adapter — ora's first concrete engine behind the frozen
 * {@link AgentAdapterBase} contract (merged at f4311b2).
 *
 * It supplies ONLY the engine-specific seam: `id`, `buildSpawn` (claude flags + prompt/mentions
 * composition), `resolveTranscriptPath` (cwd-slug → predicted JSONL path), `parseTranscript`
 * (claude JSONL → unified {@link TranscriptEvent}), and `transcriptRoots`. Detached spawning, the
 * git before/after snapshot, and the pollable {@link RunHandle} all live in the base — never
 * re-implemented here.
 *
 * The correctness spine is the JOIN KEY: `claude --session-id <uuid> -p` pre-assigns the session id,
 * which is also the transcript filename stem. So ora knows the on-disk path BEFORE the run
 * even starts, and the watcher (m2) re-attaches by it. The single failure-prone line is the
 * cwd-slug encoding in {@link slugForCwd} — empirically confirmed against `~/.claude/projects`,
 * exported, and unit-tested in isolation.
 */

import { closeSync, createReadStream, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import { AgentAdapterBase } from "./base.js";
import type { SpawnSpec, TranscriptEvent, TranscriptIdentity } from "./types.js";
import type { Event } from "../types.js";

/**
 * Cap on the stringified text we keep for a `tool_use` input — a tool call can carry a large
 * payload (a whole file write, a giant patch), and the unified stream is for human reading + the
 * minutes pass, not faithful replay (`raw` already carries the untruncated original). Named so the
 * bound is visible and tunable rather than a magic literal.
 */
export const MAX_TOOL_TEXT = 2000;

/**
 * How far into a transcript {@link readTranscriptCwd} will scan for the first `cwd`-bearing line.
 * claude writes a `cwd` field on (essentially) every line, so the first complete line carries it and
 * 64 KiB is generous headroom — bounding the read keeps `identifyTranscript` O(1) regardless of how
 * large the transcript grows, and crash-proof on a half-written first line (we just defer).
 */
export const MAX_CWD_SCAN_BYTES = 64 * 1024;

/**
 * Read the run's working directory out of a claude transcript's own content — authoritative, unlike
 * de-slugging the directory name (`slugForCwd` is lossy: `/` and `.` both collapse to `-`, so it has
 * no inverse). Scans at most {@link MAX_CWD_SCAN_BYTES} synchronously, parses only COMPLETE newline-
 * terminated lines (a trailing partial line — a live half-written flush — is ignored), and returns the
 * first non-empty `cwd` string found. Returns `null` for a missing/empty/too-fresh file or any read
 * error; never throws. Exported for isolated unit testing, mirroring {@link slugForCwd}.
 */
export function readTranscriptCwd(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(MAX_CWD_SCAN_BYTES);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString("utf8", 0, bytesRead);
    const lines = text.split("\n");
    // Drop the last element unless the chunk ended on a newline — it is a partial (possibly mid-write)
    // line we must not parse. (`split` always yields a trailing "" when text ends in "\n", so dropping
    // it then is a no-op.)
    lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof obj.cwd === "string" && obj.cwd.length > 0) return obj.cwd;
      } catch {
        // A non-JSON / malformed line is not fatal — keep scanning the rest of the bounded window.
      }
    }
    return null;
  } catch {
    // ENOENT (consumer raced claude's first write), permission, etc. → "no cwd yet", never a throw.
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
 * Encode a cwd the way claude names its on-disk transcript directory: every non-alphanumeric
 * character → `-`, after resolving to an absolute path.
 *
 * Empirically confirmed (NOT from docs): `/Users/quan/workspace/maneuver/.worktrees/x` →
 * `-Users-quan-workspace-maneuver--worktrees-x`. The `/.worktrees` segment becomes `--worktrees`
 * (a double dash), proving BOTH `/` and `.` collapse to `-` — a naive `/`→`-` would have left
 * `-.worktrees`. This is the most failure-prone line in the adapter → exported for isolated testing.
 */
export function slugForCwd(cwd: string): string {
  return canonicalCwd(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Resolve `cwd` to the SAME absolute path claude names its transcript dir after. claude slugifies the
 * process's *real* working directory — and the OS resolves symlinks on `chdir` — so we must `realpath`,
 * not just `resolve`. The classic macOS trap: `/tmp` is a symlink to `/private/tmp`, so a run launched
 * in `/tmp/x` actually writes to `…/-private-tmp-x`, NOT `…/-tmp-x`; a lexical `resolve` predicts the
 * wrong path and the watcher (m2) never finds the transcript. `realpathSync` requires the directory to
 * exist — it does at launch time, the only moment the slug must be right — so if it can't resolve (path
 * not yet created, e.g. a pure prediction call), fall back to lexical `resolve` rather than throw.
 */
function canonicalCwd(cwd: string): string {
  try {
    return realpathSync(resolve(cwd));
  } catch {
    return resolve(cwd);
  }
}

/**
 * Build the headless prompt: the event's prompt followed by a mentions block. Per design
 * §"Skill/doc mentions", for claude this is a pure, deterministic string transform — NO filesystem
 * reads (skills self-resolve inside claude; doc-*content* inlining is the codex-only path in t9):
 *   - a mention starting with `/` is a skill → passed THROUGH verbatim (claude resolves it).
 *   - any other mention is a doc path → injected as a `Reference: <path>` line.
 * A null prompt with mentions yields a mentions-only string; empty/absent mentions leave the prompt
 * unchanged; a null prompt with no mentions yields `""`.
 */
export function composePrompt(event: Event): string {
  const base = event.prompt ?? "";
  const mentions = event.mentions ?? [];
  const parts: string[] = [];
  if (base) parts.push(base);
  if (mentions.length > 0) {
    const lines = mentions.map((m) => (m.startsWith("/") ? m : `Reference: ${m}`));
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

/** Truncate a string to {@link MAX_TOOL_TEXT}, marking that it was clipped. */
function truncate(s: string): string {
  return s.length > MAX_TOOL_TEXT ? `${s.slice(0, MAX_TOOL_TEXT)}… (truncated)` : s;
}

/**
 * Normalize claude's string-or-blocks content into one readable string. Handles a bare string, a
 * list of blocks (`text`, nested `tool_result`, or anything with a `.text`/`.content`), and
 * null/undefined (→ `""`). Never throws — best-effort flattening, with `JSON.stringify` as the
 * lossless fallback for an unrecognized block.
 */
function flattenText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (typeof b.text === "string") return b.text;
          if (b.content != null) return flattenText(b.content);
        }
        return JSON.stringify(block);
      })
      .join("\n");
  }
  return String(content);
}

/**
 * Map one parsed JSONL object into zero or more unified {@link TranscriptEvent}s, preserving order.
 * Pure (no I/O) so it is unit-tested in isolation; {@link ClaudeEngine.parseTranscript} is just the
 * streaming shell over it. Every branch sets `raw` to the most specific source object (the block
 * for per-block events, the line otherwise) so NO field is ever lost — unmapped line types still
 * surface as `unknown` carrying the original object.
 */
export function mapLine(obj: unknown): TranscriptEvent[] {
  if (!obj || typeof obj !== "object") return [{ type: "unknown", raw: obj }];
  const line = obj as Record<string, unknown>;
  const timestamp = typeof line.timestamp === "string" ? line.timestamp : undefined;
  const message = line.message as Record<string, unknown> | undefined;

  switch (line.type) {
    case "assistant": {
      const content = message?.content;
      if (!Array.isArray(content)) return [{ type: "unknown", raw: obj }];
      const out: TranscriptEvent[] = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          out.push({ type: "message", role: "assistant", text: String(b.text ?? ""), timestamp, raw: block });
        } else if (b.type === "thinking") {
          out.push({ type: "message", role: "assistant", text: String(b.thinking ?? ""), timestamp, raw: block });
        } else if (b.type === "tool_use") {
          out.push({
            type: "tool_use",
            role: "assistant",
            toolName: typeof b.name === "string" ? b.name : undefined,
            text: truncate(JSON.stringify(b.input ?? {})),
            timestamp,
            raw: block,
          });
        }
      }
      return out.length > 0 ? out : [{ type: "unknown", raw: obj }];
    }

    case "user": {
      const content = message?.content;
      if (typeof content === "string") {
        return [{ type: "message", role: "user", text: content, timestamp, raw: obj }];
      }
      if (Array.isArray(content)) {
        const out: TranscriptEvent[] = [];
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "tool_result") {
            out.push({ type: "tool_result", role: "user", text: flattenText(b.content), timestamp, raw: block });
          } else if (b.type === "text") {
            out.push({ type: "message", role: "user", text: String(b.text ?? ""), timestamp, raw: block });
          } else {
            out.push({ type: "unknown", raw: block });
          }
        }
        return out.length > 0 ? out : [{ type: "unknown", raw: obj }];
      }
      return [{ type: "unknown", raw: obj }];
    }

    case "system": {
      const text =
        (typeof line.subtype === "string" && line.subtype) ||
        (typeof line.content === "string" && line.content) ||
        (typeof line.summary === "string" && line.summary) ||
        undefined;
      return [{ type: "system", role: "system", text: text || undefined, timestamp, raw: obj }];
    }

    default:
      // Metadata-only lines (mode, ai-title, queue-operation, attachment, last-prompt, …) and any
      // future type → lossless `unknown` carrying the whole object.
      return [{ type: "unknown", raw: obj }];
  }
}

/**
 * The concrete Claude adapter. Extends the frozen base; supplies only the 5 engine-specific members.
 */
export class ClaudeEngine extends AgentAdapterBase {
  readonly id = "claude" as const;

  /** The single directory claude writes all per-project transcript folders under. */
  private projectsRoot(): string {
    return join(homedir(), ".claude", "projects");
  }

  transcriptRoots(): string[] {
    return [this.projectsRoot()];
  }

  /**
   * The predicted transcript path: `<root>/<cwd-slug>/<sessionId>.jsonl`. Pure path construction —
   * the file may not exist yet at launch (the watcher waits for it). Never returns `null` for
   * claude: the path is always derivable from (sessionId, cwd); existence is the watcher's concern.
   */
  resolveTranscriptPath(sessionId: string, cwd: string): string {
    return join(this.projectsRoot(), slugForCwd(cwd), `${sessionId}.jsonl`);
  }

  /**
   * Inverse of {@link resolveTranscriptPath}. Returns `null` when `path` is not one of claude's
   * transcripts (not under `~/.claude/projects`, or not a `*.jsonl`), so the watcher ignores it.
   * Otherwise `sessionId` is the filename stem (the same key the launch side pre-assigns — no read
   * needed) and `cwd` is read from the file's content via {@link readTranscriptCwd}, which may be
   * `null` on a transcript too fresh to have flushed a `cwd` line yet (ad-hoc discovery then defers).
   */
  identifyTranscript(path: string): TranscriptIdentity | null {
    const root = this.projectsRoot();
    if (!path.startsWith(root + sep) || !path.endsWith(".jsonl")) return null;
    return { sessionId: basename(path, ".jsonl"), cwd: readTranscriptCwd(path) };
  }

  /**
   * Headless launch flags. `-p` (print) makes it a non-interactive run; `--session-id` pre-assigns
   * the join key. No `ANTHROPIC_API_KEY` is injected — the child reuses the user's existing CLI
   * login (design §A3, the OSS-onboarding bet), so `env` is left undefined and the child inherits
   * the daemon's environment.
   */
  protected buildSpawn(event: Event, sessionId: string): SpawnSpec {
    const args = ["--session-id", sessionId];
    if (event.model) args.push("--model", event.model);
    args.push("-p", composePrompt(event));
    return { command: "claude", args };
  }

  /**
   * Stream the transcript line-by-line (`readline` over a read stream, so a huge transcript never
   * loads whole) and map each line via {@link mapLine}. Best-effort and crash-proof:
   *   - a malformed / half-written line (live tailing) → one `unknown` event, never a throw.
   *   - a missing file (a consumer racing claude's first write) → an empty stream, not an error.
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
      // Missing transcript (not written yet) → empty stream, consistent with the malformed-line
      // tolerance above. Any other stream error is real and re-thrown.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw err;
    } finally {
      rl.close();
      stream.destroy();
    }
  }
}
