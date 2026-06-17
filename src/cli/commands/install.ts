/**
 * `gregorian install` / `gregorian uninstall` — macOS launchd keep-alive (m4).
 *
 * Thin real-effects adapters over the pure cores in `install/launchd.ts`: they assemble the plist
 * (Node binary + this CLI's entry + the captured `$PATH`) and inject `node:fs` + `spawnSync("launchctl")`.
 * All branching/decisions live in the cores so this file stays trivially correct.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  generatePlist,
  plistPath,
  cliEntryPath,
  LABEL,
  installLaunchd,
  uninstallLaunchd,
  type LaunchctlResult,
} from "../../install/launchd.js";
import { gregorianHome } from "../../daemon/paths.js";

/** Run `launchctl` and normalize the result for the install/uninstall cores. */
function runLaunchctl(args: string[]): LaunchctlResult {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  const stderr = result.stderr ?? (result.error ? result.error.message : "");
  return { status: result.status, stderr };
}

const log = (msg: string): void => void process.stdout.write(msg + "\n");
const error = (msg: string): void => void process.stderr.write(msg + "\n");

export function installCommand(args: string[]): number {
  if (args.length > 0) {
    error(`gregorian install: unexpected argument '${args[0]}' (install takes no options)`);
    return 1;
  }

  const plistFile = plistPath();
  const plistBody = generatePlist({
    label: LABEL,
    nodePath: process.execPath,
    cliEntry: cliEntryPath(),
    logPath: join(gregorianHome(), "daemon.log"),
    path: process.env.PATH ?? "",
  });

  return installLaunchd({
    platform: process.platform,
    plistFile,
    plistBody,
    launchAgentsDir: dirname(plistFile),
    mkdirp: (dir) => mkdirSync(dir, { recursive: true }),
    writeFile: (path, body) => writeFileSync(path, body),
    runLaunchctl,
    log,
    error,
  });
}

export function uninstallCommand(args: string[]): number {
  if (args.length > 0) {
    error(`gregorian uninstall: unexpected argument '${args[0]}' (uninstall takes no options)`);
    return 1;
  }

  return uninstallLaunchd({
    platform: process.platform,
    plistFile: plistPath(),
    fileExists: (path) => existsSync(path),
    removeFile: (path) => rmSync(path, { force: true }),
    runLaunchctl,
    log,
  });
}
