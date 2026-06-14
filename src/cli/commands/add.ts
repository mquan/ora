/**
 * `gregorian add` — schedule a one-off run.
 *
 *   gregorian add --engine claude --cwd /path --at +1m --prompt 'list files' [--model …] [--title …] [--mention …]*
 *
 * Resolves `--at` to an absolute time, validates that the run will actually do something (prompt
 * and/or a mention), then POSTs to the daemon, which writes the event and arms croner immediately —
 * no daemon restart needed. Every rejection is a one-line `gregorian add: <reason>` on stderr + exit 1.
 */

import { resolve } from "node:path";

import { parseAt } from "../../daemon/at.js";
import { daemonRequest, DaemonNotRunningError } from "../../daemon/daemon.js";
import type { AddEventRequest } from "../../daemon/server.js";
import type { Event } from "../../types.js";

interface AddFlags {
  engine?: string;
  model?: string;
  cwd?: string;
  prompt?: string;
  at?: string;
  title?: string;
  mentions: string[];
}

function parseAddArgs(args: string[]): AddFlags {
  const flags: AddFlags = { mentions: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = (): string => {
      const v = args[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--engine": flags.engine = value(); break;
      case "--model": flags.model = value(); break;
      case "--cwd": flags.cwd = value(); break;
      case "--prompt": flags.prompt = value(); break;
      case "--at": flags.at = value(); break;
      case "--title": flags.title = value(); break;
      case "--mention": flags.mentions.push(value()); break;
      default: throw new Error(`unknown option '${arg}'`);
    }
  }
  return flags;
}

function fail(message: string): number {
  process.stderr.write(`gregorian add: ${message}\n`);
  return 1;
}

export async function addCommand(args: string[]): Promise<number> {
  let flags: AddFlags;
  try {
    flags = parseAddArgs(args);
  } catch (err) {
    return fail((err as Error).message);
  }

  const engine = flags.engine;
  if (engine !== "claude" && engine !== "codex") {
    return fail("--engine is required and must be 'claude' or 'codex'");
  }
  if (!flags.at) return fail("--at is required (e.g. '+1m' or an ISO time like 2026-06-14T12:00:00Z)");
  const hasPrompt = flags.prompt !== undefined && flags.prompt.trim().length > 0;
  if (!hasPrompt && flags.mentions.length === 0) {
    return fail("provide --prompt and/or at least one --mention (an empty run does nothing)");
  }

  let scheduledAt: string;
  try {
    scheduledAt = parseAt(flags.at).toISOString();
  } catch (err) {
    return fail((err as Error).message);
  }

  const body: AddEventRequest = {
    engine,
    cwd: resolve(flags.cwd ?? process.cwd()),
    scheduled_at: scheduledAt,
    title: flags.title,
    model: flags.model ?? null,
    prompt: flags.prompt ?? null,
    mentions: flags.mentions.length > 0 ? flags.mentions : null,
  };

  try {
    const { event } = await daemonRequest<{ event: Event }>("/events", { method: "POST", body });
    process.stdout.write(
      `Scheduled ${event.engine} run ${event.id}\n` +
        `  at  ${event.scheduled_at}\n` +
        `  cwd ${event.cwd}\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof DaemonNotRunningError) return fail(err.message);
    return fail((err as Error).message);
  }
}
