/**
 * native-check tests — the loader is injected, so the failure path is exercised without an actually
 * broken better-sqlite3 install. Asserts the friendly message names the supported Node range and leaks
 * no stack frames.
 */

import { describe, expect, it } from "vitest";

import { checkNativeModules } from "./native-check.js";

describe("checkNativeModules", () => {
  it("returns ok when the native module loads", () => {
    expect(checkNativeModules(() => {})).toEqual({ ok: true });
  });

  it("returns a friendly, stack-free message when the loader throws", () => {
    const err = new Error(
      "Error: dlopen(better_sqlite3.node): ABI mismatch\n    at Object..node (node:internal/modules)\n    at Module._load",
    );
    const result = checkNativeModules(() => {
      throw err;
    });
    expect(result.ok).toBe(false);
    if (result.ok) return; // narrow for the type checker
    expect(result.message).toContain(">=20 <23");
    expect(result.message).toMatch(/Node/);
    expect(result.message).toMatch(/npm rebuild better-sqlite3/);
    // Only the cause's first line is included — no `    at ...` stack frames leak through.
    expect(result.message).not.toMatch(/\n\s+at /);
    expect(result.message).toContain("ABI mismatch");
  });
});
