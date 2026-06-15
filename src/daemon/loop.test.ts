/**
 * E2E loop test — the m2 DoD, end-to-end through a real {@link Daemon} (the one real-loop test; the
 * focused edge cases live in the deterministic unit tests).
 *
 * A {@link FakeLoopEngine} stands in for `claude`: its `start()` WRITES a transcript at the resolved
 * path and resolves `{ exitCode: 0, transcriptPath }`, and it implements the full engine seam
 * (resolveTranscriptPath / parseTranscript / identifyTranscript / transcriptRoots) over a temp root —
 * so no real `claude`, no `~/.claude`, no API key. The summarizer's `claude -p` is stubbed to canned
 * minutes. Real timers + polling drive the genuine schedule → fire → record → minutes loop.
 *
 * DoD: schedule an event ~250ms out → the daemon fires it → the run is recorded `done` with a duration
 * and exit 0 → minutes attach → `GET /runs`, `GET /events`, and `GET /events/:id` all reflect it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Daemon } from "./daemon.js";
import type { ClaudeRunner } from "../minutes/summarizer.js";
import type {
  AgentEngine,
  RunHandle,
  StartOptions,
  TranscriptEvent,
  TranscriptIdentity,
} from "../engines/types.js";
import type { Event, Run } from "../types.js";

const silent = { log: () => {}, error: () => {} };
const CANNED = "The scheduled agent ran, produced a transcript, and recorded no file changes.";

/** A fake engine whose `start()` actually writes a transcript, so the full record loop has real data. */
class FakeLoopEngine implements AgentEngine {
  readonly id = "claude" as const;
  constructor(private readonly root: string) {}
  transcriptRoots(): string[] {
    return [this.root];
  }
  resolveTranscriptPath(sessionId: string): string | null {
    return join(this.root, "proj", `${sessionId}.jsonl`);
  }
  identifyTranscript(path: string): TranscriptIdentity | null {
    if (!path.startsWith(this.root + sep) || !path.endsWith(".jsonl")) return null;
    return { sessionId: basename(path, ".jsonl"), cwd: null };
  }
  async *parseTranscript(): AsyncIterable<TranscriptEvent> {
    yield { type: "message", role: "assistant", text: "ran the scheduled work", raw: {} };
  }
  async start(event: Event, opts: StartOptions): Promise<RunHandle> {
    const path = this.resolveTranscriptPath(opts.sessionId)!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ type: "user", cwd: event.cwd, message: { content: "go" } }) +
        "\n" +
        JSON.stringify({ type: "assistant", message: { content: "done" } }) +
        "\n",
    );
    return {
      sessionId: opts.sessionId,
      status: () => "done",
      result: () =>
        Promise.resolve({ sessionId: opts.sessionId, exitCode: 0, transcriptPath: path, diffStat: null }),
    };
  }
}

/** Stub summarizer `claude -p` — canned minutes, no real spawn. */
const cannedRunner: ClaudeRunner = async () => ({ exitCode: 0, stdout: CANNED, stderr: "" });

let home: string;
let cwd: string;
let root: string;
let daemon: Daemon;
let base: string;
let token: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "greg-loop-home-"));
  cwd = mkdtempSync(join(tmpdir(), "greg-loop-cwd-")); // a real dir so the R6 cwd check passes
  root = mkdtempSync(join(tmpdir(), "greg-loop-root-")); // fake transcript root (not ~/.claude)
  process.env.GREGORIAN_HOME = home;
  const engine = new FakeLoopEngine(root);
  daemon = new Daemon({
    port: 0,
    logger: silent,
    engineResolver: () => engine,
    engines: [engine],
    idleMs: 200,
    summarizerRunner: cannedRunner,
  });
  const info = await daemon.start();
  base = `http://127.0.0.1:${info.port}`;
  token = info.token;
});

afterEach(async () => {
  await daemon.stop();
  delete process.env.GREGORIAN_HOME;
  for (const dir of [home, cwd, root]) rmSync(dir, { recursive: true, force: true });
});

const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

async function getJson<T>(path: string): Promise<T> {
  return (await (await fetch(`${base}${path}`, { headers: auth() })).json()) as T;
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("daemon E2E loop (m2 DoD)", () => {
  it("schedules → fires → records done+duration → attaches minutes, visible across the API", { timeout: 30000 }, async () => {
    const res = await fetch(`${base}/events`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        engine: "claude",
        cwd,
        scheduled_at: new Date(Date.now() + 250).toISOString(), // fires ~250ms out
        prompt: "run the scheduled work",
      }),
    });
    expect(res.status).toBe(201);
    const { event } = (await res.json()) as { event: Event };

    // Poll the real loop: the run becomes `done` AND gains minutes.
    await waitFor(async () => {
      const { runs } = await getJson<{ runs: Run[] }>("/runs");
      const run = runs.find((r) => r.role === "run");
      return run?.status === "done" && run.minutes != null;
    }, 10_000);

    // The run is recorded done, with an exit code, an end time (duration), and the canned minutes.
    const { runs } = await getJson<{ runs: Run[] }>("/runs");
    const run = runs.find((r) => r.role === "run")!;
    expect(run.status).toBe("done");
    expect(run.exit_code).toBe(0);
    expect(run.started_at).toBeTruthy();
    expect(run.ended_at).toBeTruthy();
    expect(run.minutes).toBe(CANNED);

    // The event reads done…
    const { events } = await getJson<{ events: Event[] }>("/events");
    expect(events.find((e) => e.id === event.id)!.status).toBe("done");

    // …and the detail route carries the same minutes (the m5-reusable shape).
    const detail = await getJson<{ event: Event; runs: Run[] }>(`/events/${event.id}`);
    expect(detail.event.id).toBe(event.id);
    expect(detail.runs.find((r) => r.role === "run")!.minutes).toBe(CANNED);
  });
});
