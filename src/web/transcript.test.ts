/**
 * `readRunTranscript` unit tests — the data source for the web transcript viewer.
 *
 * Focus is the no-silent-failure contract: a null path, a deleted file, a corrupt JSONL line, and an
 * unimplemented engine each return a 200-shaped result with a named `reason` (never a throw), plus the
 * memory bounds (entry + byte caps) actually truncate.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readRunTranscript } from "./transcript.js";
import type { EngineResolver } from "../daemon/scheduler.js";
import type { AgentEngine, TranscriptEvent } from "../engines/types.js";
import type { Run } from "../types.js";

/** A Run fixture; override what each test cares about. */
function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    event_id: "evt-1",
    engine: "claude",
    session_id: "sess-1",
    role: "run",
    transcript_path: "/tmp/does-not-matter.jsonl",
    transcript_offset: 0,
    started_at: null,
    ended_at: null,
    exit_code: null,
    diff_stat: null,
    minutes: null,
    status: "done",
    error: null,
    ...over,
  };
}

const ev = (text: string): TranscriptEvent => ({ type: "message", role: "assistant", text, raw: { text } });

/** An engine whose `parseTranscript` yields a caller-supplied sequence (or throws). */
function stubEngine(parse: (path: string) => AsyncIterable<TranscriptEvent>): AgentEngine {
  return {
    id: "claude",
    start: () => Promise.reject(new Error("unused")),
    resolveTranscriptPath: () => null,
    parseTranscript: parse,
    transcriptRoots: () => [],
    identifyTranscript: () => null,
  } as unknown as AgentEngine;
}

const resolverFor = (engine: AgentEngine): EngineResolver => () => engine;

describe("readRunTranscript", () => {
  it("returns the normalized entries on a healthy transcript", async () => {
    const engine = stubEngine(async function* () {
      yield ev("hello");
      yield ev("world");
    });
    const result = await readRunTranscript(makeRun(), resolverFor(engine));
    expect(result.entries.map((e) => e.text)).toEqual(["hello", "world"]);
    expect(result.truncated).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("returns a named reason (not a throw) when the run has no transcript path", async () => {
    const engine = stubEngine(async function* () {
      yield* []; // never reached — no transcript path means parseTranscript isn't called
    });
    const result = await readRunTranscript(makeRun({ transcript_path: null }), resolverFor(engine));
    expect(result.path).toBeNull();
    expect(result.entries).toEqual([]);
    expect(result.reason).toMatch(/no transcript/i);
  });

  it("surfaces a missing transcript file as a named reason (PR3)", async () => {
    const engine = stubEngine(async function* () {
      yield* []; // opens the file, finds it gone → throws before any entry
      const err = new Error("nope") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const result = await readRunTranscript(makeRun(), resolverFor(engine));
    expect(result.reason).toMatch(/not found/i);
    expect(result.truncated).toBe(true);
  });

  it("returns what parsed plus a named reason on a corrupt JSONL line (PR4)", async () => {
    const engine = stubEngine(async function* () {
      yield ev("first");
      throw new Error("unexpected token in JSON");
    });
    const result = await readRunTranscript(makeRun(), resolverFor(engine));
    expect(result.entries.map((e) => e.text)).toEqual(["first"]);
    expect(result.reason).toMatch(/could not be fully read/i);
    expect(result.truncated).toBe(true);
  });

  it("returns a named reason for an engine that isn't available yet (PR5)", async () => {
    const throwingResolver: EngineResolver = () => {
      throw new Error("UnsupportedEngine");
    };
    const result = await readRunTranscript(makeRun({ engine: "codex" }), throwingResolver);
    expect(result.entries).toEqual([]);
    expect(result.reason).toMatch(/engine 'codex' not available/i);
  });

  it("truncates at the entry cap", async () => {
    const engine = stubEngine(async function* () {
      for (let i = 0; i < 100; i++) yield ev(`line ${i}`);
    });
    const result = await readRunTranscript(makeRun(), resolverFor(engine), { maxEntries: 10 });
    expect(result.entries).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  it("truncates at the byte cap", async () => {
    const big = "x".repeat(1000);
    const engine = stubEngine(async function* () {
      for (let i = 0; i < 100; i++) yield ev(big);
    });
    const result = await readRunTranscript(makeRun(), resolverFor(engine), { maxBytes: 5000 });
    expect(result.truncated).toBe(true);
    expect(result.entries.length).toBeLessThan(100);
  });

  it("reports the on-disk byte size when the file exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "greg-transcript-"));
    const path = join(dir, "t.jsonl");
    writeFileSync(path, "some bytes here");
    try {
      const engine = stubEngine(async function* () {
        yield ev("ok");
      });
      const result = await readRunTranscript(makeRun({ transcript_path: path }), resolverFor(engine));
      expect(result.byteSize).toBe("some bytes here".length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
