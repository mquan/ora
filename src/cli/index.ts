#!/usr/bin/env node
/**
 * gregorian CLI entry point.
 *
 * Scaffold stage: only `--help`/`-h` is wired. Commands (add, list, daemon, show,
 * ui, install) are added by later milestone-1+ tasks. Unknown input exits non-zero
 * with a message so failures are never silent.
 */

const USAGE = `gregorian — a calendar your agents read AND write

Usage:
  gregorian <command> [options]

Commands:
  (none yet — scaffold stage)

Options:
  -h, --help     Show this help and exit

Schedule and record local AI agent runs (Claude Code, Codex) on one timeline.`;

function main(argv: string[]): number {
  const args = argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  process.stderr.write(`gregorian: unknown command '${args[0]}'\nRun 'gregorian --help' for usage.\n`);
  return 1;
}

process.exit(main(process.argv));
