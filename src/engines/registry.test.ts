import { describe, expect, it } from "vitest";

import {
  ENGINE_IDS,
  ENGINE_REGISTRY,
  engineInfo,
  engineOwningModel,
  isValidEngine,
  modelsForEngine,
  validateModelForEngine,
} from "./registry.js";

describe("engine registry", () => {
  it("knows exactly the supported engines", () => {
    expect([...ENGINE_IDS]).toEqual(["claude", "codex"]);
    expect(ENGINE_REGISTRY.map((e) => e.id)).toEqual(["claude", "codex"]);
  });

  it("isValidEngine accepts registered ids and rejects everything else", () => {
    expect(isValidEngine("claude")).toBe(true);
    expect(isValidEngine("codex")).toBe(true);
    expect(isValidEngine("gemini")).toBe(false);
    expect(isValidEngine("")).toBe(false);
    expect(isValidEngine(undefined)).toBe(false);
    expect(isValidEngine(42)).toBe(false);
  });

  it("exposes per-engine model lists that never share ids", () => {
    const claude = modelsForEngine("claude").map((m) => m.value);
    const codex = modelsForEngine("codex").map((m) => m.value);
    expect(claude).toEqual(["opus", "sonnet", "haiku"]);
    expect(codex).toEqual([]);
    // No id curated for two engines at once.
    expect(claude.filter((v) => codex.includes(v))).toEqual([]);
  });

  it("engineInfo returns the record or undefined", () => {
    expect(engineInfo("claude")?.label).toBe("Claude");
    expect(engineInfo("codex")?.models).toEqual([]);
  });

  it("engineOwningModel attributes a known model to its engine", () => {
    expect(engineOwningModel("opus")).toBe("claude");
    expect(engineOwningModel("sonnet")).toBe("claude");
    expect(engineOwningModel("gpt-5-codex")).toBeNull(); // unknown → custom
    expect(engineOwningModel("")).toBeNull();
  });

  describe("validateModelForEngine — cross-engine rejection, not strict allowlist", () => {
    it("accepts a null/empty model (engine default)", () => {
      expect(validateModelForEngine("codex", null)).toEqual({ ok: true });
      expect(validateModelForEngine("codex", undefined)).toEqual({ ok: true });
      expect(validateModelForEngine("codex", "   ")).toEqual({ ok: true });
    });

    it("accepts a known model of the same engine", () => {
      expect(validateModelForEngine("claude", "opus")).toEqual({ ok: true });
    });

    it("accepts an unknown/custom string for any engine", () => {
      expect(validateModelForEngine("codex", "gpt-5-codex")).toEqual({ ok: true });
      expect(validateModelForEngine("claude", "some-future-model")).toEqual({ ok: true });
    });

    it("REJECTS a model that belongs to a different engine (the footgun)", () => {
      const r = validateModelForEngine("codex", "opus");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("claude model");
    });
  });
});
