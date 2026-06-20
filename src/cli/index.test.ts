/**
 * CLI dispatch tests — `resolveInvocation` over raw argv, the pure decision behind `main()`. The behavior
 * that matters here is the new convention: **bare `ora` (no command) launches the UI**, while `--help`/`-h`
 * still ask for usage and every other token is a command with its args preserved. Keeping the decision pure
 * lets us assert it without spawning a daemon, opening a browser, or calling `process.exit`.
 */

import { describe, expect, it } from "vitest";

import { resolveInvocation } from "./index.js";

/** Build an argv the way Node hands it to us: [execPath, scriptPath, ...userArgs]. */
const argv = (...userArgs: string[]) => ["/usr/bin/node", "/path/to/cli/index.js", ...userArgs];

describe("resolveInvocation", () => {
  it("routes bare invocation (no command) to the ui command", () => {
    expect(resolveInvocation(argv())).toEqual({ kind: "command", cmd: "ui", rest: [] });
  });

  it("treats --help and -h as a help request (not a command)", () => {
    expect(resolveInvocation(argv("--help"))).toEqual({ kind: "help" });
    expect(resolveInvocation(argv("-h"))).toEqual({ kind: "help" });
  });

  it("passes a known command through with no extra args", () => {
    expect(resolveInvocation(argv("list"))).toEqual({ kind: "command", cmd: "list", rest: [] });
  });

  it("preserves the remaining args for a command that takes them", () => {
    expect(resolveInvocation(argv("add", "--engine", "claude", "--at", "+1m"))).toEqual({
      kind: "command",
      cmd: "add",
      rest: ["--engine", "claude", "--at", "+1m"],
    });
  });

  it("still classifies an unknown command as a command (main() prints the unknown-command error)", () => {
    expect(resolveInvocation(argv("bogus"))).toEqual({ kind: "command", cmd: "bogus", rest: [] });
  });
});
