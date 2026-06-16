import { useEffect, useState } from "react";
import { createEvent, ApiError, NetworkError } from "./api";
import type { Engine, CreateEventBody } from "./types";

/**
 * Create a scheduled run. The daemon exposes only `POST /events` (no edit endpoint yet), so this form is
 * create-only by design — see the task's Decisions. Validation mirrors the server's rules (cwd required and
 * must exist [server R6]; prompt OR mentions required) so the common cases fail fast in the browser, but the
 * server stays the source of truth — its 400/413 messages are surfaced inline rather than swallowed.
 */

const SENTINEL_DEFAULT = "__default__";

/** Engine-scoped model choices. No model API exists, so these are curated; "Custom…" allows any string. */
const MODELS: Record<Engine, { value: string; label: string }[]> = {
  claude: [
    { value: SENTINEL_DEFAULT, label: "Default (CLI default)" },
    { value: "opus", label: "opus" },
    { value: "sonnet", label: "sonnet" },
    { value: "haiku", label: "haiku" },
  ],
  codex: [{ value: SENTINEL_DEFAULT, label: "Default (CLI default)" }],
};

const CUSTOM = "__custom__";

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface EventFormProps {
  onClose: () => void;
  onCreated: () => void;
}

export function EventForm({ onClose, onCreated }: EventFormProps) {
  const [engine, setEngine] = useState<Engine>("claude");
  const [modelChoice, setModelChoice] = useState<string>(SENTINEL_DEFAULT);
  const [customModel, setCustomModel] = useState("");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mentions, setMentions] = useState("");
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 5 * 60_000)));
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const models = MODELS[engine];

  const resolveModel = (): string | null => {
    if (modelChoice === SENTINEL_DEFAULT) return null;
    if (modelChoice === CUSTOM) return customModel.trim() || null;
    return modelChoice;
  };

  const parseMentions = (): string[] | null => {
    const list = mentions.split(/[\s,]+/).map((m) => m.trim()).filter(Boolean);
    return list.length ? list : null;
  };

  const validate = (): string | null => {
    if (!cwd.trim()) return "Working directory (cwd) is required.";
    if (!prompt.trim() && !parseMentions()) return "Provide a prompt or at least one mention.";
    const ts = new Date(when);
    if (Number.isNaN(ts.getTime())) return "Pick a valid date and time.";
    return null;
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    const body: CreateEventBody = {
      engine,
      cwd: cwd.trim(),
      scheduled_at: new Date(when).toISOString(),
      model: resolveModel(),
      prompt: prompt.trim() || null,
      mentions: parseMentions(),
      ...(title.trim() ? { title: title.trim() } : {}),
    };
    setSubmitting(true);
    setError(null);
    try {
      await createEvent(body);
      onCreated();
    } catch (err) {
      if (err instanceof ApiError) setError(`Daemon rejected the run (${err.status}): ${err.message}`);
      else if (err instanceof NetworkError) setError("Can't reach the daemon — is it running?");
      else setError(err instanceof Error ? err.message : "Failed to create the run.");
      setSubmitting(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel form-panel" role="dialog" aria-modal="true" aria-label="New run" onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2>New run</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <form className="form" onSubmit={onSubmit}>
          <label>
            Engine
            <select
              value={engine}
              onChange={(e) => {
                setEngine(e.target.value as Engine);
                setModelChoice(SENTINEL_DEFAULT);
              }}
            >
              <option value="claude">claude</option>
              <option value="codex">codex</option>
            </select>
          </label>

          <label>
            Model
            <select value={modelChoice} onChange={(e) => setModelChoice(e.target.value)}>
              {models.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
              <option value={CUSTOM}>Custom…</option>
            </select>
          </label>
          {modelChoice === CUSTOM && (
            <label>
              Custom model
              <input value={customModel} onChange={(e) => setCustomModel(e.target.value)} placeholder="e.g. claude-opus-4-8" />
            </label>
          )}

          <label>
            Working directory
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/Users/you/project" autoFocus />
          </label>

          <label>
            Prompt
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="What should the agent do?" />
          </label>

          <label>
            Mentions <span className="muted">(skills / docs, space- or comma-separated)</span>
            <input value={mentions} onChange={(e) => setMentions(e.target.value)} placeholder="/review docs/spec.md" />
          </label>

          <label>
            Title <span className="muted">(optional)</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the first line of the prompt" />
          </label>

          <label>
            Schedule
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </label>

          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}

          <div className="form-actions">
            <button type="button" className="btn" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "Scheduling…" : "Schedule run"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
