/**
 * E2E codex loop test — the codex-adapter DoD end-to-end through a real {@link Daemon}, proving the
 * pending-row + spawn-window correlation works through real chokidar (incl. the depth fix for codex's
 * `YYYY/MM/DD/rollout-*.jsonl` nesting).
 *
 * A {@link FakeCodexEngine} stands in for `codex`: it cannot pre-assign its session id
 * (`preassignsSessionId = false`, `resolveTranscriptPath → null`), and its `start()` WRITES a nested
 * rollout (with a codex-chosen uuid + a `session_meta` line) and resolves `{ exitCode: 0,
 * transcriptPath: null }` — exactly the shape the real adapter has. The summarizer's `claude -p` is
 * stubbed. Real timers + polling drive schedule → fire(pending) → watcher-claim → record → minutes.
 *
 * DoD: a scheduled codex run is launched, correlated to its rollout (NOT double-recorded as ad-hoc),
 * and recorded `done` with minutes — attributed to the scheduled event, carrying codex's real session id.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Daemon } from "./daemon.js";
import type { ClaudeRunner } from "../minutes/summarizer.js";
import type {
  AgentEngine,
  RunHandle,
  TranscriptEvent,
  TranscriptIdentity,
} from "../engines/types.js";
import type { Event, Run } from "../types.js";

const silent = { log: () => {}, error: () => {} };
const CANNED = "The scheduled codex run produced a rollout and recorded no file changes.";

/**
 * A codex-shaped fake. `start()` writes a NESTED rollout `<root>/2026/06/17/rollout-<iso>-<uuid>.jsonl`
 * (3 dirs deep, exercising the watcher's depth fix) with a `session_meta` line carrying cwd + start time,
 * then resolves with NO transcript path (codex's real shape) — correlation is left to the watcher.
 */
class FakeCodexEngine implements AgentEngine {
  readonly id = "codex" as const;
  readonly preassignsSessionId = false;
  constructor(private readonly root: string) {}
  transcriptRoots(): string[] {
    return [this.root];
  }
  resolveTranscriptPath(): string | null {
    return null;
  }
  identifyTranscript(path: string): TranscriptIdentity | null {
    if (!path.startsWith(this.root + sep) || !path.endsWith(".jsonl")) return null;
    // sessionId = the trailing uuid (last 5 dash-groups of the stem), like the real engine.
    const stem = basename(path, ".jsonl");
    const m = /([0-9a-f-]{36})$/i.exec(stem);
    if (!m) return null;
    let cwd: string | null = null;
    let startedAt: string | undefined;
    try {
      const first = readFileSync(path, "utf8").split("\n")[0] ?? "";
      const meta = JSON.parse(first) as { payload?: { cwd?: string; timestamp?: string } };
      cwd = meta.payload?.cwd ?? null;
      startedAt = meta.payload?.timestamp;
    } catch {
      // too fresh → defer
    }
    return { sessionId: m[1]!, cwd, startedAt };
  }
  async *parseTranscript(): AsyncIterable<TranscriptEvent> {
    yield { type: "message", role: "assistant", text: "ran the scheduled codex work", raw: {} };
  }
  async start(event: Event): Promise<RunHandle> {
    const uuid = randomUUID();
    const dir = join(this.root, "2026", "06", "17");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-2026-06-17T23-29-16-${uuid}.jsonl`);
    writeFileSync(
      path,
      JSON.stringify({
        type: "session_meta",
        payload: { id: uuid, cwd: event.cwd, timestamp: new Date().toISOString() },
      }) +
        "\n" +
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
        }) +
        "\n",
    );
    return {
      sessionId: uuid,
      status: () => "done",
      // codex's real shape: no transcript path from the handle — the watcher correlates it.
      result: () => Promise.resolve({ sessionId: uuid, exitCode: 0, transcriptPath: null, diffStat: null }),
    };
  }
}

const cannedRunner: ClaudeRunner = async () => ({ exitCode: 0, stdout: CANNED, stderr: "" });

let home: string;
let cwd: string;
let root: string;
let daemon: Daemon;
let base: string;
let token: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "greg-codex-home-"));
  cwd = mkdtempSync(join(tmpdir(), "greg-codex-cwd-"));
  root = mkdtempSync(join(tmpdir(), "greg-codex-root-"));
  process.env.GREGORIAN_HOME = home;
  const engine = new FakeCodexEngine(root);
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

describe("daemon E2E codex loop (codex-adapter DoD)", () => {
  it("schedules codex → fires (pending) → watcher claims the rollout → done+minutes, no double-record", { timeout: 30000 }, async () => {
    const res = await fetch(`${base}/events`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        engine: "codex",
        cwd,
        scheduled_at: new Date(Date.now() + 250).toISOString(),
        prompt: "run the scheduled codex work",
      }),
    });
    expect(res.status).toBe(201);
    const { event } = (await res.json()) as { event: Event };

    // The run becomes done AND gains minutes — driven by the watcher's claim + idle finalize.
    await waitFor(async () => {
      const { runs } = await getJson<{ runs: Run[] }>("/runs");
      const run = runs.find((r) => r.role === "run");
      return run?.status === "done" && run.minutes != null;
    }, 15_000);

    // Exactly ONE user-facing run — the launched codex run was correlated, NOT double-recorded as ad-hoc.
    const { runs } = await getJson<{ runs: Run[] }>("/runs");
    const userRuns = runs.filter((r) => r.role === "run");
    expect(userRuns).toHaveLength(1);

    const run = userRuns[0]!;
    expect(run.engine).toBe("codex");
    expect(run.event_id).toBe(event.id); // attributed to the SCHEDULED event, not a fresh ad-hoc one
    expect(run.session_id).not.toMatch(/^pending:/); // backfilled to codex's real rollout uuid
    expect(run.status).toBe("done");
    expect(run.minutes).toBe(CANNED);
    expect(run.transcript_path).toContain("rollout-");

    // Only the one scheduled event exists (no ad-hoc twin), and it reads done.
    const { events } = await getJson<{ events: Event[] }>("/events");
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(event.id);
    expect(events[0]!.schedule_kind).toBe("once");
    expect(events[0]!.status).toBe("done");
  });
});
