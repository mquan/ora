/**
 * `--at` time parsing — the one place a human-typed schedule spec becomes a concrete `Date`.
 *
 * Two accepted forms:
 *   - **relative:** `+<n><unit>` where unit ∈ `s|m|h|d` (e.g. `+1m`, `+30s`, `+2h`, `+1d`).
 *   - **absolute:** anything `Date` can parse — primarily ISO 8601 (`2026-06-14T12:00:00Z`).
 *
 * Garbage in → a named {@link InvalidAtError} (never a silent `Invalid Date` that would later arm a
 * croner at NaN). Pure and `now`-injected so it is deterministic to unit-test.
 */

/** Thrown when an `--at` spec is neither a valid `+<n><unit>` nor a parseable absolute date. */
export class InvalidAtError extends Error {
  constructor(spec: string) {
    super(
      `invalid --at value '${spec}': expected a relative offset like '+1m' / '+30s' / '+2h' / '+1d', ` +
        `or an absolute ISO time like '2026-06-14T12:00:00Z'`,
    );
    this.name = "InvalidAtError";
  }
}

const UNIT_MS: { s: number; m: number; h: number; d: number } = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const RELATIVE = /^\+(\d+)(s|m|h|d)$/;

/**
 * Resolve an `--at` spec to a `Date`, relative to `now` (defaults to the current time). Throws
 * {@link InvalidAtError} on anything unparseable.
 */
export function parseAt(spec: string, now: Date = new Date()): Date {
  const trimmed = spec.trim();
  if (trimmed.length === 0) throw new InvalidAtError(spec);

  const rel = RELATIVE.exec(trimmed);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = rel[2] as "s" | "m" | "h" | "d";
    return new Date(now.getTime() + amount * UNIT_MS[unit]);
  }

  // Absolute: only accept if Date actually parsed it (NaN time === unparseable).
  const abs = new Date(trimmed);
  if (Number.isNaN(abs.getTime())) throw new InvalidAtError(spec);
  return abs;
}
