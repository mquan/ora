/**
 * Tests for the shared adapter base: detached spawn → RunHandle lifecycle, and the git
 * before/after snapshot helper (DoD). A tiny in-file {@link TestAdapter} stands in for a real
 * engine by running a `node -e` one-liner instead of `claude`/`codex`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentAdapterBase, ChildRunHandle, captureGitSnapshot, gitDiffStat } from "./base.js";
import type { SpawnSpec, TranscriptEvent, TranscriptIdentity } from "./types.js";
import type { Event } from "../types.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeEvent(cwd: string, overrides: Partial<Event> = {}): Event {
  return {
    id: "evt-test",
    title: "test",
    engine: "claude",
    model: null,
    cwd,
    prompt: "noop",
    mentions: null,
    schedule_kind: "once",
    scheduled_at: null,
    recurrence_rule_id: null,
    status: "scheduled",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Runs an arbitrary `node -e <script>` as a stand-in agent. */
class TestAdapter extends AgentAdapterBase {
  readonly id = "claude" as const;

  constructor(private readonly script: string) {
    super();
  }

  protected buildSpawn(event: Event, sessionId: string): SpawnSpec {
    return {
      command: process.execPath,
      args: ["-e", this.script],
      env: { GREG_TEST_SESSION: sessionId, GREG_TEST_CWD: event.cwd },
    };
  }

  resolveTranscriptPath(sessionId: string): string {
    return `/tmp/${sessionId}.jsonl`;
  }

  // Exercised in t4 (claude adapter); a stub here keeps the base test focused on spawn + snapshot.
  async *parseTranscript(): AsyncIterable<TranscriptEvent> {}

  transcriptRoots(): string[] {
    return ["/tmp"];
  }

  // Exercised in t4 (claude adapter); a stub keeps the base test focused on spawn + snapshot.
  identifyTranscript(): TranscriptIdentity | null {
    return null;
  }
}

describe("AgentAdapterBase.start", () => {
  it("resolves a RunHandle that reports success on a clean exit", async () => {
    const adapter = new TestAdapter("process.exit(0)");
    const handle = await adapter.start(makeEvent("/tmp"), {
      sessionId: "s-ok",
      beforeSnapshot: false,
    });

    expect(handle.sessionId).toBe("s-ok");
    expect(handle.status()).toBe("running");

    const result = await handle.result();
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("s-ok");
    expect(result.transcriptPath).toBe("/tmp/s-ok.jsonl");
    expect(handle.status()).toBe("done");
  });

  it("reports failure on a non-zero exit code", async () => {
    const adapter = new TestAdapter("process.exit(3)");
    const handle = await adapter.start(makeEvent("/tmp"), {
      sessionId: "s-fail",
      beforeSnapshot: false,
    });

    const result = await handle.result();
    expect(result.exitCode).toBe(3);
    expect(handle.status()).toBe("failed");
  });

  it("spawns detached as its own process-group leader", async () => {
    const adapter = new TestAdapter("setTimeout(() => process.exit(0), 400)");
    const handle = (await adapter.start(makeEvent("/tmp"), {
      sessionId: "s-detach",
      beforeSnapshot: false,
    })) as ChildRunHandle;

    const pid = handle.pid;
    if (pid === undefined) throw new Error("expected a spawned pid");
    // A detached child leads its own process group (pgid === pid). Signalling the group `-pid`
    // (signal 0 = existence check, no actual kill) only succeeds if that group exists — i.e. the
    // child was setsid'd away from the parent's group, so a daemon restart can't reap it.
    expect(() => process.kill(-pid, 0)).not.toThrow();

    const result = await handle.result();
    expect(result.exitCode).toBe(0);
  });

  it("settles failed with exitCode null when the process cannot spawn (no hang)", async () => {
    const adapter = new TestAdapter("process.exit(0)");
    const handle = await adapter.start(makeEvent("/no/such/dir/greg-does-not-exist"), {
      sessionId: "s-err",
      beforeSnapshot: false,
    });

    const result = await handle.result();
    expect(result.exitCode).toBeNull();
    expect(handle.status()).toBe("failed");
  });
});

describe("git snapshot helpers", () => {
  const dirs: string[] = [];

  function tmp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("captures both tracked modifications and untracked new files in the diff stat", async () => {
    const repo = tmp("greg-repo-");
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");

    const before = await captureGitSnapshot(repo);
    expect(before.ref).not.toBeNull();

    writeFileSync(join(repo, "a.txt"), "one\ntwo\n"); // modify tracked
    writeFileSync(join(repo, "b.txt"), "brand new\n"); // create untracked

    const stat = await gitDiffStat(before);
    expect(stat).not.toBeNull();
    expect(stat).toContain("a.txt");
    expect(stat).toContain("b.txt"); // untracked file is captured — the F2 guarantee
  });

  it("returns a null ref and null diff for a non-git directory", async () => {
    const plain = tmp("greg-plain-");
    const snap = await captureGitSnapshot(plain);
    expect(snap.ref).toBeNull();
    expect(await gitDiffStat(snap)).toBeNull();
  });

  it("snapshots a repo with no commits (unborn HEAD, working file present)", async () => {
    const fresh = tmp("greg-fresh-");
    git(fresh, "init", "-q");
    writeFileSync(join(fresh, "x.txt"), "hi\n");

    const snap = await captureGitSnapshot(fresh);
    expect(snap.ref).not.toBeNull();
  });

  it("returns an empty (non-null) stat when nothing changed", async () => {
    const repo = tmp("greg-nochange-");
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");

    const before = await captureGitSnapshot(repo);
    const stat = await gitDiffStat(before);
    expect(stat).toBe(""); // distinct from null ("unavailable")
  });
});
