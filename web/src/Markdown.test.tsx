import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "./Markdown";

// Rendered to a static HTML string via react-dom/server (synchronous, node-safe — no jsdom, matching the
// gregorian web convention of a node test env). These cover the two things that matter for agent-authored
// prose: it formats as markdown, and the trust boundary holds (raw HTML stays inert, dangerous URLs drop).
const render = (content: string) => renderToStaticMarkup(<Markdown content={content} />);

describe("Markdown formatting (GFM)", () => {
  it("renders headings", () => {
    expect(render("# Title")).toContain("<h1>Title</h1>");
  });

  it("renders bold and italic", () => {
    const html = render("**bold** and _italic_");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });

  it("renders unordered lists", () => {
    const html = render("- one\n- two");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });

  it("renders fenced code blocks", () => {
    const html = render("```\nconst x = 1;\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    expect(html).toContain("const x = 1;");
  });

  it("renders inline code", () => {
    expect(render("call `foo()` now")).toContain("<code>foo()</code>");
  });

  it("renders GFM tables", () => {
    const html = render("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders GFM strikethrough", () => {
    expect(render("~~gone~~")).toContain("<del>gone</del>");
  });
});

describe("Markdown trust boundary (agent-authored, untrusted)", () => {
  it("does not render raw <script> as an executable element — it is escaped to text", () => {
    const html = render("before <script>alert(1)</script> after");
    // No live <script> tag; the literal source survives as escaped text.
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("does not render raw <img onerror> as a live element", () => {
    const html = render('<img src=x onerror="alert(1)">');
    // No live <img> tag — the whole thing is escaped to inert text, so the onerror handler can never
    // attach. (The word "onerror" survives only inside the escaped &lt;img…&gt; text, which is harmless.)
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).not.toMatch(/onerror=["'][^&]/); // no unescaped, live onerror attribute
  });

  it("drops a javascript: link href (default urlTransform)", () => {
    const html = render("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    // The link text still renders; only the dangerous href is stripped.
    expect(html).toContain("click");
  });

  it("renders external links with rel=noopener noreferrer and target=_blank", () => {
    const html = render("[site](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });
});
