// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { _internals, runRagCommand } from "./rag.tsx";

const { splitPages, parsePage, stripNoise, slugify } = _internals;

// --- slugify ---

describe("slugify", () => {
  test("strips protocol and lowercases", () => {
    expect(slugify("https://Example.Com/Docs")).toBe("example-com-docs");
  });

  test("replaces non-alphanumeric chars with hyphens", () => {
    expect(slugify("hello world! @#$% test")).toBe("hello-world-test");
  });

  test("strips leading/trailing hyphens", () => {
    expect(slugify("---foo---")).toBe("foo");
  });

  test("strips leading markdown headings", () => {
    expect(slugify("## My Heading")).toBe("my-heading");
  });

  test("truncates to 80 chars", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBe(80);
  });

  test("handles empty string", () => {
    expect(slugify("")).toBe("");
  });
});

// --- stripNoise ---

describe("stripNoise", () => {
  test("removes fenced code blocks", () => {
    const input = "before\n```js\nconst x = 1;\n```\nafter";
    expect(stripNoise(input)).toBe("before\n\nafter");
  });

  test("removes indented code blocks", () => {
    const input = "text\n    code line\n    more code\ntext2";
    expect(stripNoise(input)).toBe("text\n\ntext2");
  });

  test("removes inline code", () => {
    const input = "use `foo()` here";
    expect(stripNoise(input)).toBe("use  here");
  });

  test("removes HTML tags", () => {
    const input = "<div class='test'>content</div>";
    expect(stripNoise(input)).toBe("content");
  });

  test("removes JSX comments", () => {
    const input = "before {/* comment */} after";
    expect(stripNoise(input)).toBe("before  after");
  });

  test("collapses multiple blank lines", () => {
    const input = "a\n\n\n\n\nb";
    expect(stripNoise(input)).toBe("a\n\nb");
  });

  test("trims result", () => {
    expect(stripNoise("  hello  ")).toBe("hello");
  });
});

// --- parsePage ---

describe("parsePage", () => {
  test("extracts title from YAML frontmatter", () => {
    const input = "title: My Page\n---\nBody text here";
    const result = parsePage(input);
    expect(result.title).toBe("My Page");
    expect(result.body).toBe("Body text here");
  });

  test("extracts title from heading when no frontmatter", () => {
    const input = "# Introduction\nSome content";
    const result = parsePage(input);
    expect(result.title).toBe("Introduction");
    expect(result.body).toContain("Some content");
  });

  test("extracts title from ## title: format", () => {
    const input = "## title: Getting Started\nContent here";
    const result = parsePage(input);
    expect(result.title).toBe("Getting Started");
    expect(result.body).toBe("Content here");
  });

  test("returns empty title for plain text", () => {
    const input = "Just plain text without any heading";
    const result = parsePage(input);
    expect(result.title).toBe("");
    expect(result.body).toBe("Just plain text without any heading");
  });
});

// --- splitPages ---

describe("splitPages", () => {
  test("splits on *** separator", () => {
    const input = "# Page 1\nContent 1\n***\n# Page 2\nContent 2";
    const pages = splitPages(input);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.title).toBe("Page 1");
    expect(pages[1]?.title).toBe("Page 2");
  });

  test("returns single page when no separator", () => {
    const input = "# Single Page\nContent";
    const pages = splitPages(input);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.title).toBe("Single Page");
  });

  test("skips empty sections", () => {
    const input = "***\n\n***\n# Real Page\nContent\n***\n\n***";
    const pages = splitPages(input);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.title).toBe("Real Page");
  });

  test("handles multiple *** characters", () => {
    const input = "# A\nBody A\n*****\n# B\nBody B";
    const pages = splitPages(input);
    expect(pages).toHaveLength(2);
  });
});

// --- runRagCommand arg validation ---

describe("runRagCommand", () => {
  test("invalid URL throws", async () => {
    await expect(runRagCommand({ url: "not-a-url", cwd: "." })).rejects.toThrow("Invalid URL");
  });
});
