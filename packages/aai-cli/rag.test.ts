// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import {
  chunkPages,
  parsePage,
  runRagCommand,
  slugify,
  splitPages,
  stripNoise,
  upsertChunks,
} from "./rag.ts";

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

  test("handles http:// protocol", () => {
    expect(slugify("http://example.com")).toBe("example-com");
  });
});

// --- stripNoise ---

describe("stripNoise", () => {
  test("removes fenced code blocks", () => {
    const input = "before\n```js\nconst x = 1;\n```\nafter";
    expect(stripNoise(input)).toBe("before\n\nafter");
  });

  test("removes tilde fenced code blocks", () => {
    const input = "before\n~~~python\nprint('hi')\n~~~\nafter";
    expect(stripNoise(input)).toBe("before\n\nafter");
  });

  test("removes indented code blocks", () => {
    const input = "text\n    code line\n    more code\ntext2";
    expect(stripNoise(input)).toBe("text\n\ntext2");
  });

  test("removes tab-indented code blocks", () => {
    const input = "text\n\tcode line\ntext2";
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

  test("removes self-closing HTML tags", () => {
    const input = "before <br/> after";
    expect(stripNoise(input)).toBe("before  after");
  });

  test("removes JSX comments", () => {
    const input = "before {/* comment */} after";
    expect(stripNoise(input)).toBe("before  after");
  });

  test("removes leftover JSX fragments", () => {
    const input = 'text\n  } href="foo"\nmore';
    expect(stripNoise(input)).toBe("text\n\nmore");
  });

  test("collapses multiple blank lines", () => {
    const input = "a\n\n\n\n\nb";
    expect(stripNoise(input)).toBe("a\n\nb");
  });

  test("trims result", () => {
    expect(stripNoise("  hello  ")).toBe("hello");
  });

  test("returns empty string for all-code input", () => {
    const input = "```js\nconst x = 1;\n```";
    expect(stripNoise(input)).toBe("");
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

  test("frontmatter without title field", () => {
    const input = "author: someone\n---\nBody text";
    const result = parsePage(input);
    // No title in frontmatter, falls back to heading check in body
    expect(result.body).toBe("Body text");
  });

  test("h2 heading used as title", () => {
    const input = "## Overview\nDetails here";
    const result = parsePage(input);
    expect(result.title).toBe("Overview");
  });

  test("h3 heading used as title", () => {
    const input = "### Section\nMore details";
    const result = parsePage(input);
    expect(result.title).toBe("Section");
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

  test("empty input returns empty array", () => {
    expect(splitPages("")).toHaveLength(0);
  });

  test("whitespace-only input returns empty array", () => {
    expect(splitPages("   \n\n  ")).toHaveLength(0);
  });
});

// --- chunkPages ---

describe("chunkPages", () => {
  const mockChunker = {
    chunk: async (text: string) => [{ text, tokenCount: text.split(" ").length }],
  };

  test("chunks pages with titles", async () => {
    const pages = [{ title: "Intro", body: "Hello world" }];
    const chunks = await chunkPages(pages, mockChunker, "https://example.com", "example-com");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.data).toBe("Intro\n\nHello world");
    expect(chunks[0]?.id).toBe("example-com:intro:0");
    expect(chunks[0]?.metadata.source).toBe("https://example.com");
    expect(chunks[0]?.metadata.title).toBe("Intro");
  });

  test("chunks pages without titles", async () => {
    const pages = [{ title: "", body: "Plain text" }];
    const chunks = await chunkPages(pages, mockChunker, "https://example.com", "example-com");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.data).toBe("Plain text");
    expect(chunks[0]?.id).toBe("example-com:page:0");
    expect(chunks[0]?.metadata.title).toBeUndefined();
  });

  test("skips pages with empty body after stripNoise", async () => {
    const pages = [{ title: "Code Only", body: "```js\ncode\n```" }];
    const chunks = await chunkPages(pages, mockChunker, "https://example.com", "example-com");
    expect(chunks).toHaveLength(0);
  });

  test("handles multiple chunks per page", async () => {
    const multiChunker = {
      chunk: async (_text: string) => [
        { text: "chunk 1", tokenCount: 2 },
        { text: "chunk 2", tokenCount: 2 },
      ],
    };
    const pages = [{ title: "Page", body: "Long text" }];
    const chunks = await chunkPages(pages, multiChunker, "https://example.com", "example-com");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.id).toBe("example-com:page:0");
    expect(chunks[1]?.id).toBe("example-com:page:1");
  });

  test("handles multiple pages", async () => {
    const pages = [
      { title: "A", body: "First" },
      { title: "B", body: "Second" },
    ];
    const chunks = await chunkPages(pages, mockChunker, "https://example.com", "example-com");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.metadata.title).toBe("A");
    expect(chunks[1]?.metadata.title).toBe("B");
  });

  test("includes tokenCount in metadata", async () => {
    const pages = [{ title: "T", body: "one two three" }];
    const chunks = await chunkPages(pages, mockChunker, "https://example.com", "site");
    expect(chunks[0]?.metadata.tokenCount).toBe(3);
  });
});

// --- upsertChunks ---

describe("upsertChunks", () => {
  test("upserts all chunks successfully", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const chunks = [
      { id: "c1", data: "hello", metadata: {} },
      { id: "c2", data: "world", metadata: {} },
    ];
    const result = await upsertChunks(
      chunks,
      "http://localhost/v",
      "key",
      () => {
        /* noop */
      },
      mockFetch,
    );
    expect(result.upserted).toBe(2);
    expect(result.errors).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("sends correct headers and body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const chunks = [{ id: "c1", data: "hello", metadata: { source: "test" } }];
    await upsertChunks(
      chunks,
      "http://localhost/v",
      "my-key",
      () => {
        /* noop */
      },
      mockFetch,
    );
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost/v");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer my-key");
    const body = JSON.parse(init?.body as string);
    expect(body.op).toBe("upsert");
    expect(body.id).toBe("c1");
    expect(body.data).toBe("hello");
  });

  test("counts errors on non-ok responses", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("internal error", { status: 500 }));
    const chunks = [{ id: "c1", data: "hello", metadata: {} }];
    const result = await upsertChunks(
      chunks,
      "http://localhost/v",
      "key",
      () => {
        /* noop */
      },
      mockFetch,
    );
    expect(result.upserted).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.lastError).toBe("internal error");
  });

  test("counts errors on fetch exceptions", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const chunks = [{ id: "c1", data: "hello", metadata: {} }];
    const result = await upsertChunks(
      chunks,
      "http://localhost/v",
      "key",
      () => {
        /* noop */
      },
      mockFetch,
    );
    expect(result.upserted).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.lastError).toBe("ECONNREFUSED");
  });

  test("calls setStatus with progress", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const statusCalls: unknown[] = [];
    const chunks = [{ id: "c1", data: "hello", metadata: {} }];
    await upsertChunks(chunks, "http://localhost/v", "key", (s) => statusCalls.push(s), mockFetch);
    // Should have initial call, per-chunk call, and final null
    expect(statusCalls.length).toBeGreaterThanOrEqual(2);
    expect(statusCalls[statusCalls.length - 1]).toBeNull();
  });

  test("handles empty chunk array", async () => {
    const mockFetch = vi.fn();
    const result = await upsertChunks(
      [],
      "http://localhost/v",
      "key",
      () => {
        /* noop */
      },
      mockFetch,
    );
    expect(result.upserted).toBe(0);
    expect(result.errors).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("handles mixed success and failure", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      call++;
      if (call === 2) return Promise.resolve(new Response("fail", { status: 500 }));
      return Promise.resolve(new Response("ok", { status: 200 }));
    });
    const chunks = [
      { id: "c1", data: "a", metadata: {} },
      { id: "c2", data: "b", metadata: {} },
      { id: "c3", data: "c", metadata: {} },
    ];
    const result = await upsertChunks(
      chunks,
      "http://localhost/v",
      "key",
      () => {
        /* noop */
      },
      mockFetch,
    );
    expect(result.upserted).toBe(2);
    expect(result.errors).toBe(1);
  });
});

// --- runRagCommand arg validation ---

describe("runRagCommand", () => {
  test("invalid URL throws", async () => {
    await expect(runRagCommand({ url: "not-a-url", cwd: "." })).rejects.toThrow("Invalid URL");
  });

  test("valid URL but missing project config throws", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "aai_rag_"));
    try {
      await expect(
        runRagCommand({ url: "https://example.com/llms-full.txt", cwd: dir }),
      ).rejects.toThrow("No .aai/project.json found");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
