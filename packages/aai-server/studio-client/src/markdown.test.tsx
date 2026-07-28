// Copyright 2025 the AAI authors. MIT license.
// Rendered to static markup rather than through a DOM: the questions here are
// "what elements does this Markdown become" and "is model-authored text
// escaped", both of which the server renderer answers without jsdom.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Markdown } from "./markdown.tsx";

const render = (text: string): string => renderToStaticMarkup(<Markdown text={text} />);

describe("Markdown", () => {
  test("renders emphasis, not literal asterisks", () => {
    const html = render("Say **hello** and *goodbye*");
    expect(html).toContain("<strong>hello</strong>");
    expect(html).toContain("<em>goodbye</em>");
    expect(html).not.toContain("**hello**");
  });

  test("renders bullet and numbered lists", () => {
    expect(render("- one\n- two")).toMatch(/<ul[^>]*>.*<li[^>]*>one<\/li>/s);
    expect(render("1. first\n2. second")).toMatch(/<ol[^>]*>.*<li[^>]*>first<\/li>/s);
  });

  test("renders inline code and fenced blocks differently", () => {
    // Inline code gets the boxed treatment; a fenced block is wrapped in <pre>
    // and must not double up the border.
    const inline = render("call `agent()` first");
    expect(inline).toContain("<code");
    expect(inline).not.toContain("<pre");

    const fenced = render("```ts\nconst x = 1;\n```");
    expect(fenced).toContain("<pre");
    expect(fenced).toContain("const x = 1;");
  });

  test("renders GFM tables and strikethrough", () => {
    expect(render("| a | b |\n| - | - |\n| 1 | 2 |")).toContain("<table");
    expect(render("~~gone~~")).toContain("<del>gone</del>");
  });

  test("links open in a new tab with a safe rel", () => {
    const html = render("[docs](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toMatch(/rel="[^"]*noreferrer/);
  });

  test("does not render raw HTML from model output", () => {
    // This text comes from an LLM, which can be steered by whatever the agent
    // read. Without rehype-raw, react-markdown escapes HTML — keep it that way.
    const html = render('<img src=x onerror="alert(1)"> <script>alert(2)</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;");
  });

  test("leaves plain prose alone", () => {
    expect(render("Just a sentence.")).toContain("Just a sentence.");
  });
});
