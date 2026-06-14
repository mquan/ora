/**
 * Tests for the minutes summarizer.
 *
 * Two layers:
 *   1. Deterministic units (ALWAYS run): the `claude` spawn is stubbed via the {@link ClaudeRunner}
 *      seam, so these are fast, offline, and need no auth. They cover condensation budgeting, the
 *      prompt shape, and every failure-mode → no-fabricated-minutes path.
 *   2. A gated `[EVAL]` (runs only with `GREGORIAN_EVAL=1`): summarizes a real fixture transcript
 *      with the REAL `claude` binary and asserts the minutes are substantive — the "a human would
 *      read it" quality check from the test plan. Skipped in CI (no claude login).
 */

import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildMinutesPrompt,
  condenseTranscript,
  newSummarizerSessionId,
  summarize,
  MAX_ERROR_CHARS,
  MAX_LINE_CHARS,
  type ClaudeRunner,
  type ClaudeRunnerArgs,
  type ClaudeRunnerResult,
} from "./summarizer.js";
import { ClaudeEngine } from "../engines/claude.js";
import type { TranscriptEvent } from "../engines/types.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/sample-transcript.jsonl", import.meta.url));

async function* iter(...events: TranscriptEvent[]): AsyncIterable<TranscriptEvent> {
  for (const e of events) yield e;
}

/** A stub runner that records its calls and returns a canned result. */
function stubRunner(result: ClaudeRunnerResult): {
  runner: ClaudeRunner;
  calls: ClaudeRunnerArgs[];
} {
  const calls: ClaudeRunnerArgs[] = [];
  const runner: ClaudeRunner = async (args) => {
    calls.push(args);
    return result;
  };
  return { runner, calls };
}

const OK = (stdout: string): ClaudeRunnerResult => ({ exitCode: 0, stdout, stderr: "" });

describe("condenseTranscript", () => {
  it("renders message/tool_use/tool_result lines and drops system/unknown noise", async () => {
    const { text, eventCount, truncated } = await condenseTranscript(
      iter(
        { type: "system", text: "init", raw: {} },
        { type: "message", role: "assistant", text: "I will add a helper.", raw: {} },
        { type: "tool_use", toolName: "Bash", text: '{"command":"ls"}', raw: {} },
        { type: "tool_result", text: "file.ts", raw: {} },
        { type: "unknown", raw: {} },
      ),
    );
    expect(eventCount).toBe(3); // message + tool_use + tool_result; system/unknown skipped
    expect(truncated).toBe(false);
    expect(text).toContain("assistant: I will add a helper.");
    expect(text).toContain("tool[Bash]:");
    expect(text).toContain("result: file.ts");
    expect(text).not.toContain("init");
  });

  it("caps an over-long line", async () => {
    const long = "x".repeat(MAX_LINE_CHARS * 3);
    const { text } = await condenseTranscript(
      iter({ type: "message", role: "assistant", text: long, raw: {} }),
    );
    expect(text).toContain("… (truncated)");
    // The line is bounded to the cap (+ the marker), not the full 3x length.
    expect(text.length).toBeLessThan(MAX_LINE_CHARS + 100);
  });

  it("retains head + tail and flags truncation when over budget", async () => {
    const events: TranscriptEvent[] = [];
    for (let i = 0; i < 8; i++) {
      events.push({ type: "message", role: "assistant", text: `n${i}-${"x".repeat(40)}`, raw: {} });
    }
    const { text, truncated, eventCount } = await condenseTranscript(iter(...events), 160);
    expect(eventCount).toBe(8);
    expect(truncated).toBe(true);
    expect(text).toContain("n0-"); // head retained
    expect(text).toContain("n7-"); // tail retained
    expect(text).toContain("omitted");
  });

  it("reports zero events for an all-noise transcript", async () => {
    const { eventCount } = await condenseTranscript(
      iter({ type: "system", text: "x", raw: {} }, { type: "unknown", raw: {} }),
    );
    expect(eventCount).toBe(0);
  });
});

describe("buildMinutesPrompt", () => {
  it("embeds the transcript, diff, and asked prompt, and asks for three sentences", () => {
    const p = buildMinutesPrompt({
      condensed: "assistant: did the thing",
      diffStat: "src/x.ts | 2 +-",
      prompt: "do the thing",
      cwd: "/repo",
      engine: "claude",
    });
    expect(p).toContain("assistant: did the thing");
    expect(p).toContain("src/x.ts | 2 +-");
    expect(p).toContain("do the thing");
    expect(p).toContain("/repo");
    expect(p).toContain("exactly three sentences");
  });

  it("falls back cleanly for null diff and null prompt", () => {
    const p = buildMinutesPrompt({ condensed: "x", diffStat: null, prompt: null });
    expect(p).toContain("(no file changes recorded)");
    expect(p).toContain("(ad-hoc session — no recorded prompt)");
  });
});

describe("summarize — success", () => {
  it("returns trimmed minutes, echoes the session id, and calls the runner with it", async () => {
    const { runner, calls } = stubRunner(OK("  Did the work. Wrote a file. Tests pass.\n"));
    const res = await summarize(
      {
        transcript: iter({ type: "message", role: "assistant", text: "wrote src/x.ts", raw: {} }),
        diffStat: "src/x.ts | 3 +++",
        prompt: "add x",
      },
      { sessionId: "SUMM-123", runner },
    );
    expect(res.ok).toBe(true);
    expect(res.minutes).toBe("Did the work. Wrote a file. Tests pass.");
    expect(res.sessionId).toBe("SUMM-123");
    expect(res.error).toBeNull();
    expect(res.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.sessionId).toBe("SUMM-123");
    expect(call.prompt).toContain("wrote src/x.ts");
    expect(call.prompt).toContain("src/x.ts | 3 +++");
  });

  it("generates and returns a session id when none is supplied", async () => {
    const { runner, calls } = stubRunner(OK("Minutes."));
    const res = await summarize(
      { transcript: iter({ type: "message", role: "assistant", text: "hi", raw: {} }), diffStat: null },
      { runner },
    );
    expect(res.ok).toBe(true);
    expect(res.sessionId).toBeTruthy();
    expect(calls[0]!.sessionId).toBe(res.sessionId);
  });

  it("summarizes a transcript that has content even when the run itself failed", async () => {
    // The summarizer only sees the transcript, not the run's exit code — content ⇒ minutes.
    const { runner } = stubRunner(OK("The run errored partway. Edited one file. Then crashed."));
    const res = await summarize(
      { transcript: iter({ type: "message", role: "assistant", text: "edited then crashed", raw: {} }), diffStat: null },
      { sessionId: "s", runner },
    );
    expect(res.ok).toBe(true);
    expect(res.minutes).toContain("crashed");
  });
});

describe("summarize — no fabricated minutes", () => {
  it("empty transcript → ok:false and the runner is never invoked", async () => {
    const { runner, calls } = stubRunner(OK("should not be used"));
    const res = await summarize({ transcript: iter(), diffStat: "x" }, { sessionId: "s", runner });
    expect(res.ok).toBe(false);
    expect(res.minutes).toBeNull();
    expect(res.exitCode).toBeNull();
    expect(res.error).toContain("empty");
    expect(calls).toHaveLength(0);
  });

  it("all-noise transcript → ok:false, no claude pass", async () => {
    const { runner, calls } = stubRunner(OK("nope"));
    const res = await summarize(
      { transcript: iter({ type: "system", text: "init", raw: {} }), diffStat: null },
      { sessionId: "s", runner },
    );
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("non-zero exit → ok:false with exit code + stderr surfaced", async () => {
    const { runner } = stubRunner({ exitCode: 2, stdout: "", stderr: "boom" });
    const res = await summarize(
      { transcript: iter({ type: "message", role: "assistant", text: "x", raw: {} }), diffStat: null },
      { sessionId: "s", runner },
    );
    expect(res.ok).toBe(false);
    expect(res.minutes).toBeNull();
    expect(res.exitCode).toBe(2);
    expect(res.error).toContain("exited 2");
    expect(res.error).toContain("boom");
  });

  it("spawn error → ok:false, surfaced as a start failure", async () => {
    const { runner } = stubRunner({ exitCode: null, stdout: "", stderr: "ENOENT", spawnError: true });
    const res = await summarize(
      { transcript: iter({ type: "message", role: "assistant", text: "x", raw: {} }), diffStat: null },
      { sessionId: "s", runner },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("failed to start");
  });

  it("timeout → ok:false, surfaced as a timeout", async () => {
    const { runner } = stubRunner({ exitCode: null, stdout: "", stderr: "", timedOut: true });
    const res = await summarize(
      { transcript: iter({ type: "message", role: "assistant", text: "x", raw: {} }), diffStat: null },
      { sessionId: "s", runner, timeoutMs: 5000 },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("timed out");
  });

  it("exit 0 but blank stdout → ok:false (no fabricated minutes)", async () => {
    const { runner } = stubRunner(OK("   \n  "));
    const res = await summarize(
      { transcript: iter({ type: "message", role: "assistant", text: "x", raw: {} }), diffStat: null },
      { sessionId: "s", runner },
    );
    expect(res.ok).toBe(false);
    expect(res.minutes).toBeNull();
    expect(res.error).toContain("no output");
  });

  it("bounds a runaway stderr in the surfaced error", async () => {
    const { runner } = stubRunner({ exitCode: 1, stdout: "", stderr: "E".repeat(MAX_ERROR_CHARS * 3) });
    const res = await summarize(
      { transcript: iter({ type: "message", role: "assistant", text: "x", raw: {} }), diffStat: null },
      { sessionId: "s", runner },
    );
    expect(res.ok).toBe(false);
    expect(res.error).not.toBeNull();
    expect((res.error as string).length).toBeLessThanOrEqual(MAX_ERROR_CHARS + 20);
  });
});

describe("summarize — realistic transcript via ClaudeEngine.parseTranscript", () => {
  it("parses the fixture and grounds the prompt in its real content (no model call)", async () => {
    const engine = new ClaudeEngine();
    const { runner, calls } = stubRunner(OK("Added slugify and a test. It passes. Done."));
    const res = await summarize(
      {
        transcript: engine.parseTranscript(FIXTURE),
        diffStat: "src/strings.ts | 3 +++\n src/strings.test.ts | 5 +++++",
        prompt: "Add a slugify helper and a test",
        cwd: "/repo",
        engine: "claude",
      },
      { sessionId: "SUMM-fix", runner },
    );
    expect(res.ok).toBe(true);
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain("slugify"); // real transcript text flowed through
    expect(prompt).toContain("Write"); // a tool_use name from the transcript
    expect(prompt).toContain("src/strings.ts | 3 +++"); // the diff
  });
});

// Gated quality eval — real `claude`, real auth. Run with: GREGORIAN_EVAL=1 npm test
describe.runIf(Boolean(process.env.GREGORIAN_EVAL))("summarize — [EVAL] minutes quality", () => {
  it(
    "produces substantive minutes a human would read",
    async () => {
      const engine = new ClaudeEngine();
      const res = await summarize(
        {
          transcript: engine.parseTranscript(FIXTURE),
          diffStat: "src/strings.ts | 3 +++\n src/strings.test.ts | 5 +++++",
          prompt: "Add a slugify helper and a test",
          cwd: "/repo",
          engine: "claude",
        },
        { sessionId: newSummarizerSessionId() },
      );
      expect(res.ok).toBe(true);
      const minutes = res.minutes as string;
      expect(minutes.length).toBeGreaterThan(40);
      // Roughly three sentences and grounded in the fixture's actual work.
      const sentences = minutes.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
      expect(sentences.length).toBeGreaterThanOrEqual(2);
      expect(minutes.toLowerCase()).toMatch(/slug|strings|test/);
    },
    180_000,
  );
});
