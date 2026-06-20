/**
 * Engine registry — the single source of truth for which engines exist and which models each one
 * offers. The daemon server, the CLI `add` command, and (via `GET /engines`) the web form all read
 * from here, so a claude model id and a codex model id can NEVER share a picker and validation can
 * never drift between surfaces.
 *
 * Deliberately a PURE leaf module: it imports only the `EngineKind` type and depends on nothing else
 * in the tree (no store, no daemon). That keeps it importable from any layer without an edge cycle.
 *
 * Model lists are CURATED, not exhaustive — there is no model-listing API for either CLI. So a model
 * id that this registry does not know is NOT rejected: it is treated as a user-supplied custom model
 * (the web form's "Custom…" affordance). The one thing we DO reject is a cross-engine mistake —
 * passing a model that is a KNOWN model of a *different* engine (e.g. `--engine codex --model opus`),
 * which is almost always a footgun, never intent.
 */

import type { EngineKind } from "../types.js";

/** A selectable model for an engine — `value` is what gets passed to the engine, `label` is for UIs. */
export interface ModelChoice {
  value: string;
  label: string;
}

/** Static description of one engine: its id, a human label, and its curated model choices. */
export interface EngineInfo {
  id: EngineKind;
  label: string;
  /** Curated model ids for this engine. May be empty (engine accepts only its CLI default / custom). */
  models: ModelChoice[];
}

/**
 * The registry. claude exposes the three documented aliases; codex curates none (its `-m` accepts
 * provider model ids that change often, so we leave it to "default / custom" rather than bake a stale
 * list). Append engines here; nothing else in the codebase hardcodes the engine set.
 */
export const ENGINE_REGISTRY: readonly EngineInfo[] = [
  {
    id: "claude",
    label: "Claude",
    models: [
      { value: "opus", label: "opus" },
      { value: "sonnet", label: "sonnet" },
      { value: "haiku", label: "haiku" },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    models: [],
  },
];

/** Every valid engine id, in registry order. The one list `VALID_ENGINES` and the CLI now read. */
export const ENGINE_IDS: readonly EngineKind[] = ENGINE_REGISTRY.map((e) => e.id);

/** Type guard: is `s` a registered engine id? */
export function isValidEngine(s: unknown): s is EngineKind {
  return typeof s === "string" && ENGINE_IDS.includes(s as EngineKind);
}

/** The {@link EngineInfo} for an engine, or `undefined` if not registered. */
export function engineInfo(engine: EngineKind): EngineInfo | undefined {
  return ENGINE_REGISTRY.find((e) => e.id === engine);
}

/** The curated model choices for an engine (empty array for an unknown engine). */
export function modelsForEngine(engine: EngineKind): ModelChoice[] {
  return engineInfo(engine)?.models ?? [];
}

/**
 * Which engine curates `modelId` as one of its known models, or `null` if no engine does (i.e. it is
 * an unknown/custom string). Case-sensitive — model ids are exact tokens.
 */
export function engineOwningModel(modelId: string): EngineKind | null {
  for (const e of ENGINE_REGISTRY) {
    if (e.models.some((m) => m.value === modelId)) return e.id;
  }
  return null;
}

/** Result of {@link validateModelForEngine}: ok, or a named reason for the rejection. */
export type ModelValidation = { ok: true } | { ok: false; reason: string };

/**
 * Validate a model id for an engine. Cross-engine rejection, not a strict allowlist:
 *  - empty/whitespace-only or `null`/`undefined` → ok (means "engine default").
 *  - a known model of THIS engine → ok.
 *  - a known model of a DIFFERENT engine → REJECTED (the footgun, e.g. `opus` under codex).
 *  - an unknown string → ok (treated as a custom model — there is no model API to check against).
 */
export function validateModelForEngine(
  engine: EngineKind,
  model: string | null | undefined,
): ModelValidation {
  if (model == null || model.trim().length === 0) return { ok: true };
  const owner = engineOwningModel(model);
  if (owner === null || owner === engine) return { ok: true };
  return {
    ok: false,
    reason: `model '${model}' is a ${owner} model, not valid for engine '${engine}'`,
  };
}
