import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders agent-authored prose (transcript message bodies, run minutes) as GFM markdown — headings,
 * lists, tables, task lists, strikethrough, fenced code, bold/italic.
 *
 * Trust boundary (load-bearing — do not regress): `content` is AGENT-AUTHORED and effectively untrusted.
 * `react-markdown` renders to React elements (auto-escaped) — NEVER `dangerouslySetInnerHTML`. We do NOT
 * enable `rehype-raw` (or any raw-HTML rehype plugin), so embedded HTML stays inert escaped text and never
 * executes. URL safety rides on react-markdown's default `urlTransform`, which strips dangerous protocols
 * (`javascript:` etc.); `Markdown.test.tsx` asserts all of this so a dependency bump can't regress it
 * silently. The single-place trust boundary lives here, shared by both call sites.
 */

// External links open safely. `node` (the mdast node react-markdown passes) is stripped so it never lands
// as a DOM attribute. `href` arrives already sanitized by the default urlTransform.
const components: Components = {
  a({ node: _node, ...props }) {
    return <a {...props} target="_blank" rel="noopener noreferrer" />;
  },
};

export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={className ? `markdown ${className}` : "markdown"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
