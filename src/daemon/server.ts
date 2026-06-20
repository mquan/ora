/**
 * The daemon's loopback HTTP API — the single surface both the CLI (now) and the m5 web UI (later)
 * use to talk to the single-writer daemon. Built on `node:http` (zero new dependency; a 4-route JSON
 * API needs no framework — m5 reuses this *surface*, free to pick a framework behind it).
 *
 * Routes:
 *   GET  /health                 → liveness, NO auth (CLI distinguishes "down" from "bad token")
 *   POST /events                 → create + arm an event                            (auth, JSON)
 *   GET  /events                 → list events                                      (auth, JSON)
 *   GET  /events/:id             → one event + its runs                             (auth, JSON)
 *   GET  /runs                   → list runs                                        (auth, JSON)
 *   GET  /runs/:id/transcript    → one run's normalized transcript                  (auth, JSON)
 *   GET  *  (anything else)      → the web SPA + its assets                       (NO auth, static)
 *
 * Security: bind `127.0.0.1` ONLY (the daemon's `listen` host, asserted in tests). Every JSON API route
 * but `/health` requires `Authorization: Bearer <token>`, compared in constant time. The static app code
 * carries NO secret — the browser receives the token via the URL `ora ui` opens, not via this HTML
 * — so serving it unauthenticated is safe. POST bodies are capped (a runaway prompt can't exhaust daemon
 * memory). No silent failures — every error path returns a named error with a non-2xx status.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";

import type { Store } from "../store/store.js";
import type { EngineKind } from "../types.js";
import {
  Scheduler,
  consoleLogger,
  defaultEngineResolver,
  type EngineResolver,
  type Logger,
} from "./scheduler.js";
import { serveStatic, webRoot } from "../web/static.js";
import { readRunTranscript } from "../web/transcript.js";
import {
  ENGINE_IDS,
  ENGINE_REGISTRY,
  isValidEngine,
  validateModelForEngine,
} from "../engines/registry.js";

/** The POST /events request body — the add contract shared with the CLI `add` command. */
export interface AddEventRequest {
  engine: EngineKind;
  cwd: string;
  /** ISO 8601 fire time (the CLI resolves `--at` before sending). */
  scheduled_at: string;
  title?: string;
  model?: string | null;
  prompt?: string | null;
  mentions?: string[] | null;
}

/** Cap on POST body size — bounds the only unbounded input. */
const MAX_BODY_BYTES = 1_000_000;

/** Write a JSON response with an explicit status. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/** Constant-time token comparison; unequal lengths short-circuit to false (length isn't secret). */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract a bearer token from the Authorization header, or `null` if absent/malformed. */
function bearer(req: IncomingMessage): string | null {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  return m?.[1] ?? null;
}

/**
 * Read the full request body as a string, enforcing {@link MAX_BODY_BYTES}. On overflow it sends a 413
 * itself and resolves `null` (the caller stops). Network errors also resolve `null`.
 */
function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    // Fast path: a declared Content-Length over the cap is rejected before reading a byte. Drain the
    // socket (`resume`) so the connection closes cleanly and the 413 reaches the client.
    const declared = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      sendJson(res, 413, {
        error: "payload_too_large",
        message: `request body exceeds ${MAX_BODY_BYTES} bytes`,
      });
      req.resume();
      resolve(null);
      return;
    }

    let size = 0;
    const chunks: Buffer[] = [];
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        sendJson(res, 413, {
          error: "payload_too_large",
          message: `request body exceeds ${MAX_BODY_BYTES} bytes`,
        });
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", () => {
      if (!done) resolve(null);
    });
  });
}

/** Validate + normalize a POST /events body. Returns the request or a `{ message }` rejection. */
function parseAddRequest(raw: string): AddEventRequest | { error: string } {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { error: "request body is not valid JSON" };
  }
  if (!body || typeof body !== "object") return { error: "request body must be a JSON object" };
  const b = body as Record<string, unknown>;

  if (!isValidEngine(b.engine)) {
    return { error: `engine must be one of: ${ENGINE_IDS.join(", ")}` };
  }
  const engine = b.engine;
  if (typeof b.cwd !== "string" || b.cwd.length === 0) return { error: "cwd is required" };
  if (typeof b.scheduled_at !== "string" || Number.isNaN(new Date(b.scheduled_at).getTime())) {
    return { error: "scheduled_at must be a valid ISO 8601 time" };
  }
  if (b.mentions != null && !Array.isArray(b.mentions)) {
    return { error: "mentions must be an array of strings when present" };
  }
  // Engine-scoped model check: reject a model that belongs to a DIFFERENT engine (e.g. `opus` under
  // codex). Unknown/custom strings pass through — there is no model API to allowlist against.
  const model = typeof b.model === "string" ? b.model : null;
  const modelCheck = validateModelForEngine(engine, model);
  if (!modelCheck.ok) return { error: modelCheck.reason };

  return {
    engine,
    cwd: b.cwd,
    scheduled_at: b.scheduled_at,
    title: typeof b.title === "string" ? b.title : undefined,
    model,
    prompt: typeof b.prompt === "string" ? b.prompt : null,
    mentions: Array.isArray(b.mentions) ? (b.mentions as string[]) : null,
  };
}

/**
 * R6: validate the run's `cwd` at the authoritative trust boundary. Reject a schedule that is
 * guaranteed to fail at fire time (the engine spawn would ENOENT). Best-effort `stat` — a missing
 * path or non-directory is rejected; a transient stat error is treated as "not a directory".
 */
function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Derive a title from the prompt's first line, or a fallback. */
function titleFor(req: AddEventRequest): string {
  if (req.title && req.title.trim().length > 0) return req.title.trim();
  const firstLine = (req.prompt ?? "").split("\n")[0]?.trim() ?? "";
  if (firstLine.length > 0) return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
  return "untitled run";
}

/** Options for the browser-facing layer; both have safe production defaults. */
export interface ServerOptions {
  /** Resolves a run's engine for the transcript route. Defaults to the standard resolver. */
  resolveEngine?: EngineResolver;
  /** Directory holding the built web SPA assets. Defaults to {@link webRoot}. */
  webRoot?: string;
}

/** Is this GET an authed JSON API route (vs. a static/SPA path served unauthenticated)? */
function isApiGet(pathname: string): boolean {
  if (pathname === "/events" || pathname.startsWith("/events/")) return true;
  if (pathname === "/runs") return true;
  if (pathname.startsWith("/runs/") && pathname.endsWith("/transcript")) return true;
  return false;
}

/**
 * Build the daemon's HTTP server. Construction is pure (no `listen`) so tests can drive it on an
 * ephemeral port and the daemon controls binding/teardown.
 */
export function createServer(
  store: Store,
  scheduler: Scheduler,
  token: string,
  logger: Logger = consoleLogger,
  opts: ServerOptions = {},
): Server {
  const resolveEngine = opts.resolveEngine ?? defaultEngineResolver();
  const assetsRoot = opts.webRoot ?? webRoot();
  return createHttpServer((req, res) => {
    void handle(req, res, store, scheduler, token, resolveEngine, assetsRoot).catch((err) => {
      logger.error(`unhandled request error: ${(err as Error).message}`);
      sendJson(res, 500, { error: "internal", message: (err as Error).message });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  scheduler: Scheduler,
  token: string,
  resolveEngine: EngineResolver,
  assetsRoot: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const { pathname } = url;
  const method = req.method ?? "GET";

  // Liveness probe is unauthenticated by design.
  if (pathname === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  // Engine registry — the single source the web form reads to build its engine-scoped model pickers.
  // Carries only static, curated data (no secret), so it is unauthenticated like /health and resolved
  // before the static fallback would treat it as a missing asset.
  if (method === "GET" && pathname === "/engines") {
    sendJson(res, 200, { engines: ENGINE_REGISTRY });
    return;
  }

  // The web SPA + its assets are served unauthenticated for any GET that isn't a JSON API route — app
  // code holds no secret. The browser gets the bearer token from the URL `ora ui` opens, not here.
  if (method === "GET" && !isApiGet(pathname)) {
    serveStatic(req, res, assetsRoot, pathname);
    return;
  }

  const provided = bearer(req);
  if (provided === null || !tokensMatch(provided, token)) {
    sendJson(res, 401, { error: "unauthorized", message: "missing or invalid bearer token" });
    return;
  }

  if (method === "POST" && pathname === "/events") {
    const raw = await readBody(req, res);
    if (raw === null) return; // 413 / network error already handled
    const parsed = parseAddRequest(raw);
    if ("error" in parsed) {
      sendJson(res, 400, { error: "bad_request", message: parsed.error });
      return;
    }
    if (!isExistingDirectory(parsed.cwd)) {
      sendJson(res, 400, {
        error: "bad_request",
        message: `cwd does not exist or is not a directory: ${parsed.cwd}`,
      });
      return;
    }
    const event = store.createEvent({
      title: titleFor(parsed),
      engine: parsed.engine,
      model: parsed.model ?? null,
      cwd: parsed.cwd,
      prompt: parsed.prompt ?? null,
      mentions: parsed.mentions ?? null,
      schedule_kind: "once",
      scheduled_at: parsed.scheduled_at,
      status: "scheduled",
    });
    scheduler.arm(event);
    sendJson(res, 201, { event });
    return;
  }

  if (method === "GET" && pathname === "/events") {
    sendJson(res, 200, { events: store.listEvents() });
    return;
  }

  // Detail view for one event + its runs — powers `ora show` and the m5 web UI (same shape).
  if (method === "GET" && pathname.startsWith("/events/")) {
    const id = decodeURIComponent(pathname.slice("/events/".length));
    const event = store.getEvent(id);
    if (!event) {
      sendJson(res, 404, { error: "not_found", message: `no event ${id}` });
      return;
    }
    sendJson(res, 200, { event, runs: store.listRunsByEvent(id) });
    return;
  }

  if (method === "GET" && pathname === "/runs") {
    sendJson(res, 200, { runs: store.listRuns() });
    return;
  }

  // One run's normalized transcript — the data source for the web transcript viewer. 404 only when the
  // run id is unknown; a run that exists but has a null/missing/unreadable transcript returns 200 with a
  // named `reason` (no silent failures, no fabricated content).
  if (method === "GET" && pathname.startsWith("/runs/") && pathname.endsWith("/transcript")) {
    const id = decodeURIComponent(pathname.slice("/runs/".length, -"/transcript".length));
    const run = store.getRun(id);
    if (!run) {
      sendJson(res, 404, { error: "not_found", message: `no run ${id}` });
      return;
    }
    const transcript = await readRunTranscript(run, resolveEngine);
    sendJson(res, 200, { transcript });
    return;
  }

  sendJson(res, 404, { error: "not_found", message: `no route for ${method} ${pathname}` });
}
