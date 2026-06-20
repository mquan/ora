#!/usr/bin/env node
/**
 * ora CLI entry point.
 *
 * Dispatches to the commands — `add`, `list`, `show`, `daemon`, `ui`, `install`, `uninstall`.
 * `add`/`list`/`show` are HTTP clients of the running daemon (127.0.0.1 + token); `daemon` is the
 * long-lived server itself; `ui` ensures the daemon is up and opens the browser; `install`/`uninstall`
 * manage the macOS launchd keep-alive. Unknown input exits non-zero so failures are never silent.
 *
 * Command modules are imported LAZILY (dynamic `import()` per case) for one load-bearing reason: the
 * better-sqlite3 native module is a static top-level import in the store, so a failed native build would
 * otherwise crash the entry at module-evaluation time with a raw stack trace — before any of our code
 * runs. By not statically importing the store-touching commands, the entry loads cleanly and the
 * native-module preflight below turns that failure into a friendly message instead.
 */

import { checkNativeModules } from "../install/native-check.js";

const USAGE = `ora — a calendar your agents read AND write

Usage:
  ora <command> [options]

Commands:
  daemon [--port <n>]            Run the scheduler/recorder daemon (foreground)
  add    --engine <claude|codex> --at <when> [options]
                                 Schedule a one-off run
  list                           Show scheduled + recorded events
  show   <id>                    Show one event in detail (minutes, error, transcript)
  ui                             Ensure the daemon is up and open the timeline in a browser
  install                        Install the macOS launchd keep-alive (daemon survives logout/login)
  uninstall                      Remove the macOS launchd keep-alive

'add' options:
  --engine <claude|codex>   Which agent to launch (required)
  --at <when>               When to fire: '+1m' / '+30s' / '+2h' / '+1d' or an ISO time (required)
  --cwd <path>              Working directory for the run (default: current directory)
  --prompt <text>           The prompt to run (required unless --mention given)
  --model <id>              Engine-scoped model id (optional)
  --title <text>            Human label (default: derived from the prompt)
  --mention <ref>           Skill (/foo) or doc path to attach; repeatable

Options:
  -h, --help                Show this help and exit

Schedule and record local AI agent runs (Claude Code, Codex) on one timeline.`;

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const [cmd, ...rest] = args;

  if (!cmd || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  // First-run native-module preflight: if better-sqlite3 didn't load, print a friendly message and
  // exit rather than crashing inside a command with a raw ERR_DLOPEN_FAILED stack. Runs before any
  // command module (which may statically import the store) is loaded below.
  const native = checkNativeModules();
  if (!native.ok) {
    process.stderr.write(native.message + "\n");
    return 1;
  }

  switch (cmd) {
    case "add":
      return (await import("./commands/add.js")).addCommand(rest);
    case "list":
      return (await import("./commands/list.js")).listCommand();
    case "show":
      return (await import("./commands/show.js")).showCommand(rest);
    case "daemon":
      return (await import("./commands/daemon.js")).daemonCommand(rest);
    case "ui":
      return (await import("./commands/ui.js")).uiCommand();
    case "install":
      return (await import("./commands/install.js")).installCommand(rest);
    case "uninstall":
      return (await import("./commands/install.js")).uninstallCommand(rest);
    default:
      process.stderr.write(`ora: unknown command '${cmd}'\nRun 'ora --help' for usage.\n`);
      return 1;
  }
}

main(process.argv).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`ora: ${(err as Error)?.message ?? String(err)}\n`);
    process.exit(1);
  },
);
