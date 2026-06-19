/**
 * Tests for the Codex adapter. Covers the identity spine (session uuid parsed from the rollout
 * filename; cwd + startedAt read from `session_meta`), the pure transforms (buildSpawn /
 * composePromptCodex / mapLine via parseTranscript over a real-shaped fixture), the streaming parser's
 * edges (malformed / empty / missing file), and the codex-specific contract points: `resolveTranscriptPath`
 * is null, `preassignsSessionId` is false, and the meta read survives an oversized first line.
 */

import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexEngine,
  composePromptCodex,
  mapLine,
  readSessionMeta,
  sessionIdFromRolloutPath,
  MAX_TOOL_TEXT,
} from "./codex.js";
import type { SpawnSpec, TranscriptEvent } from "./types.js";
import type { Event } from "../types.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/codex-rollout.jsonl", import.meta.url));
const FIXTURE_UUID = "019ed96b-6c9a-7631-a7f3-28d40d27c3e5";

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "evt-test",
    title: "test",
    engine: "codex",
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
class ExposedCodex extends CodexEngine {
  public spawnSpec(event: Event, sessionId: string): SpawnSpec {
    return this.buildSpawn(event, sessionId);
  }
}

async function collect(it: AsyncIterable<TranscriptEvent>): Promise<TranscriptEvent[]> {
  const out: TranscriptEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const tmpPaths: string[] = [];
afterEach(() => {
  while (tmpPaths.length > 0) {
    const p = tmpPaths.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("sessionIdFromRolloutPath — the identity spine", () => {
  it("parses the trailing uuid from a rollout filename", () => {
    expect(
      sessionIdFromRolloutPath(
        "/Users/me/.codex/sessions/2026/06/17/rollout-2026-06-17T23-29-16-019ed96b-6c9a-7631-a7f3-28d40d27c3e5.jsonl",
      ),
    ).toBe("019ed96b-6c9a-7631-a7f3-28d40d27c3e5");
  });

  it("returns null for a non-rollout .jsonl filename", () => {
    expect(sessionIdFromRolloutPath("/x/y/notes.jsonl")).toBeNull();
    expect(sessionIdFromRolloutPath("/x/y/rollout-missing-uuid.jsonl")).toBeNull();
  });
});

describe("resolveTranscriptPath / transcriptRoots / preassignsSessionId", () => {
  it("resolveTranscriptPath is always null (codex path is not predictable at launch)", () => {
    expect(new CodexEngine().resolveTranscriptPath("any", "/tmp")).toBeNull();
  });

  it("roots transcripts under homedir/.codex/sessions", () => {
    expect(new CodexEngine().transcriptRoots()).toEqual([join(homedir(), ".codex", "sessions")]);
  });

  it("declares it cannot pre-assign the session id", () => {
    expect(new CodexEngine().preassignsSessionId).toBe(false);
  });
});

describe("buildSpawn", () => {
  it("builds `codex exec` with skip-git + workspace-write sandbox and the prompt last", () => {
    const engine = new ExposedCodex();
    const spec = engine.spawnSpec(makeEvent({ prompt: "hello", model: null }), "ignored-uuid");
    expect(spec.command).toBe("codex");
    expect(spec.args).toEqual(["exec", "--skip-git-repo-check", "-s", "workspace-write", "hello"]);
  });

  it("adds -m only when event.model is set, keeping the prompt last", () => {
    const engine = new ExposedCodex();
    expect(engine.spawnSpec(makeEvent({ model: null }), "u").args).not.toContain("-m");
    const spec = engine.spawnSpec(makeEvent({ prompt: "hello", model: "gpt-5" }), "u");
    expect(spec.args).toEqual(["exec", "--skip-git-repo-check", "-s", "workspace-write", "-m", "gpt-5", "hello"]);
  });

  it("never uses --ephemeral or --json (the watcher needs the rollout; stdout is ignored)", () => {
    const spec = new ExposedCodex().spawnSpec(makeEvent(), "u");
    expect(spec.args).not.toContain("--ephemeral");
    expect(spec.args).not.toContain("--json");
    expect(spec.env).toBeUndefined();
  });
});

describe("composePromptCodex", () => {
  it("leaves a bare prompt unchanged when there are no mentions", () => {
    expect(composePromptCodex(makeEvent({ prompt: "just this", mentions: null }))).toBe("just this");
    expect(composePromptCodex(makeEvent({ prompt: "just this", mentions: [] }))).toBe("just this");
  });

  it("injects every mention as a Reference line (no /skill passthrough — codex can't resolve them)", () => {
    expect(composePromptCodex(makeEvent({ prompt: "p", mentions: ["/qa", "docs/spec.md"] }))).toBe(
      "p\n\nReference: /qa\nReference: docs/spec.md",
    );
  });

  it("yields a mentions-only string for a null prompt, and empty for null+none", () => {
    expect(composePromptCodex(makeEvent({ prompt: null, mentions: ["a/b.md"] }))).toBe("Reference: a/b.md");
    expect(composePromptCodex(makeEvent({ prompt: null, mentions: null }))).toBe("");
  });
});

describe("parseTranscript — rollout dialect → unified stream", () => {
  function writeFixture(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "greg-codex-"));
    tmpPaths.push(dir);
    const file = join(dir, "t.jsonl");
    writeFileSync(file, lines.join("\n") + (lines.length ? "\n" : ""));
    return file;
  }

  it("maps response_item as the content stream and everything else as lossless unknown, in order", async () => {
    const events = await collect(new CodexEngine().parseTranscript(FIXTURE));

    expect(events.map((e) => `${e.type}:${e.role ?? ""}`)).toEqual([
      "unknown:", // session_meta
      "message:system", // response_item/message developer
      "message:user", // response_item/message user
      "unknown:", // event_msg user_message (duplicate)
      "unknown:", // turn_context
      "message:assistant", // response_item/reasoning
      "tool_use:assistant", // response_item/function_call
      "tool_result:user", // response_item/function_call_output
      "unknown:", // event_msg agent_message (duplicate)
      "message:assistant", // response_item/message assistant
      "unknown:", // event_msg task_complete
    ]);
    expect(events[2]!.text).toBe("list the files");
    expect(events[5]!.text).toBe("I should run ls.");
    expect(events[6]!.toolName).toBe("shell");
    expect(events[6]!.text).toContain("ls");
    expect(events[7]!.text).toBe("a.txt\nb.txt");
    expect(events[9]!.text).toBe("There are two files: a.txt and b.txt.");
    expect(events.every((e) => e.raw !== undefined)).toBe(true);
    expect(events[2]!.timestamp).toBe("2026-06-18T06:29:16.800Z");
  });

  it("surfaces a malformed/half-written line as one unknown event, without throwing", async () => {
    const file = writeFixture([
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "ok" }] } }),
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"par', // truncated
    ]);
    const events = await collect(new CodexEngine().parseTranscript(file));
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("message");
    expect(events[1]!.type).toBe("unknown");
    expect(events[1]!.raw).toContain("par");
  });

  it("yields an empty stream for an empty or missing file", async () => {
    expect(await collect(new CodexEngine().parseTranscript(writeFixture([])))).toEqual([]);
    expect(await collect(new CodexEngine().parseTranscript("/no/such/greg-missing.jsonl"))).toEqual([]);
  });

  it("truncates an oversized function_call arguments to MAX_TOOL_TEXT", () => {
    const big = "x".repeat(MAX_TOOL_TEXT + 500);
    const event = mapLine({
      type: "response_item",
      payload: { type: "function_call", name: "shell", arguments: big },
    })[0]!;
    expect(event.type).toBe("tool_use");
    expect(event.text!.length).toBeLessThan(big.length);
    expect(event.text!).toContain("truncated");
  });

  it("maps a non-object line to a single unknown", () => {
    expect(mapLine(42)).toEqual([{ type: "unknown", raw: 42 }]);
  });
});

describe("readSessionMeta — cwd + startedAt from session_meta (line 1)", () => {
  function writeRaw(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "greg-meta-"));
    tmpPaths.push(dir);
    const file = join(dir, "t.jsonl");
    writeFileSync(file, content);
    return file;
  }

  it("reads cwd + startedAt from the fixture's session_meta", () => {
    expect(readSessionMeta(FIXTURE)).toEqual({
      cwd: "/private/tmp/codex-probe",
      startedAt: "2026-06-18T06:29:16.570Z",
    });
  });

  it("returns null cwd when the first line is not yet newline-terminated (too fresh)", () => {
    const meta = readSessionMeta(
      writeRaw('{"type":"session_meta","payload":{"cwd":"/x","timestamp":"2026-01-01T00:00:00Z"}'), // no newline
    );
    expect(meta).toBeNull();
  });

  it("returns null for a missing file", () => {
    expect(readSessionMeta("/no/such/greg-missing.jsonl")).toBeNull();
  });

  it("survives an oversized first line (large base_instructions) and still finds the cwd", () => {
    const huge = "y".repeat(200 * 1024); // larger than the 64 KiB read chunk
    const line =
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-02-02T02:02:02.000Z",
        payload: { id: FIXTURE_UUID, cwd: "/work/big", base_instructions: { text: huge } },
      }) + "\n";
    expect(readSessionMeta(writeRaw(line))).toEqual({
      cwd: "/work/big",
      startedAt: "2026-02-02T02:02:02.000Z",
    });
  });
});

describe("identifyTranscript — inverse of (sessionId, cwd) for codex", () => {
  const sessionsRoot = join(homedir(), ".codex", "sessions");

  /** Write a rollout under the REAL codex sessions root (cleaned up after). */
  function writeRollout(lines: object[]): string {
    const dir = mkdtempSync(join(sessionsRoot, "greg-test-"));
    tmpPaths.push(dir);
    const file = join(dir, `rollout-2026-06-17T23-29-16-${FIXTURE_UUID}.jsonl`);
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
    return file;
  }

  it("returns null for a path outside ~/.codex/sessions", () => {
    expect(new CodexEngine().identifyTranscript("/tmp/elsewhere/rollout-x.jsonl")).toBeNull();
  });

  it("returns null for a non-rollout file under the sessions root", () => {
    mkdirSync(sessionsRoot, { recursive: true });
    expect(new CodexEngine().identifyTranscript(join(sessionsRoot, "notes.jsonl"))).toBeNull();
  });

  it("recovers sessionId from the filename and cwd + startedAt from session_meta", () => {
    mkdirSync(sessionsRoot, { recursive: true });
    const file = writeRollout([
      { type: "session_meta", payload: { id: FIXTURE_UUID, cwd: "/work/project", timestamp: "2026-06-18T06:29:16.570Z" } },
    ]);
    expect(new CodexEngine().identifyTranscript(file)).toEqual({
      sessionId: FIXTURE_UUID,
      cwd: "/work/project",
      startedAt: "2026-06-18T06:29:16.570Z",
    });
  });

  it("returns sessionId with cwd:null when session_meta isn't readable yet", () => {
    mkdirSync(sessionsRoot, { recursive: true });
    const file = writeRollout([{ type: "response_item", payload: { type: "message" } }]); // no session_meta first
    expect(new CodexEngine().identifyTranscript(file)).toEqual({
      sessionId: FIXTURE_UUID,
      cwd: null,
      startedAt: undefined,
    });
  });
});
