/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The daemon serves the built SPA from `web/dist` (see src/web/static.ts `webRoot()`), so we build there
// and use absolute asset paths (`base: "/"`). In dev, Vite runs on its own port and proxies the daemon's
// loopback API routes to 127.0.0.1:4773 (the daemon sets no CORS — it only binds loopback). The auth token
// still has to reach the dev page: open the Vite URL with `?token=<token from ~/.ora/daemon.json>`.
const DAEMON = "http://127.0.0.1:4773";

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/events": DAEMON,
      "/runs": DAEMON,
      "/health": DAEMON,
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
