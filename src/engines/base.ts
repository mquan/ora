/**
 * Shared adapter base — the one place detached-spawn and git before/after snapshot live.
 *
 * Concrete engines (`./claude` in t4, `./codex` in t9) extend {@link AgentAdapterBase} and supply
 * only flags (`buildSpawn`), transcript path resolution, and parsing. They never re-implement
 * process spawning or diffing. The base spawns DETACHED (own process group) so an in-flight run
 * survives a daemon restart, and the watcher (m2) re-attaches by `sessionId` — `result()` here is
 * just the daemon-alive convenience path (design doc §A1, edge case 1).
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineKind, Event, RunStatus } from "../types.js";
import type {
  AgentEngine,
  GitSnapshot,
  RunHandle,
  RunResult,
  SpawnSpec,
  StartOptions,
  TranscriptEvent,
} from "./types.js";

const execFileAsync = promisify(execFile);

/** Generous cap: a `git diff --stat` over a big run can be large, but is bounded. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Run `git` with `execFile` (no shell — args are never interpolated). `extraEnv` is merged over
 * `process.env`; used to relocate the index via `GIT_INDEX_FILE` so snapshots never touch the
 * user's real index.
 */
async function execGit(
  cwd: string,
  args: string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout.toString();
}

/**
 * Snapshot the full working-tree state of `cwd` as a git tree SHA — tracked + staged + untracked,
 * minus gitignored — WITHOUT mutating the repo. Done by pointing `GIT_INDEX_FILE` at a throwaway
 * index, `git add -A` into it, then `git write-tree`. Returns `null` if `cwd` is not a git repo
 * (or any git step fails); callers treat that as "no diff available", never an error.
 *
 * `git add -A` against an empty temp index stages every present file, so the resulting tree is a
 * complete snapshot — diffing two such trees yields adds, deletes, and modifications. It does not
 * require a HEAD commit, so brand-new repos snapshot fine.
 */
async function snapshotTree(cwd: string): Promise<string | null> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "greg-idx-"));
    const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: join(dir, "index") };
    await execGit(cwd, ["add", "-A"], env);
    const tree = (await execGit(cwd, ["write-tree"], env)).trim();
    return tree.length > 0 ? tree : null;
  } catch {
    // Not a git repo, missing git binary, or unusable repo state → best-effort: no snapshot.
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Capture a git "before" reference for a launch. `ref` is `null` for non-repo cwds, in which case
 * {@link gitDiffStat} later resolves to `null` rather than throwing.
 */
export async function captureGitSnapshot(cwd: string): Promise<GitSnapshot> {
  return { cwd, ref: await snapshotTree(cwd) };
}

/**
 * Compute `git diff --stat` between the "before" snapshot and the current working-tree state.
 * Returns `null` when no before-ref exists or the after-snapshot/diff fails (best-effort). An
 * empty string means "no changes" and is returned as-is (distinct from `null` = "unavailable").
 */
export async function gitDiffStat(snapshot: GitSnapshot): Promise<string | null> {
  if (snapshot.ref === null) return null;
  const after = await snapshotTree(snapshot.cwd);
  if (after === null) return null;
  try {
    return (await execGit(snapshot.cwd, ["diff", "--stat", snapshot.ref, after])).trimEnd();
  } catch {
    return null;
  }
}

/**
 * Spawn a child DETACHED: `detached: true` makes it a process-group leader (its own pgid via
 * setsid), and `unref()` lets the parent (daemon) exit or restart without reaping it. stdio is
 * ignored — the agent's on-disk transcript is gregorian's record of truth, not captured stdout.
 */
export function spawnDetached(spec: SpawnSpec, opts: { cwd: string }): ChildProcess {
  const child = spawn(spec.command, spec.args, {
    cwd: opts.cwd,
    env: spec.env ? { ...process.env, ...spec.env } : process.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

/** Internal: how {@link AgentAdapterBase} finalizes a run once the child settles. */
type Finalizer = (outcome: { exitCode: number | null }) => Promise<RunResult>;

/**
 * Concrete {@link RunHandle} over a spawned child. Listens for BOTH `exit` and `error`, registered
 * synchronously in the constructor, so `result()` resolves exactly once and NEVER hangs — a child
 * that fails to spawn (bad cwd, missing binary) settles `failed` with `exitCode: null`. `result()`
 * also never rejects: if finalization (the diff pass) throws, it falls back to a result with no
 * diff. Exposes `pid` + `sessionId` for the watcher's restart re-attach.
 */
export class ChildRunHandle implements RunHandle {
  readonly sessionId: string;
  readonly pid: number | undefined;
  private _status: RunStatus = "running";
  private readonly _result: Promise<RunResult>;

  constructor(sessionId: string, child: ChildProcess, finalize: Finalizer) {
    this.sessionId = sessionId;
    this.pid = child.pid;
    this._result = new Promise<RunResult>((resolve) => {
      let settled = false;
      const settle = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        this._status = exitCode === 0 ? "done" : "failed";
        finalize({ exitCode }).then(resolve, () =>
          resolve({ sessionId, exitCode, transcriptPath: null, diffStat: null }),
        );
      };
      // A signal-killed process reports `code === null` → settles `failed`.
      child.once("exit", (code) => settle(code));
      child.once("error", () => settle(null));
    });
  }

  status(): RunStatus {
    return this._status;
  }

  result(): Promise<RunResult> {
    return this._result;
  }
}

/**
 * Base class every engine extends. Implements `start()` end-to-end (snapshot → detached spawn →
 * pollable handle). Subclasses supply the engine-specific seam: `id`, `buildSpawn` (flags),
 * `resolveTranscriptPath`, `parseTranscript`, and `transcriptRoots`.
 */
export abstract class AgentAdapterBase implements AgentEngine {
  abstract readonly id: EngineKind;

  /** Engine-specific command + flags for a launch (e.g. `claude --session-id <id> -p <prompt>`). */
  protected abstract buildSpawn(event: Event, sessionId: string): SpawnSpec;

  /** Where this engine will write the transcript for `sessionId`, or `null` if not predictable. */
  abstract resolveTranscriptPath(sessionId: string, cwd: string): string | null;

  abstract parseTranscript(path: string): AsyncIterable<TranscriptEvent>;

  abstract transcriptRoots(): string[];

  async start(event: Event, opts: StartOptions): Promise<RunHandle> {
    const snapshot = opts.beforeSnapshot ? await captureGitSnapshot(event.cwd) : null;
    const spec = this.buildSpawn(event, opts.sessionId);
    // No `await` between spawn and handle construction: the exit/error listeners must be attached
    // synchronously so an immediate spawn error can't fire before we're listening.
    const child = spawnDetached(spec, { cwd: event.cwd });
    const finalize: Finalizer = async ({ exitCode }) => ({
      sessionId: opts.sessionId,
      exitCode,
      transcriptPath: this.resolveTranscriptPath(opts.sessionId, event.cwd),
      diffStat: snapshot ? await gitDiffStat(snapshot) : null,
    });
    return new ChildRunHandle(opts.sessionId, child, finalize);
  }
}
