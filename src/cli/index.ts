#!/usr/bin/env node
/**
 * gregorian CLI entry point.
 *
 * Dispatches to the m1 commands — `add`, `list`, `daemon`. `add`/`list` are HTTP clients of the running
 * daemon (127.0.0.1 + token); `daemon` is the long-lived server itself. Unknown input exits non-zero so
 * failures are never silent. Later milestones add `show`, `tail`, `ui`, `install`.
 */

import { addCommand } from "./commands/add.js";
import { listCommand } from "./commands/list.js";
import { daemonCommand } from "./commands/daemon.js";

const USAGE = `gregorian — a calendar your agents read AND write

Usage:
  gregorian <command> [options]

Commands:
  daemon [--port <n>]            Run the scheduler/recorder daemon (foreground)
  add    --engine <claude|codex> --at <when> [options]
                                 Schedule a one-off run
  list                           Show scheduled + recorded events

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

  switch (cmd) {
    case "add":
      return addCommand(rest);
    case "list":
      return listCommand();
    case "daemon":
      return daemonCommand(rest);
    default:
      process.stderr.write(`gregorian: unknown command '${cmd}'\nRun 'gregorian --help' for usage.\n`);
      return 1;
  }
}

main(process.argv).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`gregorian: ${(err as Error)?.message ?? String(err)}\n`);
    process.exit(1);
  },
);
