// Copyright 2025 the AAI authors. MIT license.

import { errorMessage } from "@alexkroman1/aai/utils";
import pLimit from "p-limit";
import { getServerInfo } from "./_discover.ts";
import { detail, info, runCommand, step, warn } from "./_ui.ts";

const FETCH_TIMEOUT_MS = 60_000;

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
  log: (msg: string) => void;
  setStatus: (msg: string | null) => void;
}) {
  const { url, apiKey, serverUrl, slug, chunkSize, log, setStatus } = opts;

  // Fetch
  log(step("Fetch", url));
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
    log(warn("File is empty"));
    return;
  }
  log(info(`${(content.length / 1024).toFixed(0)} KB`));

  // Split into pages, then chunk each page
  const origin = new URL(url).origin;
  const pages = splitPages(content);
  log(step("Parse", `${pages.length} pages`));

  const { RecursiveChunker } = await import("@chonkiejs/core");
  const chunker = await RecursiveChunker.create({ chunkSize });

  const siteSlug = slugify(origin);
  const allChunks = await chunkPages(pages, chunker, origin, siteSlug);

  log(step("Chunk", `${allChunks.length} chunks`));

  // Upsert (concurrent with pool)
  const vectorUrl = `${serverUrl}/${slug}/vector`;
  log(info(`target: ${vectorUrl}`));

  const result = await upsertChunks(allChunks, vectorUrl, apiKey, setStatus);

  log(step("Done", `${result.upserted} chunks upserted`));
  if (result.errors > 0) {
    log(warn(`${result.errors} failed`));
    if (result.lastError) log(info(`last error: ${result.lastError}`));
  }
  log(detail(`Agent: ${slug}`));
}

export async function chunkPages(
  pages: { title: string; body: string }[],
  chunker: { chunk: (text: string) => Promise<{ text: string; tokenCount: number }[]> },
  origin: string,
  siteSlug: string,
): Promise<VectorChunk[]> {
  const allChunks: VectorChunk[] = [];
  for (const page of pages) {
    page.body = stripNoise(page.body);
    if (!page.body) continue;
    const raw = await chunker.chunk(page.body);
    for (const [i, c] of raw.entries()) {
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
  return allChunks;
}

export async function upsertChunks(
  chunks: VectorChunk[],
  vectorUrl: string,
  apiKey: string,
  setStatus: (msg: string | null) => void,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ upserted: number; errors: number; lastError: string }> {
  const total = chunks.length;
  let completed = 0;
  let upserted = 0;
  let errors = 0;
  let lastError = "";

  const updateStatus = () => {
    const pct = Math.round((completed / total) * 100);
    setStatus(`   Upsert ${completed}/${total} (${pct}%)`);
  };
  updateStatus();

  const limit = pLimit(5);
  await Promise.all(
    chunks.map((chunk) =>
      limit(async () => {
        try {
          const r = await fetchFn(vectorUrl, {
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
          lastError = errorMessage(err);
          errors++;
        }
        completed++;
        updateStatus();
      }),
    ),
  );

  setStatus(null);
  return { upserted, errors, lastError };
}

export async function runRagCommand(opts: {
  url: string;
  cwd: string;
  server?: string;
  chunkSize?: string;
}): Promise<void> {
  const { url, cwd } = opts;

  try {
    new URL(url);
  } catch {
    throw new Error(
      `Invalid URL: ${url}\n  Provide a fully qualified URL including the protocol (e.g., https://example.com/docs).`,
    );
  }

  const { apiKey, serverUrl, slug } = await getServerInfo(cwd, opts.server);
  const chunkSize = Number.parseInt(opts.chunkSize ?? "512", 10);

  await runCommand(async ({ log, setStatus }) => {
    await runRag({ url, apiKey, serverUrl, slug, chunkSize, log, setStatus });
  });
}

// --- Page splitting ---

/** Split llms-full.txt on `***` page separators and extract titles. */
export function splitPages(content: string): { title: string; body: string }[] {
  const raw = content.split(/^\*{3,}$/m);
  const pages: { title: string; body: string }[] = [];

  for (const section of raw) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    const page = parsePage(trimmed);
    if (page.body.length > 0) {
      pages.push(page);
    }
  }

  return pages;
}

/** Extract title and body from a single page section. */
export function parsePage(trimmed: string): { title: string; body: string } {
  let title = "";
  let body = trimmed;

  // Format A: YAML frontmatter ending with a line of dashes
  const dashIndex = trimmed.search(/^-{3,}$/m);
  if (dashIndex !== -1) {
    const frontmatter = trimmed.slice(0, dashIndex);
    body = trimmed.slice(dashIndex).replace(/^-+$/m, "").trim();

    const titleMatch = frontmatter.match(/^title:\s*(.+)$/m);
    if (titleMatch) {
      title = titleMatch[1]?.trim() ?? "";
    }
  }

  // Format B: title embedded as a heading (e.g. "## title: X")
  if (!title) {
    const titleLineMatch = body.match(/^#{1,2}\s+title:\s*(.+)$/m);
    if (titleLineMatch) {
      title = titleLineMatch[1]?.trim() ?? "";
      body = body.replace(/^#{1,2}\s+title:\s*.+\n?/m, "").trim();
    } else {
      const headingMatch = body.match(/^(#{1,3})\s+(.+)$/m);
      if (headingMatch) {
        title = headingMatch[2]?.trim() ?? "";
      }
    }
  }

  return { title, body };
}

/** Strip code blocks, HTML/JSX tags, and collapse whitespace from markdown. */
export function stripNoise(text: string): string {
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

export function slugify(s: string): string {
  return s
    .replace(/^https?:\/\//, "")
    .replace(/^#+\s*/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80);
}
