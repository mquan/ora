import { Markdown } from "./Markdown";
import type { Run } from "./types";

/**
 * The generated "minutes" for a run — ora's `claude -p` summary of what the run did. Owns its
 * own `<details>` disclosure (open by default: minutes are short and the most-wanted read).
 *
 * Trust boundary: `minutes` is agent-authored. It renders through `<Markdown>` (react-markdown → React
 * elements, no raw-HTML passthrough) — never `dangerouslySetInnerHTML`.
 */
export function MinutesPanel({ run }: { run: Run }) {
  if (!run.minutes) return null;
  return (
    <details className="minutes" open>
      <summary>Minutes</summary>
      <Markdown content={run.minutes} />
    </details>
  );
}
