/**
 * launchd keep-alive tests — `generatePlist` (pure) plus `installLaunchd`/`uninstallLaunchd` over
 * injected effects, so no real plist is written and no real `launchctl` runs. Covers the branches that
 * matter: plist correctness + XML escaping, the load-failure path (B1 — no silent success), the
 * failure-tolerant pre-unload, idempotent re-install, the absent-plist no-op, and the non-darwin gate.
 */

import { describe, expect, it } from "vitest";

import {
  generatePlist,
  installLaunchd,
  uninstallLaunchd,
  LABEL,
  type InstallDeps,
  type UninstallDeps,
  type LaunchctlResult,
} from "./launchd.js";

const PLIST = "/Users/x/Library/LaunchAgents/dev.gregorian.daemon.plist";
const AGENTS_DIR = "/Users/x/Library/LaunchAgents";

const ok = (): LaunchctlResult => ({ status: 0, stderr: "" });

interface InstallHarness {
  deps: InstallDeps;
  launchctl: string[][];
  writes: Array<[string, string]>;
  mkdirs: string[];
  logs: string[];
  errors: string[];
}

function makeInstallDeps(over: Partial<InstallDeps> = {}): InstallHarness {
  const launchctl: string[][] = [];
  const writes: Array<[string, string]> = [];
  const mkdirs: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const deps: InstallDeps = {
    platform: "darwin",
    plistFile: PLIST,
    plistBody: "<plist/>",
    launchAgentsDir: AGENTS_DIR,
    mkdirp: (dir) => void mkdirs.push(dir),
    writeFile: (path, body) => void writes.push([path, body]),
    runLaunchctl: (args) => {
      launchctl.push(args);
      return ok();
    },
    log: (msg) => void logs.push(msg),
    error: (msg) => void errors.push(msg),
    ...over,
  };
  return { deps, launchctl, writes, mkdirs, logs, errors };
}

describe("generatePlist", () => {
  const base = {
    label: LABEL,
    nodePath: "/usr/local/bin/node",
    cliEntry: "/opt/gregorian/dist/cli/index.js",
    logPath: "/Users/x/.gregorian/daemon.log",
    path: "/usr/local/bin:/usr/bin:/bin",
  };

  it("renders a well-formed LaunchAgent plist", () => {
    const xml = generatePlist(base);
    expect(xml).toContain("<!DOCTYPE plist");
    expect(xml).toContain("<key>Label</key>\n    <string>dev.gregorian.daemon</string>");
    expect(xml).toContain("<key>RunAtLoad</key>\n    <true/>");
    expect(xml).toContain("<key>KeepAlive</key>\n    <true/>");
    // ProgramArguments in order: node, cli entry, then the `daemon` subcommand.
    const args = [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    expect(args).toEqual(
      expect.arrayContaining([base.nodePath, base.cliEntry, "daemon"]),
    );
    expect(args.indexOf(base.nodePath)).toBeLessThan(args.indexOf(base.cliEntry));
    expect(args.indexOf(base.cliEntry)).toBeLessThan(args.indexOf("daemon"));
    // Log paths (both stdout + stderr) and the captured PATH are present.
    expect(xml).toContain("<key>StandardOutPath</key>\n    <string>/Users/x/.gregorian/daemon.log</string>");
    expect(xml).toContain("<key>StandardErrorPath</key>\n    <string>/Users/x/.gregorian/daemon.log</string>");
    expect(xml).toContain("<key>PATH</key>\n      <string>/usr/local/bin:/usr/bin:/bin</string>");
  });

  it("XML-escapes every special character in interpolated values", () => {
    const xml = generatePlist({ ...base, cliEntry: `/weird & path/<a>"b"'c'.js` });
    expect(xml).toContain("/weird &amp; path/&lt;a&gt;&quot;b&quot;&apos;c&apos;.js");
    // The raw, unescaped form must not appear (would make launchd silently reject the plist).
    expect(xml).not.toContain("/weird & path/<a>");
  });
});

describe("installLaunchd", () => {
  it("writes the plist, unloads any prior copy, then loads -w (success → exit 0)", () => {
    const h = makeInstallDeps();
    const code = installLaunchd(h.deps);
    expect(code).toBe(0);
    expect(h.mkdirs).toEqual([AGENTS_DIR]);
    expect(h.writes).toEqual([[PLIST, "<plist/>"]]);
    expect(h.launchctl).toEqual([
      ["unload", PLIST],
      ["load", "-w", PLIST],
    ]);
    expect(h.errors).toEqual([]);
    expect(h.logs.join(" ")).toMatch(/installed the launchd keep-alive/i);
  });

  it("surfaces a launchctl load failure (B1 — non-zero exit, stderr shown, no silent success)", () => {
    const h = makeInstallDeps({
      // unload succeeds (nothing loaded), load fails.
      runLaunchctl: (args) =>
        args[0] === "load" ? { status: 1, stderr: "Load failed: 5: Input/output error" } : ok(),
    });
    const code = installLaunchd(h.deps);
    expect(code).toBe(1);
    expect(h.errors.join("\n")).toMatch(/launchctl load failed \(exit 1\)/);
    expect(h.errors.join("\n")).toContain("Load failed: 5: Input/output error");
    // The plist is still written so the user can inspect/retry.
    expect(h.writes).toEqual([[PLIST, "<plist/>"]]);
  });

  it("tolerates a failing pre-unload (nothing loaded yet) and still succeeds", () => {
    const h = makeInstallDeps({
      runLaunchctl: (args) =>
        args[0] === "unload" ? { status: 1, stderr: "Could not find specified service" } : ok(),
    });
    expect(installLaunchd(h.deps)).toBe(0);
    expect(h.errors).toEqual([]);
  });

  it("is idempotent: a second install repeats unload→load without error", () => {
    const h = makeInstallDeps();
    expect(installLaunchd(h.deps)).toBe(0);
    expect(installLaunchd(h.deps)).toBe(0);
    expect(h.launchctl).toEqual([
      ["unload", PLIST],
      ["load", "-w", PLIST],
      ["unload", PLIST],
      ["load", "-w", PLIST],
    ]);
  });

  it("on non-darwin: prints the macOS-only message, touches nothing, exits 0", () => {
    const h = makeInstallDeps({ platform: "linux" });
    expect(installLaunchd(h.deps)).toBe(0);
    expect(h.writes).toEqual([]);
    expect(h.mkdirs).toEqual([]);
    expect(h.launchctl).toEqual([]);
    expect(h.logs.join(" ")).toMatch(/macOS-only/i);
  });
});

interface UninstallHarness {
  deps: UninstallDeps;
  launchctl: string[][];
  removed: string[];
  logs: string[];
}

function makeUninstallDeps(over: Partial<UninstallDeps> = {}): UninstallHarness {
  const launchctl: string[][] = [];
  const removed: string[] = [];
  const logs: string[] = [];
  const deps: UninstallDeps = {
    platform: "darwin",
    plistFile: PLIST,
    fileExists: () => true,
    removeFile: (path) => void removed.push(path),
    runLaunchctl: (args) => {
      launchctl.push(args);
      return ok();
    },
    log: (msg) => void logs.push(msg),
    ...over,
  };
  return { deps, launchctl, removed, logs };
}

describe("uninstallLaunchd", () => {
  it("unloads -w and removes the plist when present (exit 0)", () => {
    const h = makeUninstallDeps();
    expect(uninstallLaunchd(h.deps)).toBe(0);
    expect(h.launchctl).toEqual([["unload", "-w", PLIST]]);
    expect(h.removed).toEqual([PLIST]);
    expect(h.logs.join(" ")).toMatch(/removed the launchd keep-alive/i);
  });

  it("is a no-op (exit 0) when the plist is absent — nothing to unload or remove", () => {
    const h = makeUninstallDeps({ fileExists: () => false });
    expect(uninstallLaunchd(h.deps)).toBe(0);
    expect(h.launchctl).toEqual([]);
    expect(h.removed).toEqual([]);
    expect(h.logs.join(" ")).toMatch(/not installed/i);
  });

  it("on non-darwin: prints the macOS-only message and exits 0", () => {
    const h = makeUninstallDeps({ platform: "win32" });
    expect(uninstallLaunchd(h.deps)).toBe(0);
    expect(h.removed).toEqual([]);
    expect(h.launchctl).toEqual([]);
    expect(h.logs.join(" ")).toMatch(/macOS-only/i);
  });
});
