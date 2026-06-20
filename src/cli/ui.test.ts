/**
 * `ora ui` core tests — `runUi`/`ensureDaemon` over injected effects, so no real daemon is spawned
 * and no real browser opens. Covers the four branches that matter: daemon already up, daemon-down →
 * spawn + poll → up, readiness timeout (clear error, exit 1), and browser-open failure (still exit 0,
 * URL printed for the user).
 */

import { describe, expect, it, vi } from "vitest";

import { runUi, ensureDaemon, uiUrl, type UiDeps } from "./commands/ui.js";
import type { DaemonInfo } from "../daemon/paths.js";

const info: DaemonInfo = { port: 4773, token: "secret-token", pid: 123, startedAt: "2026-01-01T00:00:00Z" };

/** Build a deps object with sensible spies; override per test. A virtual clock makes timeouts exact. */
function makeDeps(over: Partial<UiDeps> = {}): UiDeps & { logs: string[]; errors: string[] } {
  let clock = 0;
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    readInfo: vi.fn(() => info),
    isHealthy: vi.fn(async () => true),
    spawnDaemon: vi.fn(),
    openBrowser: vi.fn(() => true),
    log: (m: string) => void logs.push(m),
    error: (m: string) => void errors.push(m),
    // Advancing the virtual clock on each sleep lets the timeout loop terminate without real waiting.
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    now: () => clock,
    logs,
    errors,
    ...over,
  };
}

describe("uiUrl", () => {
  it("puts the token in the query string", () => {
    expect(uiUrl(info)).toBe("http://127.0.0.1:4773/?token=secret-token");
  });
});

describe("ensureDaemon", () => {
  it("reuses a healthy running daemon without spawning", async () => {
    const deps = makeDeps();
    const result = await ensureDaemon(deps);
    expect(result).toBe(info);
    expect(deps.spawnDaemon).not.toHaveBeenCalled();
    expect(deps.logs.join(" ")).toMatch(/already running/i);
  });

  it("spawns and polls until the daemon becomes healthy", async () => {
    // No info until after the spawn; unhealthy on the first probe, healthy on the second.
    const readInfo = vi.fn().mockReturnValueOnce(null).mockReturnValue(info);
    const isHealthy = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const deps = makeDeps({ readInfo, isHealthy });
    const result = await ensureDaemon(deps, { readyTimeoutMs: 10_000, pollIntervalMs: 250 });
    expect(result).toBe(info);
    expect(deps.spawnDaemon).toHaveBeenCalledOnce();
  });

  it("throws a named timeout error pointing at the log when readiness never comes", async () => {
    const deps = makeDeps({
      readInfo: vi.fn(() => null),
      isHealthy: vi.fn(async () => false),
    });
    await expect(ensureDaemon(deps, { readyTimeoutMs: 1000, pollIntervalMs: 250 })).rejects.toThrow(
      /did not become ready/i,
    );
  });
});

describe("runUi", () => {
  it("opens the browser at the token URL and exits 0 on the happy path", async () => {
    const deps = makeDeps();
    const code = await runUi(deps);
    expect(code).toBe(0);
    expect(deps.openBrowser).toHaveBeenCalledWith("http://127.0.0.1:4773/?token=secret-token");
  });

  it("exits 1 and reports the error when the daemon never becomes ready", async () => {
    const deps = makeDeps({
      readInfo: vi.fn(() => null),
      isHealthy: vi.fn(async () => false),
    });
    const code = await runUi(deps, { readyTimeoutMs: 1000, pollIntervalMs: 250 });
    expect(code).toBe(1);
    expect(deps.errors.join(" ")).toMatch(/did not become ready/i);
    expect(deps.openBrowser).not.toHaveBeenCalled();
  });

  it("still exits 0 and prints the URL when the browser won't open (PR6)", async () => {
    const deps = makeDeps({ openBrowser: vi.fn(() => false) });
    const code = await runUi(deps);
    expect(code).toBe(0);
    expect(deps.logs.join("\n")).toMatch(/open this url manually[\s\S]*4773\/\?token=secret-token/i);
  });
});
