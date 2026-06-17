/**
 * First-run guard for the better-sqlite3 native module.
 *
 * better-sqlite3 ships prebuilt binaries only for the pinned Node range (`>=20 <23`). On an
 * unsupported Node (or a wrong-arch/ABI prebuild), loading it throws `ERR_DLOPEN_FAILED` — and because
 * `store.ts` imports it at module top-level, that throw would surface as a raw stack trace at
 * module-evaluation time, before the CLI's `main()` ever runs. The CLI entry therefore loads its
 * command modules lazily and runs this check FIRST, turning that crash into a friendly, named message.
 *
 * The loader is injected so the failure path is unit-testable without an actually-broken install.
 */

import { createRequire } from "node:module";

/** The Node range better-sqlite3 publishes prebuilt binaries for (kept in sync with package.json engines). */
const SUPPORTED_NODE = ">=20 <23";

export type NativeCheckResult = { ok: true } | { ok: false; message: string };

/** Default loader: synchronously require better-sqlite3, surfacing a native load failure as a throw. */
function defaultLoad(): void {
  const require = createRequire(import.meta.url);
  require("better-sqlite3");
}

/**
 * Verify the native module loads. On failure, return a friendly message (no stack trace) naming the
 * supported Node range and the running version, plus the underlying cause's first line for diagnosis.
 */
export function checkNativeModules(load: () => void = defaultLoad): NativeCheckResult {
  try {
    load();
    return { ok: true };
  } catch (err) {
    // Take only the first line so no `    at ...` stack frames leak into the user-facing message.
    const cause = ((err as Error)?.message ?? String(err)).split("\n")[0];
    const message =
      `gregorian: the better-sqlite3 native module failed to load.\n` +
      `  gregorian needs Node ${SUPPORTED_NODE} (prebuilt binaries cover that range); ` +
      `you're on Node ${process.versions.node}.\n` +
      `  Fix: switch to a supported Node and reinstall, or run \`npm rebuild better-sqlite3\`.\n` +
      `  (cause: ${cause})`;
    return { ok: false, message };
  }
}
