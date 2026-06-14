/**
 * The daemon's loopback HTTP API — the single surface both the CLI (now) and the m5 web UI (later)
 * use to talk to the single-writer daemon. Built on `node:http` (zero new dependency; a 4-route JSON
 * API needs no framework — m5 reuses this *surface*, free to pick a framework behind it).
 *
 * Routes (all JSON):
 *   GET  /health   → liveness, NO auth (so the CLI can distinguish "daemon down" from "bad token")
 *   POST /events   → create + arm an event            (auth)
 *   GET  /events   → list events                      (auth)
 *   GET  /runs     → list runs                         (auth)
 *
 * Security: bind `127.0.0.1` ONLY (the daemon's `listen` host, asserted in tests). Every route but
 * `/health` requires `Authorization: Bearer <token>`, compared in constant time. POST bodies are
 * capped (a runaway prompt can't exhaust daemon memory). No silent failures — every error path returns
 * a named JSON error with a non-2xx status.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";

import type { Store } from "../store/store.js";
import type { EngineKind } from "../types.js";
import { Scheduler, consoleLogger, type Logger } from "./scheduler.js";

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

/** Engine kinds the API will persist (launchability is enforced later by the scheduler). */
const VALID_ENGINES: readonly EngineKind[] = ["claude", "codex"];

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

  if (typeof b.engine !== "string" || !VALID_ENGINES.includes(b.engine as EngineKind)) {
    return { error: `engine must be one of: ${VALID_ENGINES.join(", ")}` };
  }
  if (typeof b.cwd !== "string" || b.cwd.length === 0) return { error: "cwd is required" };
  if (typeof b.scheduled_at !== "string" || Number.isNaN(new Date(b.scheduled_at).getTime())) {
    return { error: "scheduled_at must be a valid ISO 8601 time" };
  }
  if (b.mentions != null && !Array.isArray(b.mentions)) {
    return { error: "mentions must be an array of strings when present" };
  }

  return {
    engine: b.engine as EngineKind,
    cwd: b.cwd,
    scheduled_at: b.scheduled_at,
    title: typeof b.title === "string" ? b.title : undefined,
    model: typeof b.model === "string" ? b.model : null,
    prompt: typeof b.prompt === "string" ? b.prompt : null,
    mentions: Array.isArray(b.mentions) ? (b.mentions as string[]) : null,
  };
}

/** Derive a title from the prompt's first line, or a fallback. */
function titleFor(req: AddEventRequest): string {
  if (req.title && req.title.trim().length > 0) return req.title.trim();
  const firstLine = (req.prompt ?? "").split("\n")[0]?.trim() ?? "";
  if (firstLine.length > 0) return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
  return "untitled run";
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
): Server {
  return createHttpServer((req, res) => {
    void handle(req, res, store, scheduler, token).catch((err) => {
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
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const { pathname } = url;
  const method = req.method ?? "GET";

  // Liveness probe is unauthenticated by design.
  if (pathname === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  // Friendly, unauthenticated landing at the root so a browser sees the daemon is alive (rather than
  // a bare 401). It's a JSON API today; the web UI lands in m5. No secrets here — just orientation.
  if (pathname === "/" && method === "GET") {
    sendJson(res, 200, {
      name: "gregorian",
      status: "ok",
      message: "gregorian daemon is running. This is a JSON API; the web UI ships in a later milestone.",
      hint: "Use the CLI: `gregorian add …` and `gregorian list`. Authed routes need a bearer token.",
      routes: ["GET /health", "GET /events", "POST /events", "GET /runs"],
    });
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

  if (method === "GET" && pathname === "/runs") {
    sendJson(res, 200, { runs: store.listRuns() });
    return;
  }

  sendJson(res, 404, { error: "not_found", message: `no route for ${method} ${pathname}` });
}
