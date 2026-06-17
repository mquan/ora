/**
 * macOS launchd keep-alive for the gregorian daemon.
 *
 * The daemon is a long-lived foreground process; on macOS we keep it alive across logout/login by
 * installing a per-user LaunchAgent at `~/Library/LaunchAgents/dev.gregorian.daemon.plist`. launchd
 * auto-loads any plist living there at every login, and `KeepAlive` restarts the daemon if it exits —
 * so the OS, not gregorian, owns liveness (the locked design).
 *
 * Everything here is a PURE CORE over injected effects (mirroring `cli/commands/ui.ts`): `generatePlist`
 * is a pure string function, and `installLaunchd`/`uninstallLaunchd` take their filesystem + `launchctl`
 * effects as deps. So the whole flow — plist correctness/escaping, the load-failure path, idempotency,
 * the absent-plist no-op, and the non-darwin gate — is unit-tested without writing real files or shelling
 * out. The thin real-effects wiring lives in `cli/commands/install.ts`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** launchd Label and the plist filename stem. */
export const LABEL = "dev.gregorian.daemon";

/** Outcome of a `launchctl` invocation, as the install/uninstall cores observe it. */
export interface LaunchctlResult {
  /** Process exit status; `null` if the process was killed by a signal or never spawned. */
  status: number | null;
  /** Captured stderr (for surfacing a load failure to the user). */
  stderr: string;
}

/** Inputs for plist generation. All paths absolute; `path` is the installing shell's `$PATH`. */
export interface PlistOptions {
  label: string;
  /** Absolute path to the Node binary (`process.execPath`). */
  nodePath: string;
  /** Absolute path to the gregorian CLI entry (`dist/cli/index.js`). */
  cliEntry: string;
  /** Absolute path for the daemon's stdout+stderr log. */
  logPath: string;
  /** `$PATH` captured at install time — launchd's default PATH is minimal and the daemon must still
   *  find the `claude`/`codex` binaries it spawns. */
  path: string;
}

const XML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Escape the five XML special characters — a home/cwd path containing `&` or `<` would otherwise
 *  produce a plist launchd silently refuses to parse, and the daemon would never start. */
function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] ?? ch);
}

/** Render the LaunchAgent plist. Pure — the same inputs always yield the same XML. */
export function generatePlist(opts: PlistOptions): string {
  const args = [opts.nodePath, opts.cliEntry, "daemon"];
  const argXml = args.map((a) => `      <string>${xmlEscape(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(opts.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(opts.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(opts.logPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${xmlEscape(opts.path)}</string>
    </dict>
  </dict>
</plist>
`;
}

/** Absolute path to the LaunchAgent plist. `home` is injectable for tests. */
export function plistPath(home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

/** Absolute path to the running CLI entry (`dist/cli/index.js`). `src/install/` → `src/cli/index.js`;
 *  the compiled `dist/` mirrors this layout, so the plist points at whatever install this was invoked
 *  from (correct for both a global install and a local clone). */
export function cliEntryPath(): string {
  return fileURLToPath(new URL("../cli/index.js", import.meta.url));
}

/** The macOS-only message for an unsupported platform — `action` is `install` or `uninstall`. */
function nonDarwinMessage(action: "install" | "uninstall"): string {
  return (
    `gregorian ${action}: automated keep-alive is macOS-only for v1.\n` +
    `  Linux:   run \`gregorian daemon\` from a systemd user service (see README).\n` +
    `  Windows: run \`gregorian daemon\` at login via Task Scheduler / the Startup folder (see README).`
  );
}

/** Injected effects for {@link installLaunchd}. */
export interface InstallDeps {
  /** `process.platform`. */
  platform: string;
  /** Absolute plist path to write. */
  plistFile: string;
  /** Pre-rendered plist XML (from {@link generatePlist}). */
  plistBody: string;
  /** Directory to ensure before writing the plist (`~/Library/LaunchAgents`). */
  launchAgentsDir: string;
  mkdirp: (dir: string) => void;
  writeFile: (path: string, body: string) => void;
  runLaunchctl: (args: string[]) => LaunchctlResult;
  log: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * Install + load the LaunchAgent. Idempotent: writes the plist, then `unload`s any prior copy
 * (failure-tolerant — legitimately fails when nothing is loaded) before `load -w`. The `load -w`
 * result IS checked: a non-zero status surfaces launchctl's stderr and returns non-zero, so a failed
 * load never masquerades as success. Returns a process exit code.
 */
export function installLaunchd(deps: InstallDeps): number {
  if (deps.platform !== "darwin") {
    deps.log(nonDarwinMessage("install"));
    return 0;
  }

  deps.mkdirp(deps.launchAgentsDir);
  deps.writeFile(deps.plistFile, deps.plistBody);

  // Unload any already-loaded copy so `load` doesn't error on a duplicate label. This may legitimately
  // fail (nothing loaded yet) — that's expected, so its result is ignored.
  deps.runLaunchctl(["unload", deps.plistFile]);

  const loaded = deps.runLaunchctl(["load", "-w", deps.plistFile]);
  if (loaded.status !== 0) {
    const stderr = loaded.stderr.trim();
    deps.error(
      `gregorian install: launchctl load failed (exit ${loaded.status ?? "null"}).\n` +
        (stderr ? `  ${stderr}\n` : "") +
        `  The plist was written to ${deps.plistFile} — fix the error above and re-run \`gregorian install\`.`,
    );
    return 1;
  }

  deps.log(
    `gregorian: installed the launchd keep-alive agent.\n` +
      `  plist: ${deps.plistFile}\n` +
      `  The daemon is running now and will restart automatically at login.`,
  );
  return 0;
}

/** Injected effects for {@link uninstallLaunchd}. */
export interface UninstallDeps {
  platform: string;
  plistFile: string;
  fileExists: (path: string) => boolean;
  removeFile: (path: string) => void;
  runLaunchctl: (args: string[]) => LaunchctlResult;
  log: (msg: string) => void;
}

/**
 * Unload + remove the LaunchAgent. Tolerant of a not-installed state: a missing plist is success
 * (nothing to do), not an error. The `unload -w` result is ignored (the agent may already be stopped).
 * Returns a process exit code.
 */
export function uninstallLaunchd(deps: UninstallDeps): number {
  if (deps.platform !== "darwin") {
    deps.log(nonDarwinMessage("uninstall"));
    return 0;
  }

  if (!deps.fileExists(deps.plistFile)) {
    deps.log(`gregorian: not installed (no launchd agent at ${deps.plistFile}). Nothing to do.`);
    return 0;
  }

  deps.runLaunchctl(["unload", "-w", deps.plistFile]);
  deps.removeFile(deps.plistFile);
  deps.log(
    `gregorian: removed the launchd keep-alive agent.\n` +
      `  ${deps.plistFile}\n` +
      `  The daemon will no longer restart at login.`,
  );
  return 0;
}
