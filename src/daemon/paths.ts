/**
 * Filesystem contract for ora's local state — the single place that knows where
 * `~/.ora/` lives and how the daemon connection file is shaped.
 *
 * Both the daemon (writer) and the CLI client (reader) import this, so the `db` path, the
 * `daemon.json` shape, and the home-dir resolution exist exactly once (DRY). `ORA_HOME`
 * overrides the default `~/.ora` — required for hermetic tests, and handy for relocating
 * state. The connection file is written **atomically** (temp + rename) so a reader never sees a
 * half-written file, and `0600` so other local users can't read the daemon token.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  chmodSync,
} from "node:fs";

/** What the daemon publishes so a CLI/web client can reach it. */
export interface DaemonInfo {
  /** TCP port the daemon's loopback HTTP server is bound to. */
  port: number;
  /** Bearer token the client must present on every authed request. */
  token: string;
  /** Daemon process id — for diagnostics and a future `ora stop`. */
  pid: number;
  /** ISO time the daemon started. */
  startedAt: string;
}

/** Root of ora's local state. `ORA_HOME` overrides `~/.ora`. */
export function oraHome(): string {
  return process.env.ORA_HOME ?? join(homedir(), ".ora");
}

/** Create the home dir if missing, `0700` (private to the user). Idempotent. */
export function ensureHome(): string {
  const home = oraHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

/** Absolute path to the SQLite database file. */
export function dbPath(): string {
  return join(oraHome(), "ora.db");
}

/** Absolute path to the daemon connection file. */
export function daemonInfoPath(): string {
  return join(oraHome(), "daemon.json");
}

/**
 * Persist the daemon connection file atomically: write a sibling temp file (mode `0600`), then
 * `rename` it over the target — `rename` within a directory is atomic, so a concurrent reader sees
 * either the old file or the complete new one, never a torn write.
 */
export function writeDaemonInfo(info: DaemonInfo): void {
  ensureHome();
  const target = daemonInfoPath();
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  renameSync(tmp, target);
  // Belt-and-suspenders: ensure perms even if an existing target had looser ones pre-rename.
  chmodSync(target, 0o600);
}

/** Read the daemon connection file, or `null` if no daemon has published one (not running). */
export function readDaemonInfo(): DaemonInfo | null {
  try {
    return JSON.parse(readFileSync(daemonInfoPath(), "utf8")) as DaemonInfo;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/** Remove the daemon connection file on shutdown. Missing file is fine (already gone). */
export function removeDaemonInfo(): void {
  rmSync(daemonInfoPath(), { force: true });
}
