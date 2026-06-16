/**
 * Static asset serving for the web SPA (design A4 — the daemon is the single local server, so it also
 * serves the browser app off the same loopback port). Pure node:http; no framework (the API stayed
 * zero-dep, the static layer matches).
 *
 * Security: the ONLY untrusted input is the request path, so the one hard rule is **no path traversal** —
 * a resolved file must stay inside the web root or it's a 403, never a read. Responses also carry
 * `X-Content-Type-Options: nosniff` so a mistyped asset can't be MIME-sniffed into script.
 *
 * SPA fallback: an unknown path with no file extension (a client-side route like `/event/123`) serves
 * `index.html` so the browser app can route it. Unknown paths that *look* like a missing asset (have an
 * extension) get an honest 404. When no build exists yet (the React SPA lands in a later task), a tiny
 * placeholder page is served so the daemon is still browseable.
 */

import { createReadStream, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse, IncomingMessage } from "node:http";

/** Extension → content-type. Kept small and explicit (no `mime` dependency). */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * Resolve the directory that holds the built web assets. Walk up from this module to the nearest
 * `package.json` and join `web` — correct under both vitest (runs from `src/`) and the published
 * package (`web/` ships beside `dist/`, see package.json `files`). A later task repoints THIS helper
 * to its Vite output; everything else takes `webRoot` as a parameter.
 */
export function webRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Bounded walk — stop at the filesystem root rather than loop forever.
  for (let i = 0; i < 10; i++) {
    try {
      if (readdirSync(dir).includes("package.json")) return join(dir, "web");
    } catch {
      // Unreadable dir — give up the walk; the caller's missing-root path handles it.
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume a conventional layout relative to this module.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
}

/** The content-type for a path's extension, defaulting to a safe binary type. */
function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolve a request pathname to an absolute file inside `root`, or `null` if it escapes the root (path
 * traversal). We let `resolve` apply any `..` segments and then require the result to be contained by
 * `root` — that containment check is the real, sole guard (no fragile pre-stripping of `..`).
 */
function safeResolve(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname; // malformed %-escape → treat literally; the containment check still applies
  }
  // Prefix with "." so a leading "/" is treated as relative to `root` (not the filesystem root), while
  // any "../" segments still take effect — then the containment check below rejects an escape.
  const candidate = "." + (decoded.startsWith("/") ? decoded : "/" + decoded);
  const abs = resolve(root, candidate);
  const rootResolved = resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) return null;
  return abs;
}

/** A minimal placeholder page when no build exists yet, so the daemon is still browseable. */
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>gregorian</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}</style>
</head><body>
<h1>gregorian</h1>
<p>The daemon is running and serving this page, but the web UI hasn't been built yet.</p>
<p>Use the CLI for now: <code>gregorian add …</code> and <code>gregorian list</code>.</p>
</body></html>
`;

/** Send a small in-memory body with explicit headers and the nosniff guard. */
function sendBody(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

/**
 * Serve a GET request for a static asset out of `root`. Returns `true` if it handled the response (a
 * file, the SPA fallback, the placeholder, a 403, or a 404), so the HTTP router can treat static
 * serving as the terminal fall-through after the API routes.
 *
 * @param root absolute web-assets directory (see {@link webRoot})
 * @param pathname the URL pathname (already separated from the query string)
 */
export function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  pathname: string,
): boolean {
  // An "app shell" request is the root or any extensionless client-side route — it must resolve to
  // index.html (or the placeholder), never a 404. A path WITH an extension is a concrete asset request.
  const isAppShell = pathname === "/" || extname(pathname) === "";
  const requested = pathname === "/" ? "/index.html" : pathname;
  const abs = safeResolve(root, requested);
  if (abs === null) {
    sendBody(res, 403, "text/plain; charset=utf-8", "forbidden");
    return true;
  }

  // Try the exact file first.
  if (statForFile(abs)) {
    streamFile(res, abs);
    return true;
  }

  // No exact file. App-shell paths fall back to index.html (SPA routing); when no build exists yet, a
  // friendly placeholder keeps the daemon browseable. A missing *asset* (has an extension) is an honest
  // 404 — never a silent HTML fallback.
  if (isAppShell) {
    const indexPath = safeResolve(root, "/index.html");
    if (indexPath && statForFile(indexPath)) {
      streamFile(res, indexPath);
      return true;
    }
    sendBody(res, 200, "text/html; charset=utf-8", PLACEHOLDER_HTML);
    return true;
  }

  sendBody(res, 404, "text/plain; charset=utf-8", "not found");
  return true;
}

/** `stat` a path, returning it only if it's a regular file (directories aren't served). */
function statForFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** Stream a known-existing file with its content-type + nosniff. Stream errors end with a 500. */
function streamFile(res: ServerResponse, abs: string): void {
  res.writeHead(200, {
    "content-type": contentTypeFor(abs),
    "x-content-type-options": "nosniff",
  });
  const stream = createReadStream(abs);
  stream.on("error", () => {
    // Headers are already sent; we can't change the status, but we must not leave the socket hanging.
    res.end();
  });
  stream.pipe(res);
}
