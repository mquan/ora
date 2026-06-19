/**
 * The Daemon — gregorian's long-running local process and single DB writer.
 *
 * `start()` opens the Store, builds the Scheduler, re-arms pending future events (croner is in-memory),
 * binds the loopback HTTP server, and publishes `~/.gregorian/daemon.json` so clients can connect.
 * `stop()` tears it all down in the safe order: stop the scheduler (so in-flight finalizers skip writes),
 * close the server, close the store, remove the connection file.
 *
 * The bottom of this file is the **client** side of the same contract — `loadDaemonInfo` / `daemonFetch`
 * / `daemonRequest` — used by the CLI commands. Server and client share one module so the connection
 * contract (port + token + loopback) has exactly one definition.
 */

import { randomBytes } from "node:crypto";
import type { Server } from "node:http";

import { Store } from "../store/store.js";
import {
  Scheduler,
  consoleLogger,
  defaultEngineResolver,
  type EngineResolver,
  type Logger,
} from "./scheduler.js";
import { createServer } from "./server.js";
import { Watcher } from "../watcher/watcher.js";
import { MinutesService } from "./minutes.js";
import { reconcile } from "./reconcile.js";
import { materializeRecurrences } from "./recurrence.js";
import { ClaudeEngine } from "../engines/claude.js";
import { CodexEngine } from "../engines/codex.js";
import type { AgentEngine } from "../engines/types.js";
import type { ClaudeRunner } from "../minutes/summarizer.js";
import type { Run } from "../types.js";
import {
  dbPath,
  ensureHome,
  readDaemonInfo,
  removeDaemonInfo,
  writeDaemonInfo,
  type DaemonInfo,
} from "./paths.js";

/** Default loopback port; override via `GREGORIAN_PORT` or {@link DaemonOptions.port}. */
export const DEFAULT_PORT = 4773;

/** Default period between recurrence re-materialization ticks (rolling-window refresh). */
export const DEFAULT_RECURRENCE_INTERVAL_MS = 60 * 60 * 1000;

/** Thrown when the configured port is already bound — likely another gregorian daemon. */
export class PortInUseError extends Error {
  constructor(port: number) {
    super(`port ${port} is already in use — a gregorian daemon may already be running`);
    this.name = "PortInUseError";
  }
}

/** Thrown by the client helpers when no daemon is reachable. */
export class DaemonNotRunningError extends Error {
  constructor() {
    super("gregorian daemon is not running — start it with `gregorian daemon`");
    this.name = "DaemonNotRunningError";
  }
}

export interface DaemonOptions {
  /** Port to bind. `0` picks an ephemeral port (used in tests). Defaults to env/`DEFAULT_PORT`. */
  port?: number;
  logger?: Logger;
  /** Override the engine resolver the scheduler launches with (tests inject a stub — no real `claude`). */
  engineResolver?: EngineResolver;
  /** Engines whose transcript roots the watcher subscribes to. Defaults to `[ClaudeEngine, CodexEngine]`. */
  engines?: AgentEngine[];
  /** Watcher idle window (ms). Defaults to the watcher's own default (60s). */
  idleMs?: number;
  /** Override the minutes summarizer's `claude -p` spawn (tests inject a deterministic stub). */
  summarizerRunner?: ClaudeRunner;
  /** Missed-fire grace window (ms). Defaults to reconcile's `DEFAULT_GRACE_MS` (1h). */
  graceMs?: number;
  /** Period between recurrence re-materialization ticks (ms). Defaults to {@link DEFAULT_RECURRENCE_INTERVAL_MS}. */
  recurrenceIntervalMs?: number;
}

export class Daemon {
  private store?: Store;
  private scheduler?: Scheduler;
  private watcher?: Watcher;
  private server?: Server;
  private recurrenceTick?: NodeJS.Timeout;
  private readonly port: number;
  private readonly logger: Logger;
  private readonly engineResolver: EngineResolver;
  private readonly engines: AgentEngine[];
  private readonly idleMs?: number;
  private readonly summarizerRunner?: ClaudeRunner;
  private readonly graceMs?: number;
  private readonly recurrenceIntervalMs: number;

  constructor(opts: DaemonOptions = {}) {
    this.port = opts.port ?? Number(process.env.GREGORIAN_PORT ?? DEFAULT_PORT);
    this.logger = opts.logger ?? consoleLogger;
    this.engineResolver = opts.engineResolver ?? defaultEngineResolver();
    this.engines = opts.engines ?? [new ClaudeEngine(), new CodexEngine()];
    this.idleMs = opts.idleMs;
    this.summarizerRunner = opts.summarizerRunner;
    this.graceMs = opts.graceMs;
    this.recurrenceIntervalMs = opts.recurrenceIntervalMs ?? DEFAULT_RECURRENCE_INTERVAL_MS;
  }

  /**
   * Boot the daemon and return the published connection info. Throws {@link PortInUseError} on a taken
   * port. The port is claimed FIRST (fail fast, before reconcile mutates the DB), then the design
   * lifecycle runs: reconcile → arm pending → start watcher. `daemon.json` is published LAST so a
   * client never connects to a half-booted daemon.
   */
  async start(): Promise<DaemonInfo> {
    ensureHome();
    const token = randomBytes(32).toString("hex");
    const store = new Store(dbPath());

    const minutes = new MinutesService({
      store,
      resolveEngine: this.engineResolver,
      runner: this.summarizerRunner,
      logger: this.logger,
    });
    const onFinalize = (run: Run): void => minutes.onRunFinalized(run);

    const scheduler = new Scheduler(store, this.engineResolver, this.logger, onFinalize);
    const watcher = new Watcher({
      store,
      engines: this.engines,
      logger: this.logger,
      idleMs: this.idleMs,
      onFinalize,
    });
    const server = createServer(store, scheduler, token, this.logger, {
      resolveEngine: this.engineResolver,
    });

    // Claim the port first — fail fast before reconcile causes any DB side effects.
    await this.listen(server, this.port);

    // Design lifecycle: reconcile (re-attach in-flight, missed-fire, re-materialize) → arm → watch.
    reconcile({
      store,
      resolveEngine: this.engineResolver,
      scheduler,
      watcher,
      graceMs: this.graceMs,
      logger: this.logger,
    });
    scheduler.armPending();
    await watcher.start();

    // Rolling-window recurrence refresh. `unref()` so the tick alone never keeps the process alive; the
    // body is guarded so a throw can never become an unhandled exception (F1).
    const tick = setInterval(() => {
      try {
        materializeRecurrences({ store, scheduler, now: new Date(), logger: this.logger });
      } catch (err) {
        this.logger.error(`recurrence tick failed: ${(err as Error).message}`);
      }
    }, this.recurrenceIntervalMs);
    tick.unref();

    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : this.port;
    const info: DaemonInfo = {
      port: boundPort,
      token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };

    this.store = store;
    this.scheduler = scheduler;
    this.watcher = watcher;
    this.server = server;
    this.recurrenceTick = tick;

    // Publish LAST — the daemon is fully booted and ready to serve.
    writeDaemonInfo(info);
    this.logger.log(`daemon listening on http://127.0.0.1:${boundPort} (db ${dbPath()})`);
    return info;
  }

  /** Bind the server to loopback, translating `EADDRINUSE` into a named error. */
  private listen(server: Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        reject(err.code === "EADDRINUSE" ? new PortInUseError(port) : err);
      };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  }

  /** Graceful shutdown: scheduler first (blocks late finalize writes), then server, then store. */
  stop(): Promise<void> {
    this.scheduler?.stop();
    removeDaemonInfo();
    const { server, store } = this;
    return new Promise((resolve) => {
      if (!server) {
        store?.close();
        resolve();
        return;
      }
      server.close(() => {
        store?.close();
        resolve();
      });
    });
  }
}

// --- client helpers (used by the CLI; share the same connection contract) ---

/** Load the daemon connection info, or throw {@link DaemonNotRunningError} if none is published. */
export function loadDaemonInfo(): DaemonInfo {
  const info = readDaemonInfo();
  if (!info) throw new DaemonNotRunningError();
  return info;
}

/** Low-level authed fetch against the running daemon. Returns the raw `Response`. */
export function daemonFetch(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const info = loadDaemonInfo();
  const hasBody = init.body !== undefined;
  return fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${info.token}`,
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    body: hasBody ? JSON.stringify(init.body) : undefined,
  });
}

/**
 * Authed request returning parsed JSON. A connection refusal (stale/absent daemon) becomes a
 * {@link DaemonNotRunningError}; a non-2xx becomes an `Error` carrying the server's `message`.
 */
export async function daemonRequest<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await daemonFetch(path, init);
  } catch (err) {
    if (err instanceof DaemonNotRunningError) throw err;
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "ECONNREFUSED") throw new DaemonNotRunningError();
    throw err;
  }
  const text = await res.text();
  const data = (text ? JSON.parse(text) : {}) as T & { error?: string; message?: string };
  if (!res.ok) {
    throw new Error(data.message ?? data.error ?? `request failed (${res.status})`);
  }
  return data;
}
