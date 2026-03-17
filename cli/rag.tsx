/** @jsxImportSource react */
// Copyright 2025 the AAI authors. MIT license.

import { render, Text, useApp } from "ink";
import minimist from "minimist";
import pLimit from "p-limit";
import type React from "react";
import { useEffect, useState } from "react";
import { DEFAULT_SERVER, getApiKey, isDevMode, readProjectConfig } from "./_discover.ts";
import type { SubcommandDef } from "./_help.ts";
import { subcommandHelp } from "./_help.ts";
import { Detail, ErrorLine, Info, Step, StepLog, useStepLog, Warn } from "./_ink.tsx";

/** CLI definition for the `aai rag` subcommand. */
const ragCommandDef: SubcommandDef = {
  name: "rag",
  description: "Ingest a site's llms-full.txt into the vector store",
  args: [{ name: "url" }],
  options: [
    { flags: "-s, --server <url>", description: "Server URL" },
    {
      flags: "--chunk-size <n>",
      description: "Max chunk size in tokens (default: 512)",
    },
  ],
};

const FETCH_TIMEOUT_MS = 60_000;
const PAD = 9;

type RagUIProps = {
  url: string;
  apiKey: string;
  serverUrl: string;
  slug: string;
  chunkSize: number;
  onError?: (err: Error) => void;
};

function RagUI({ url, apiKey, serverUrl, slug, chunkSize, onError }: RagUIProps) {
  const { exit } = useApp();
  const { items, log } = useStepLog();
  const [progress, setProgress] = useState<{
    completed: number;
    total: number;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await runRag({
          url,
          apiKey,
          serverUrl,
          slug,
          chunkSize,
          log,
          setProgress,
        });
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        setErr(error.message);
        onError?.(error);
      }
      setProgress(null);
      exit();
    })();
  }, [apiKey, chunkSize, exit, log, onError, serverUrl, slug, url]);

  return (
    <>
      <StepLog items={items} />
      {err && <ErrorLine msg={err} />}
      {progress && (
        <Text>
          {" ".repeat(PAD + 1)}Upsert {progress.completed}/{progress.total} (
          {Math.round((progress.completed / progress.total) * 100)}
          %)
        </Text>
      )}
    </>
  );
}

type VectorChunk = {
  id: string;
  data: string;
  metadata: Record<string, unknown>;
};

async function runRag(opts: {
  url: string;
  apiKey: string;
  serverUrl: string;
  slug: string;
  chunkSize: number;
  log: (node: React.ReactNode) => void;
  setProgress: (p: { completed: number; total: number } | null) => void;
}) {
  const { url, apiKey, serverUrl, slug, chunkSize, log, setProgress } = opts;

  // Fetch
  log(<Step action="Fetch" msg={url} />);
  const resp = await fetch(url, {
    headers: { "User-Agent": "aai-cli/1.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch: ${resp.status} ${resp.statusText}`);
  }

  const content = await resp.text();
  if (content.length === 0) {
    log(<Warn msg="File is empty" />);
    return;
  }
  log(<Info msg={`${(content.length / 1024).toFixed(0)} KB`} />);

  // Split into pages, then chunk each page
  const origin = new URL(url).origin;
  const pages = splitPages(content);
  log(<Step action="Parsed" msg={`${pages.length} pages`} />);

  const { RecursiveChunker } = await import("@chonkiejs/core");
  const chunker = await RecursiveChunker.create({ chunkSize });

  const allChunks: VectorChunk[] = [];
  const siteSlug = slugify(origin);

  for (const page of pages) {
    page.body = stripNoise(page.body);
    if (!page.body) continue;
    const raw = await chunker.chunk(page.body);
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]!;
      const data = page.title ? `${page.title}\n\n${c.text}` : c.text;
      const id = `${siteSlug}:${slugify(page.title || "page")}:${i}`;
      allChunks.push({
        id,
        data,
        metadata: {
          source: origin,
          ...(page.title ? { title: page.title } : {}),
          tokenCount: c.tokenCount,
        },
      });
    }
  }

  log(<Step action="Chunked" msg={`${allChunks.length} chunks`} />);

  // Upsert (concurrent with pool)
  const vectorUrl = `${serverUrl}/${slug}/vector`;
  log(<Info msg={`target: ${vectorUrl}`} />);
  const total = allChunks.length;
  let completed = 0;
  let upserted = 0;
  let errors = 0;
  let lastError = "";

  setProgress({ completed: 0, total });

  const limit = pLimit(5);
  await Promise.all(
    allChunks.map((chunk) =>
      limit(async () => {
        try {
          const r = await fetch(vectorUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              op: "upsert",
              id: chunk.id,
              data: chunk.data,
              metadata: chunk.metadata,
            }),
          });
          if (!r.ok) {
            lastError = await r.text();
            errors++;
          } else {
            upserted++;
          }
        } catch (err: unknown) {
          lastError = err instanceof Error ? err.message : String(err);
          errors++;
        }
        completed++;
        setProgress({ completed, total });
      }),
    ),
  );

  log(<Step action="Done" msg={`${upserted} chunks upserted`} />);
  if (errors > 0) {
    log(<Warn msg={`${errors} failed`} />);
    if (lastError) log(<Info msg={`last error: ${lastError}`} />);
  }
  log(<Detail msg={`Agent: ${slug}`} />);
}

/**
 * Runs the `aai rag <url>` subcommand.
 *
 * Fetches a site's `llms-full.txt`, chunks the markdown content
 * using chonkie's RecursiveChunker, and upserts chunks to the
 * vector store via POST /:slug/vector.
 *
 * Usage: aai rag https://example.com/docs/llms-full.txt
 */
export async function runRagCommand(args: string[], version: string): Promise<void> {
  const parsed = minimist(args, {
    string: ["server", "chunk-size"],
    boolean: ["help"],
    alias: { s: "server", h: "help" },
    stopEarly: true,
  });

  if (parsed.help) {
    console.log(subcommandHelp(ragCommandDef, version));
    return;
  }

  const url = String(parsed._[0] ?? "");
  if (!url) {
    throw new Error(
      "Usage: aai rag <url>\n\n" + "Provide the full URL to a site's llms-full.txt file",
    );
  }

  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const cwd = process.env.INIT_CWD || process.cwd();
  const config = await readProjectConfig(cwd);
  if (!config) {
    throw new Error("No .aai/project.json found — deploy first with `aai deploy`");
  }

  // Pre-resolve API key (may prompt) before Ink render
  const apiKey = await getApiKey();
  const serverUrl =
    parsed.server || config.serverUrl || (isDevMode() ? "http://localhost:3100" : DEFAULT_SERVER);
  const slug = config.slug;
  const chunkSize = Number.parseInt(parsed["chunk-size"] ?? "512", 10);

  let thrownError: Error | undefined;
  const app = render(
    <RagUI
      url={url}
      apiKey={apiKey}
      serverUrl={serverUrl}
      slug={slug}
      chunkSize={chunkSize}
      onError={(e) => {
        thrownError = e;
      }}
    />,
  );
  await app.waitUntilExit();
  if (thrownError) throw thrownError;
}

// ─── Page splitting ───────────────────────────────────────────────────────────

/** Split llms-full.txt on `***` page separators and extract titles. */
function splitPages(content: string): { title: string; body: string }[] {
  const raw = content.split(/^\*{3,}$/m);
  const pages: { title: string; body: string }[] = [];

  for (const section of raw) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    let title = "";
    let body = trimmed;

    // Format A: YAML frontmatter ending with a line of dashes
    const dashIndex = trimmed.search(/^-{3,}$/m);
    if (dashIndex !== -1) {
      const frontmatter = trimmed.slice(0, dashIndex);
      body = trimmed.slice(dashIndex).replace(/^-+$/m, "").trim();

      const titleMatch = frontmatter.match(/^title:\s*(.+)$/m);
      if (titleMatch) {
        title = titleMatch[1]!.trim();
      }
    }

    // Format B: title embedded as a heading (e.g. "## title: X")
    if (!title) {
      const titleLineMatch = body.match(/^#{1,2}\s+title:\s*(.+)$/m);
      if (titleLineMatch) {
        title = titleLineMatch[1]!.trim();
        body = body.replace(/^#{1,2}\s+title:\s*.+\n?/m, "").trim();
      } else {
        const headingMatch = body.match(/^(#{1,3})\s+(.+)$/m);
        if (headingMatch) {
          title = headingMatch[2]!.trim();
        }
      }
    }

    if (body.length > 0) {
      pages.push({ title, body });
    }
  }

  return pages;
}

/** Strip code blocks, HTML/JSX tags, and collapse whitespace from markdown. */
function stripNoise(text: string): string {
  return (
    text
      // Fenced code blocks (``` or ~~~)
      .replace(/^(`{3,}|~{3,}).*[\s\S]*?^\1/gm, "")
      // Indented code blocks (4+ spaces or tab at line start)
      .replace(/^(?:[ ]{4,}|\t).+$/gm, "")
      // Inline code
      .replace(/`[^`]+`/g, "")
      // JSX comments {/* ... */}
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      // HTML/JSX tags (including self-closing, attributes, and multiline)
      .replace(/<[^>]+>/g, "")
      // Leftover JSX expression fragments (e.g. } href="...")
      .replace(/^\s*\}[^}\n]*$/gm, "")
      // Lines that are only whitespace
      .replace(/^\s+$/gm, "")
      // Collapse multiple blank lines
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function slugify(s: string): string {
  return s
    .replace(/^https?:\/\//, "")
    .replace(/^#+\s*/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80);
}
