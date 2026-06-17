import { useEffect, useState } from "react";

import { ApiError, NetworkError, getTranscript } from "./api";
import { highlight, toolPayload } from "./shiki";
import type { TranscriptEvent, TranscriptResult } from "./types";

/**
 * The "reading whoa": open a completed run and read what the agent actually did. Renders the run's
 * normalized transcript (from `GET /runs/:id/transcript`) as a structured conversation — assistant
 * turns, tool calls (Shiki-highlighted), and tool results — with a raw-JSON escape hatch.
 *
 * Lazy by construction: the viewer lives in a collapsed `<details>` and only fetches on first expand,
 * so a detail panel with several run cards doesn't fire several transcript fetches + highlight passes
 * at once. Shiki itself is dynamic-imported (see ./shiki), so nothing here touches the initial bundle.
 *
 * No silent failures: every degraded state (unreachable daemon, named server `reason`, empty entries,
 * all-unrenderable entries, truncation) shows a visible, named notice.
 *
 * Trust boundary: message/result text is agent-authored and rendered as React text (auto-escaped).
 * Only Shiki output — which escapes source into `<span>` text nodes — goes through
 * `dangerouslySetInnerHTML`.
 */

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; result: TranscriptResult };

export function TranscriptViewer({ runId }: { runId: string }) {
  const [opened, setOpened] = useState(false);
  const [raw, setRaw] = useState(false);
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    if (!opened) return;
    let active = true;
    setState({ status: "loading" });
    getTranscript(runId)
      .then(({ transcript }) => {
        if (active) setState({ status: "ready", result: transcript });
      })
      .catch((err: unknown) => {
        if (!active) return;
        let message: string;
        if (err instanceof ApiError) message = err.status === 404 ? "This run no longer exists." : `Error ${err.status}: ${err.message}`;
        else if (err instanceof NetworkError) message = "Can't reach the daemon.";
        else message = err instanceof Error ? err.message : "Failed to load the transcript.";
        setState({ status: "error", message });
      });
    return () => {
      active = false;
    };
  }, [opened, runId]);

  return (
    <details className="transcript" onToggle={(e) => setOpened((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>Transcript</summary>
      {opened && (
        <div className="transcript-body">
          {state.status === "loading" && <p className="muted small">Loading transcript…</p>}
          {state.status === "error" && (
            <p className="form-error small" role="alert">
              {state.message}
            </p>
          )}
          {state.status === "ready" && <TranscriptBody result={state.result} raw={raw} onToggleRaw={() => setRaw((r) => !r)} />}
        </div>
      )}
    </details>
  );
}

function TranscriptBody({ result, raw, onToggleRaw }: { result: TranscriptResult; raw: boolean; onToggleRaw: () => void }) {
  const { entries, reason, truncated } = result;

  // A degraded read (null path, deleted file, engine not available, …) — server names the reason.
  if (reason && entries.length === 0) {
    return <p className="muted small">Transcript unavailable: {reason}</p>;
  }

  const hasRenderable = entries.some((e) => (e.type === "message" || e.type === "tool_use" || e.type === "tool_result") && (e.text ?? "").trim().length > 0);

  return (
    <>
      <div className="transcript-toolbar">
        <button type="button" className="link-btn" onClick={onToggleRaw}>
          {raw ? "Structured view" : "Raw JSON"}
        </button>
        <span className="muted small">
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      {reason && <p className="muted small">Note: {reason}</p>}

      {entries.length === 0 ? (
        <p className="muted small">No transcript content recorded.</p>
      ) : raw ? (
        <CodeBlock code={JSON.stringify(entries.map((e) => e.raw), null, 2)} lang="json" />
      ) : (
        <>
          {!hasRenderable && <p className="muted small">Transcript recorded but contains no readable turns — use Raw JSON to inspect.</p>}
          <ol className="transcript-entries">
            {entries.map((entry, i) => (
              <EntryRow key={i} entry={entry} />
            ))}
          </ol>
        </>
      )}

      {truncated && <p className="muted small transcript-truncated">Transcript truncated — showing the first {entries.length} entries (large transcripts are capped to stay responsive).</p>}
    </>
  );
}

function EntryRow({ entry }: { entry: TranscriptEvent }) {
  switch (entry.type) {
    case "message": {
      const role = entry.role ?? "assistant";
      const text = entry.text ?? "";
      if (!text.trim()) return null;
      return (
        <li className={`t-entry t-message t-${role}`}>
          <span className="t-label">{role}</span>
          <div className="t-text">{text}</div>
        </li>
      );
    }
    case "tool_use": {
      const { code, lang } = toolPayload(entry.toolName, entry.text);
      return (
        <li className="t-entry t-tool-use">
          <span className="t-label">🔧 {entry.toolName ?? "tool"}</span>
          <CodeBlock code={code} lang={lang} />
        </li>
      );
    }
    case "tool_result": {
      const text = entry.text ?? "";
      if (!text.trim()) return null;
      return (
        <li className="t-entry t-tool-result">
          <details>
            <summary className="t-label">result{entry.toolName ? ` · ${entry.toolName}` : ""}</summary>
            <pre className="text-block">{text}</pre>
          </details>
        </li>
      );
    }
    default: {
      // system / unknown — compact, muted, so the stream stays scannable without hiding anything.
      const text = entry.text ?? "";
      return (
        <li className="t-entry t-system">
          <span className="t-label">{entry.type}</span>
          {text.trim() && <span className="muted small"> {text}</span>}
        </li>
      );
    }
  }
}

/** Async Shiki highlight with a plain-`<pre>` fallback. Renders Shiki HTML via `dangerouslySetInnerHTML`
 *  (safe — Shiki escapes source into span text nodes). Falls back while loading and on any failure. */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setHtml(null);
    highlight(code, lang).then((out) => {
      if (active) setHtml(out);
    });
    return () => {
      active = false;
    };
  }, [code, lang]);

  if (html) {
    return <div className="code-block" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <pre className="code-block code-fallback">{code}</pre>;
}
