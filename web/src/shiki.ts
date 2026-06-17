/**
 * Shiki highlighting for the transcript viewer. Ported from miso's ShikiViewer pattern: ONE
 * process-wide highlighter (a single grammar/theme init for the whole SPA), created lazily.
 *
 * Two deliberate deviations from miso, both for bundle hygiene + theming:
 *   1. The **fine-grained core** (`shiki/core` + the JS regex engine + explicit lang/theme imports)
 *      instead of the full `shiki` bundle. The full bundle makes the dynamic `loadLanguage` path emit
 *      every grammar (php, cpp, a 600 KB oniguruma wasm, …) as a chunk; the core pulls ONLY the
 *      grammars we actually highlight. The whole thing is dynamic-`import()`ed inside
 *      `getHighlighter`, so none of it lands in the initial SPA bundle — it loads when a transcript
 *      is first opened.
 *   2. **Dual theme** (github-light + github-dark) via CSS variables (`defaultColor: false`), so blocks
 *      follow the SPA's `prefers-color-scheme` instead of miso's hardcoded dark.
 *
 * Grammars: `CodeBlock` only ever renders tool-use inputs (Bash → bash, everything else → json) and
 * the raw-JSON toggle (json). We preload a small, useful superset so future callers don't pay a reload.
 *
 * Trust boundary: Shiki escapes the source into `<span>` text nodes; the only HTML structure comes
 * from Shiki itself. The viewer renders the returned string via `dangerouslySetInnerHTML` safely.
 */

import type { HighlighterCore } from "shiki/core";

/** Lang ids we preload — what shows up in agent tool inputs (+ a small headroom set). */
const PRELOADED_LANGS = ["bash", "json", "typescript", "javascript", "python", "markdown", "diff"] as const;
type PreloadedLang = (typeof PRELOADED_LANGS)[number];
const PRELOADED_LANG_SET: ReadonlySet<string> = new Set(PRELOADED_LANGS);

export const THEME_LIGHT = "github-light";
export const THEME_DARK = "github-dark";

let highlighterPromise: Promise<HighlighterCore> | null = null;

/** One highlighter for the whole SPA. Dynamic-imports the fine-grained core + only the grammars/themes
 *  we use, so nothing here is in the initial bundle and no unused languages are shipped. */
async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
      ]);
      return createHighlighterCore({
        themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
        langs: [
          import("@shikijs/langs/bash"),
          import("@shikijs/langs/json"),
          import("@shikijs/langs/typescript"),
          import("@shikijs/langs/javascript"),
          import("@shikijs/langs/python"),
          import("@shikijs/langs/markdown"),
          import("@shikijs/langs/diff"),
        ],
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return highlighterPromise;
}

/** Lowercase + trim a language id; empty/undefined or an unpreloaded lang → the `"text"` sentinel
 *  (rendered as a plain `<pre>`, never highlighted — keeps the bundle closed over PRELOADED_LANGS). */
export function normalizeLang(lang: string | undefined): string {
  const l = lang?.toLowerCase().trim();
  if (!l) return "text";
  return PRELOADED_LANG_SET.has(l) ? l : "text";
}

/** A code payload for a transcript turn: the source to show and the language to highlight it as. */
export interface CodePayload {
  code: string;
  lang: string;
}

/**
 * Turn a `tool_use` entry into a readable, highlightable payload. Pure (unit-tested).
 *
 * `text` is always `JSON.stringify(toolInput)` (see the claude adapter's `mapLine`). For `Bash` we
 * lift the actual shell `command` out and highlight it as bash — the genuine "read what the agent
 * did" — instead of burying it in JSON. Every other tool shows its input as pretty-printed JSON.
 * Falls back to raw text-as-json when the input can't be parsed (e.g. it was truncated mid-object).
 */
export function toolPayload(toolName: string | undefined, text: string | undefined): CodePayload {
  const raw = text ?? "";
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return { code: raw, lang: "json" };
  }

  const name = toolName?.toLowerCase() ?? "";
  if ((name === "bash" || name === "shell") && isRecord(input) && typeof input.command === "string") {
    return { code: input.command, lang: "bash" };
  }
  return { code: JSON.stringify(input, null, 2), lang: "json" };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Highlight `code` as `lang`, returning Shiki's dual-theme HTML. Returns `null` when highlighting
 * isn't possible (lang normalizes to `text`, or any error) so the caller can render a plain `<pre>`
 * fallback. Never throws.
 */
export async function highlight(code: string, lang: string): Promise<string | null> {
  const normalized = normalizeLang(lang);
  if (normalized === "text") return null;
  try {
    const highlighter = await getHighlighter();
    return highlighter.codeToHtml(code, {
      lang: normalized as PreloadedLang,
      themes: { light: THEME_LIGHT, dark: THEME_DARK },
      defaultColor: false,
    });
  } catch (e) {
    console.error("gregorian: shiki highlight failed", e);
    return null;
  }
}
