/**
 * `gregorian ui` — open the timeline in a browser. "Ensures the daemon is up" per the design: if a
 * healthy daemon is already published in `~/.gregorian/daemon.json`, reuse it; otherwise spawn one
 * DETACHED (so it outlives this short-lived CLI), wait for `/health`, then open the browser.
 *
 * Token delivery (Jupyter model): the daemon's API is bearer-authed but the served HTML carries no
 * secret. We pass the token in the opened URL's query string; the page reads it, stashes it, and strips
 * it from the address bar. So `ui` is the one place the token crosses into the browser.
 *
 * No silent failures: a daemon that never becomes healthy → a clear timeout error pointing at the log; a
 * browser that won't open → we print the URL for the user to open manually (never a crash, never a hang).
 *
 * The logic is a pure core (`runUi`) over injected effects so it is unit-tested without spawning a real
 * daemon or launching a real browser.
 */

import { spawn, spawnSync } from "node:child_process";
import { openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { readDaemonInfo, ensureHome, gregorianHome, type DaemonInfo } from "../../daemon/paths.js";

/** How long to wait for a freshly-spawned daemon to publish a healthy `/health`. */
const READY_TIMEOUT_MS = 10_000;
/** Poll cadence while waiting for readiness. */
const POLL_INTERVAL_MS = 250;

/** The injectable effects `runUi` needs — real implementations live in {@link uiCommand}. */
export interface UiDeps {
  /** Read the published daemon connection file, or `null` if none. */
  readInfo: () => DaemonInfo | null;
  /** Probe `/health` for a published daemon; resolves `false` on any error. */
  isHealthy: (info: DaemonInfo) => Promise<boolean>;
  /** Spawn the daemon detached (fire-and-forget; readiness is observed via polling). */
  spawnDaemon: () => void;
  /** Open the browser at `url`; returns `true` if the open command launched successfully. */
  openBrowser: (url: string) => boolean;
  /** Emit a user-facing line. */
  log: (msg: string) => void;
  /** Emit a user-facing error line. */
  error: (msg: string) => void;
  /** Resolve after `ms` (injected so tests don't wait on the wall clock). */
  sleep: (ms: number) => Promise<void>;
  /** Current epoch millis (injected for a deterministic timeout in tests). */
  now: () => number;
}

export interface UiOptions {
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
}

/** The URL `ui` opens — token in the query string so the served page can authenticate its API calls. */
export function uiUrl(info: DaemonInfo): string {
  return `http://127.0.0.1:${info.port}/?token=${encodeURIComponent(info.token)}`;
}

/**
 * Ensure a healthy daemon exists, returning its connection info. Reuses a running one; otherwise spawns
 * a detached daemon and polls until it's healthy or the timeout elapses (then throws a named error).
 */
export async function ensureDaemon(deps: UiDeps, opts: UiOptions = {}): Promise<DaemonInfo> {
  const timeout = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS;

  const existing = deps.readInfo();
  if (existing && (await deps.isHealthy(existing))) {
    deps.log("daemon already running.");
    return existing;
  }

  deps.log("daemon not running — starting it…");
  deps.spawnDaemon();

  const deadline = deps.now() + timeout;
  // First sleep gives the spawned daemon a beat to bind + publish before the first probe.
  while (deps.now() < deadline) {
    await deps.sleep(interval);
    const info = deps.readInfo();
    if (info && (await deps.isHealthy(info))) {
      deps.log("daemon is up.");
      return info;
    }
  }
  throw new Error(
    `daemon did not become ready within ${Math.round(timeout / 1000)}s. ` +
      `Check the log at ${join(gregorianHome(), "daemon.log")}.`,
  );
}

/** Pure command core: ensure the daemon, then open the browser. Returns a process exit code. */
export async function runUi(deps: UiDeps, opts: UiOptions = {}): Promise<number> {
  let info: DaemonInfo;
  try {
    info = await ensureDaemon(deps, opts);
  } catch (err) {
    deps.error(`gregorian ui: ${(err as Error).message}`);
    return 1;
  }

  const url = uiUrl(info);
  deps.log("opening the timeline in your browser…");
  if (!deps.openBrowser(url)) {
    // Not a failure of the daemon — just couldn't launch a browser (headless/SSH/no opener). Hand the
    // URL to the user so the command is still useful.
    deps.log(`Could not open a browser automatically. Open this URL manually:\n  ${url}`);
  }
  return 0;
}

/** Probe `/health` for a published daemon. Any network error (daemon down/booting) → `false`. */
async function probeHealth(info: DaemonInfo): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/** Spawn `gregorian daemon` detached, redirecting its stdio into `~/.gregorian/daemon.log`. */
function spawnDaemonDetached(): void {
  ensureHome();
  const logFd = openSync(join(gregorianHome(), "daemon.log"), "a");
  // The CLI entry sits one level up from this command module (src/cli/commands/ui.ts → src/cli/index.js).
  const cliEntry = fileURLToPath(new URL("../index.js", import.meta.url));
  const child = spawn(process.execPath, [cliEntry, "daemon"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
}

/** Launch the platform's URL opener synchronously; `true` if it started without error. */
function openBrowserPlatform(url: string): boolean {
  const [cmd, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const result = spawnSync(cmd, args, { stdio: "ignore" });
  return !result.error && (result.status === 0 || result.status === null);
}

export async function uiCommand(): Promise<number> {
  const deps: UiDeps = {
    readInfo: readDaemonInfo,
    isHealthy: probeHealth,
    spawnDaemon: spawnDaemonDetached,
    openBrowser: openBrowserPlatform,
    log: (m) => process.stdout.write(m + "\n"),
    error: (m) => process.stderr.write(m + "\n"),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
  return runUi(deps);
}
