/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The daemon serves the built SPA from `web/dist` (see src/web/static.ts `webRoot()`), so we build there
// and use absolute asset paths (`base: "/"`). In dev, Vite runs on its own port and proxies the daemon's
// loopback API routes to 127.0.0.1:4773 (the daemon sets no CORS — it only binds loopback).
//
// DEV-ONLY auth: the daemon's API is bearer-authed, and the dev page would otherwise 401. Rather than make
// the developer paste `?token=`, the proxy injects the token itself: on each proxied request it re-reads
// the daemon's connection file (`daemon.json` under `ORA_HOME ?? ~/.ora`) and sets `Authorization: Bearer`.
// Re-reading per request means a daemon restart's freshly-minted token is picked up with no Vite restart;
// a missing/half-written file (daemon not up yet) just means no header → the request 401s VISIBLY in the UI
// and recovers on the next request once the daemon publishes. This never runs in production, where the
// daemon serves the built SPA on its own port and the browser receives the token from `ora ui`'s URL — so
// the production auth path is untouched.
//
// The proxy TARGET is the daemon's default port (4773); the config is evaluated before the daemon publishes
// `daemon.json`, so the target can't be read dynamically — only the token is. (ORA_PORT-isolated daemons
// aren't proxied; dev expects the default port.)
//
// `daemon.json`'s shape (`{ port, token, … }`) and home resolution are owned by `src/daemon/paths.ts`. We
// duplicate just the token read here rather than import across the build boundary — `web/` is a separate
// build unit, and coupling it to the daemon source tree for ~4 lines of dev-only config isn't worth it.
const DAEMON = "http://127.0.0.1:4773";

/** Read the daemon's bearer token from `daemon.json` (honoring `ORA_HOME`), or null if unavailable. */
function readDaemonToken(): string | null {
  try {
    const home = process.env.ORA_HOME ?? join(homedir(), ".ora");
    const info = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { token?: string };
    return info.token ?? null;
  } catch {
    // Missing or half-written file (daemon not up yet) → no header; the request 401s visibly and recovers.
    return null;
  }
}

/** A proxy entry that injects the daemon bearer token on every forwarded request (dev-only). */
function authedProxy(target: string) {
  return {
    target,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vite's http-proxy `proxy`/`proxyReq` are loosely typed; only setHeader matters.
    configure: (proxy: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      proxy.on("proxyReq", (proxyReq: any) => {
        const token = readDaemonToken();
        if (token) proxyReq.setHeader("Authorization", `Bearer ${token}`);
      });
    },
  };
}

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // All four routes `web/src/api.ts` calls go through the daemon. `/events` and `/runs` cover their
    // `/:id` sub-paths by prefix; `/engines` and `/health` are exact.
    proxy: {
      "/events": authedProxy(DAEMON),
      "/runs": authedProxy(DAEMON),
      "/engines": authedProxy(DAEMON),
      "/health": authedProxy(DAEMON),
    },
  },
  test: {
    // Node env, no DOM. Pure helpers are unit-tested here; component interaction is covered by browser QA.
    // The one component test (Markdown.test.tsx) renders via react-dom/server's renderToStaticMarkup —
    // synchronous and node-safe — so no jsdom is needed. `.tsx` is included for that file.
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
