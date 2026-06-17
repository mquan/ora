import type { Run } from "./types";

/**
 * The generated "minutes" for a run — gregorian's `claude -p` summary of what the run did. Owns its
 * own `<details>` disclosure (open by default: minutes are short and the most-wanted read).
 *
 * Trust boundary: `minutes` is agent-authored. It is rendered as React text inside a `<pre>`
 * (auto-escaped) — never `dangerouslySetInnerHTML`. Markdown rendering is a deliberate future
 * enhancement; this component is the seam where it would land.
 */
export function MinutesPanel({ run }: { run: Run }) {
  if (!run.minutes) return null;
  return (
    <details className="minutes" open>
      <summary>Minutes</summary>
      <pre className="text-block">{run.minutes}</pre>
    </details>
  );
}
