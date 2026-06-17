import { describe, expect, it } from "vitest";

import { normalizeLang, toolPayload } from "./shiki";

// Only the PURE helpers are unit-tested here. The actual highlighting + React rendering run in the
// browser (vitest is the node env, no DOM) and are covered by the QA phase — matching the gregorian
// web convention. Importing this module does NOT pull shiki: `highlight()` dynamic-imports it lazily,
// and these tests never call it.

describe("normalizeLang", () => {
  it("lowercases and trims", () => {
    expect(normalizeLang("  TypeScript ")).toBe("typescript");
  });

  it("maps empty/undefined to the text sentinel", () => {
    expect(normalizeLang("")).toBe("text");
    expect(normalizeLang("   ")).toBe("text");
    expect(normalizeLang(undefined)).toBe("text");
  });

  it("maps an unpreloaded language to the text sentinel (keeps the bundle closed)", () => {
    expect(normalizeLang("php")).toBe("text");
    expect(normalizeLang("rust")).toBe("text");
  });

  it("passes through a preloaded language", () => {
    expect(normalizeLang("bash")).toBe("bash");
    expect(normalizeLang("JSON")).toBe("json");
  });
});

describe("toolPayload", () => {
  it("lifts the shell command out of a Bash tool_use and highlights as bash", () => {
    const text = JSON.stringify({ command: "git status -sb", description: "check tree" });
    expect(toolPayload("Bash", text)).toEqual({ code: "git status -sb", lang: "bash" });
  });

  it("treats a 'shell' tool the same as Bash", () => {
    const text = JSON.stringify({ command: "ls -la" });
    expect(toolPayload("shell", text)).toEqual({ code: "ls -la", lang: "bash" });
  });

  it("pretty-prints non-Bash tool input as json", () => {
    const text = JSON.stringify({ file_path: "/a/b.ts", limit: 50 });
    const out = toolPayload("Read", text);
    expect(out.lang).toBe("json");
    expect(out.code).toBe(JSON.stringify({ file_path: "/a/b.ts", limit: 50 }, null, 2));
  });

  it("falls back to raw-text-as-json when the input is not valid JSON (e.g. truncated)", () => {
    const truncated = '{"command":"echo hello wor';
    expect(toolPayload("Bash", truncated)).toEqual({ code: truncated, lang: "json" });
  });

  it("falls back to json when a Bash input has no string command", () => {
    const text = JSON.stringify({ description: "no command field" });
    const out = toolPayload("Bash", text);
    expect(out.lang).toBe("json");
  });

  it("handles missing text", () => {
    expect(toolPayload("Bash", undefined)).toEqual({ code: "", lang: "json" });
  });
});
