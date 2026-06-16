/**
 * `serveStatic` tests — driven through a real loopback http server so headers, content-types, and the
 * file stream are exercised end-to-end. The security-critical case is path traversal: a request that
 * tries to escape the web root must get a 403 and never read the file. We send the `..` percent-encoded
 * (`%2e%2e%2f`) so the HTTP client doesn't normalize it away before it reaches the server.
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { serveStatic } from "./static.js";

describe("serveStatic", () => {
  let root: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "greg-webroot-"));
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      serveStatic(req, res, root, pathname);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  it("serves index.html at / with the right content-type and nosniff", async () => {
    writeFileSync(join(root, "index.html"), "<h1>hi</h1>");
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("<h1>hi</h1>");
  });

  it("serves a JS asset with the javascript content-type", async () => {
    writeFileSync(join(root, "app.js"), "export const x = 1;");
    const res = await fetch(`${base}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(await res.text()).toBe("export const x = 1;");
  });

  it("serves nested assets under a subdirectory", async () => {
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "main.css"), "body{}");
    const res = await fetch(`${base}/assets/main.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/css/);
  });

  it("rejects path traversal with 403 before reading anything (PR1)", async () => {
    writeFileSync(join(root, "index.html"), "<h1>app</h1>");
    // `../../../../etc/passwd`, percent-encoded so the HTTP client doesn't normalize the dots away.
    const res = await fetch(`${base}/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("forbidden");
  });

  it("falls back to index.html for an unknown extensionless route (SPA routing)", async () => {
    writeFileSync(join(root, "index.html"), "<h1>spa</h1>");
    const res = await fetch(`${base}/event/abc123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>spa</h1>");
  });

  it("404s a missing asset that has a file extension (no silent HTML fallback)", async () => {
    writeFileSync(join(root, "index.html"), "<h1>spa</h1>");
    const res = await fetch(`${base}/missing.js`);
    expect(res.status).toBe(404);
  });

  it("serves a placeholder page when no build exists yet", async () => {
    // root is empty — no index.html.
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toMatch(/hasn't been built yet|web UI/i);
  });
});
