/**
 * Tests for the Claude adapter. Covers the correctness spine (cwd-slug encoding → predicted path),
 * the pure transforms (buildSpawn / composePrompt / mapLine via parseTranscript), the streaming
 * parser's edges (malformed / empty / missing file), and the DoD predicted-path integration: a
 * mock-spawn subclass writes a real JSONL to the path `resolveTranscriptPath` predicts, proving the
 * join key end-to-end against the REAL base with zero network/auth.
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ClaudeEngine, slugForCwd, composePrompt, mapLine, MAX_TOOL_TEXT } from "./claude.js";
import type { SpawnSpec, TranscriptEvent } from "./types.js";
import type { Event } from "../types.js";

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "evt-test",
    title: "test",
    engine: "claude",
    model: null,
    cwd: "/tmp",
    prompt: "do the thing",
    mentions: null,
    schedule_kind: "once",
    scheduled_at: null,
    recurrence_rule_id: null,
    status: "scheduled",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Widens `buildSpawn` (protected on the base) to public so the unit test can assert the argv. */
class ExposedClaude extends ClaudeEngine {
  public spawnSpec(event: Event, sessionId: string): SpawnSpec {
    return this.buildSpawn(event, sessionId);
  }
}

async function collect(it: AsyncIterable<TranscriptEvent>): Promise<TranscriptEvent[]> {
  const out: TranscriptEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

// Temp paths created per-test; cleaned up in afterEach so nothing leaks (incl. the predicted-path
// directory the DoD test writes under ~/.claude/projects).
const tmpPaths: string[] = [];
afterEach(() => {
  while (tmpPaths.length > 0) {
    const p = tmpPaths.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("slugForCwd — the correctness spine", () => {
  it("matches claude's empirically-confirmed encoding (/.worktrees → --worktrees)", () => {
    expect(slugForCwd("/Users/quan/workspace/maneuver/.worktrees/x")).toBe(
      "-Users-quan-workspace-maneuver--worktrees-x",
    );
  });

  it("maps a plain absolute path, collapsing every separator to a dash", () => {
    expect(slugForCwd("/tmp/greg-test")).toBe("-tmp-greg-test");
  });

  it("resolves a relative path to absolute before slugging", () => {
    expect(slugForCwd("relative/path")).toBe(resolve("relative/path").replace(/[^a-zA-Z0-9]/g, "-"));
    expect(slugForCwd("relative/path")).not.toContain("/");
  });

  it("collapses underscores and spaces (all non-alnum) to dashes", () => {
    expect(slugForCwd("/a_b/c d")).toBe("-a-b-c-d");
  });
});

describe("resolveTranscriptPath", () => {
  it("composes <root>/<slug>/<sessionId>.jsonl under ~/.claude/projects", () => {
    const engine = new ClaudeEngine();
    const p = engine.resolveTranscriptPath("sess-123", "/tmp/greg-test");
    expect(p).toBe(join(homedir(), ".claude", "projects", "-tmp-greg-test", "sess-123.jsonl"));
  });

  it("roots transcripts under homedir/.claude/projects", () => {
    const engine = new ClaudeEngine();
    expect(engine.transcriptRoots()).toEqual([join(homedir(), ".claude", "projects")]);
  });
});

describe("buildSpawn", () => {
  it("builds the headless claude launch with the session id and prompt", () => {
    const engine = new ExposedClaude();
    const spec = engine.spawnSpec(makeEvent({ prompt: "hello", model: null }), "uuid-1");
    expect(spec.command).toBe("claude");
    expect(spec.args).toEqual(["--session-id", "uuid-1", "-p", "hello"]);
  });

  it("adds --model only when event.model is set", () => {
    const engine = new ExposedClaude();
    expect(engine.spawnSpec(makeEvent({ model: null }), "u").args).not.toContain("--model");
    const spec = engine.spawnSpec(makeEvent({ prompt: "hello", model: "opus" }), "u");
    expect(spec.args).toEqual(["--session-id", "u", "--model", "opus", "-p", "hello"]);
  });

  it("injects NO ANTHROPIC_API_KEY — reuses the CLI login (env left undefined)", () => {
    const engine = new ExposedClaude();
    const spec = engine.spawnSpec(makeEvent(), "u");
    expect(spec.env).toBeUndefined();
  });
});

describe("composePrompt", () => {
  it("leaves a bare prompt unchanged when there are no mentions", () => {
    expect(composePrompt(makeEvent({ prompt: "just this", mentions: null }))).toBe("just this");
    expect(composePrompt(makeEvent({ prompt: "just this", mentions: [] }))).toBe("just this");
  });

  it("passes a /skill mention through verbatim", () => {
    expect(composePrompt(makeEvent({ prompt: "run qa", mentions: ["/qa"] }))).toBe("run qa\n\n/qa");
  });

  it("injects a doc-path mention as a Reference line", () => {
    expect(composePrompt(makeEvent({ prompt: "p", mentions: ["docs/spec.md"] }))).toBe(
      "p\n\nReference: docs/spec.md",
    );
  });

  it("yields a mentions-only string when the prompt is null", () => {
    expect(composePrompt(makeEvent({ prompt: null, mentions: ["/qa", "a/b.md"] }))).toBe(
      "/qa\nReference: a/b.md",
    );
  });

  it("yields an empty string for a null prompt with no mentions", () => {
    expect(composePrompt(makeEvent({ prompt: null, mentions: null }))).toBe("");
  });
});

describe("parseTranscript", () => {
  function writeFixture(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "greg-claude-"));
    tmpPaths.push(dir);
    const file = join(dir, "t.jsonl");
    writeFileSync(file, lines.join("\n") + (lines.length ? "\n" : ""));
    return file;
  }

  it("maps the full line vocabulary into the unified stream, in order", async () => {
    const ts = "2026-01-01T00:00:00.000Z";
    const file = writeFixture([
      JSON.stringify({
        type: "assistant",
        timestamp: ts,
        message: {
          content: [
            { type: "thinking", thinking: "let me think" },
            { type: "text", text: "hello" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
      JSON.stringify({ type: "user", timestamp: ts, message: { content: "a user message" } }),
      JSON.stringify({
        type: "user",
        timestamp: ts,
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file.txt", is_error: false }] },
      }),
      JSON.stringify({ type: "system", timestamp: ts, subtype: "init" }),
      JSON.stringify({ type: "ai-title", title: "metadata only" }),
    ]);

    const events = await collect(new ClaudeEngine().parseTranscript(file));

    expect(events.map((e) => `${e.type}:${e.role ?? ""}`)).toEqual([
      "message:assistant", // thinking
      "message:assistant", // text
      "tool_use:assistant",
      "message:user",
      "tool_result:user",
      "system:system",
      "unknown:",
    ]);
    expect(events[0]!.text).toBe("let me think");
    expect(events[1]!.text).toBe("hello");
    expect(events[2]!.toolName).toBe("Bash");
    expect(events[2]!.text).toContain("ls");
    expect(events[3]!.text).toBe("a user message");
    expect(events[4]!.text).toBe("file.txt");
    expect(events[5]!.text).toBe("init");
    expect(events.every((e) => e.raw !== undefined)).toBe(true);
    expect(events[1]!.timestamp).toBe(ts);
  });

  it("surfaces a malformed/half-written line as one unknown event, without throwing", async () => {
    const file = writeFixture([
      JSON.stringify({ type: "user", message: { content: "ok" } }),
      '{"type":"assistant","message":{"content":[{"type":"text","text":"part', // truncated final line
    ]);
    const events = await collect(new ClaudeEngine().parseTranscript(file));
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("message");
    expect(events[1]!.type).toBe("unknown");
    expect(events[1]!.raw).toContain("part");
  });

  it("yields an empty stream for an empty file", async () => {
    const file = writeFixture([]);
    expect(await collect(new ClaudeEngine().parseTranscript(file))).toEqual([]);
  });

  it("yields an empty stream for a missing file (consumer races claude's first write)", async () => {
    const events = await collect(new ClaudeEngine().parseTranscript("/no/such/greg-missing.jsonl"));
    expect(events).toEqual([]);
  });

  it("truncates an oversized tool_use input to MAX_TOOL_TEXT", () => {
    const big = "x".repeat(MAX_TOOL_TEXT + 500);
    const event = mapLine({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Write", input: { content: big } }] },
    })[0]!;
    expect(event.type).toBe("tool_use");
    expect(event.text!.length).toBeLessThan(big.length);
    expect(event.text!).toContain("truncated");
  });
});

describe("DoD — predicted-path integration (mock spawn, no live claude)", () => {
  /**
   * Keeps the REAL `resolveTranscriptPath`/`parseTranscript` but overrides `buildSpawn` to run a
   * trivial node process that writes a minimal valid JSONL to the predicted path. Proves the join
   * key end-to-end against the real base with zero network/auth.
   */
  class TestClaude extends ClaudeEngine {
    protected override buildSpawn(event: Event, sessionId: string): SpawnSpec {
      const out = this.resolveTranscriptPath(sessionId, event.cwd);
      const script =
        "const fs=require('fs'),p=require('path');" +
        "fs.mkdirSync(p.dirname(process.env.GREG_OUT),{recursive:true});" +
        "fs.writeFileSync(process.env.GREG_OUT," +
        "JSON.stringify({type:'assistant',timestamp:'2026-01-01T00:00:00.000Z'," +
        "message:{content:[{type:'text',text:'hi from the predicted path'}]}})+'\\n');";
      return { command: process.execPath, args: ["-e", script], env: { GREG_OUT: out } };
    }
  }

  it("launches, writes to the predicted path, and parseTranscript reads it back", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "greg-cwd-"));
    tmpPaths.push(cwd);
    const engine = new TestClaude();
    const sessionId = "dod-session-1";
    const predicted = engine.resolveTranscriptPath(sessionId, cwd);
    tmpPaths.push(dirname(predicted)); // the <slug> dir created under ~/.claude/projects

    const handle = await engine.start(makeEvent({ cwd }), { sessionId, beforeSnapshot: false });
    const result = await handle.result();

    expect(result.exitCode).toBe(0);
    expect(result.transcriptPath).toBe(predicted);
    expect(existsSync(predicted)).toBe(true);

    const events = await collect(engine.parseTranscript(predicted));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.type).toBe("message");
    expect(events[0]!.text).toBe("hi from the predicted path");
  });
});
