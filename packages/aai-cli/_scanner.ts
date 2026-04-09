// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent directory scanner.
 *
 * Reads an agent directory (agent.json + tools/*.ts + hooks/*.ts) and
 * produces a validated Manifest object via parseManifest().
 */

import fs from "node:fs/promises";
import path from "node:path";
import { type HookFlags, type Manifest, parseManifest } from "@alexkroman1/aai/isolate";

// Hook filenames (kebab-case) → HookFlags keys (camelCase)
const HOOK_FILENAME_MAP: Record<string, keyof HookFlags> = {
  "on-connect": "onConnect",
  "on-disconnect": "onDisconnect",
  "on-user-transcript": "onUserTranscript",
  "on-error": "onError",
};

/**
 * Extract the value of `export const <name> = <literal>` from TypeScript source.
 *
 * Only handles string literals and JSON-compatible object/array literals.
 * Returns `undefined` if the export is not found.
 */
export function extractConstExport(source: string, exportName: string): unknown {
  // Match: export const <name> = <value>
  const pattern = new RegExp(`export\\s+const\\s+${exportName}\\s*(?::\\s*[^=]+)?=\\s*`);
  const match = pattern.exec(source);
  if (!match) return;

  const afterEquals = source.slice(match.index + match[0].length);

  // String literal: "..." or '...'
  const strMatch = afterEquals.match(/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
  if (strMatch?.[1]) {
    const raw = strMatch[1];
    // Normalize single-quoted strings to double-quoted for JSON.parse
    if (raw.startsWith("'")) {
      return JSON.parse(`"${raw.slice(1, -1).replace(/"/g, '\\"')}"`);
    }
    return JSON.parse(raw);
  }

  // Object or array literal
  if (afterEquals[0] === "{" || afterEquals[0] === "[") {
    const jsLiteral = extractBalanced(afterEquals);
    return JSON.parse(jsObjectToJson(jsLiteral));
  }
}

// Bracket pairs for balanced extraction
const OPENERS = new Set(["{", "["]);
const CLOSERS: Record<string, string> = { "{": "}", "[": "]" };
const STRING_DELIMITERS = new Set(['"', "'", "`"]);

const ALL_CLOSERS = new Set(Object.values(CLOSERS));

/**
 * Extract a balanced `{...}` or `[...]` expression from the start of `str`.
 */
function extractBalanced(str: string): string {
  let depth = 0;
  let inStr: string | null = null;

  for (let i = 0; i < str.length; i++) {
    const ch = str.charAt(i);

    if (inStr) {
      [i, inStr] = advanceInsideString(str, i, ch, inStr);
      continue;
    }

    if (STRING_DELIMITERS.has(ch)) {
      inStr = ch;
      continue;
    }

    depth += depthDelta(ch);
    if (depth === 0) return str.slice(0, i + 1);
  }

  return str; // fallback: return what we have
}

/** Return +1 for openers, -1 for closers, 0 otherwise. */
function depthDelta(ch: string): number {
  if (OPENERS.has(ch)) return 1;
  if (ALL_CLOSERS.has(ch)) return -1;
  return 0;
}

/** Advance the cursor inside a string literal; returns [newIndex, newInStr]. */
function advanceInsideString(
  str: string,
  i: number,
  ch: string,
  inStr: string,
): [number, string | null] {
  if (ch === "\\" && i + 1 < str.length) return [i + 1, inStr]; // skip escaped
  if (ch === inStr) return [i, null]; // closing quote
  return [i, inStr];
}

/**
 * Convert a JS object literal to valid JSON:
 * - Quote unquoted keys
 * - Remove trailing commas
 * - Convert single-quoted strings to double-quoted
 */
function jsObjectToJson(js: string): string {
  let result = "";
  let i = 0;
  let inStr: string | null = null;

  while (i < js.length) {
    const ch = js.charAt(i);

    if (inStr) {
      [result, i, inStr] = processStringChar(js, result, i, ch, inStr);
      continue;
    }

    [result, i, inStr] = processOutsideString(js, result, i, ch);
  }

  return result;
}

/** Process a character while inside a string literal. */
function processStringChar(
  js: string,
  result: string,
  i: number,
  ch: string,
  inStr: string,
): [string, number, string | null] {
  // Escaped character
  if (ch === "\\" && i + 1 < js.length) {
    return [result + ch + js[i + 1], i + 2, inStr];
  }
  // Closing quote
  if (ch === inStr) {
    return [result + (inStr === "'" ? '"' : ch), i + 1, null];
  }
  // Escape double quotes inside single-quoted strings
  if (inStr === "'" && ch === '"') {
    return [`${result}\\"`, i + 1, inStr];
  }
  return [`${result}${ch}`, i + 1, inStr];
}

/** Process a character while outside any string literal. */
function processOutsideString(
  js: string,
  result: string,
  i: number,
  ch: string,
): [string, number, string | null] {
  if (ch === '"') return [`${result}${ch}`, i + 1, '"'];
  if (ch === "'") return [`${result}"`, i + 1, "'"]; // single→double

  // Remove trailing commas before } or ]
  if (ch === "," && isTrailingComma(js, i)) {
    return [result, i + 1, null];
  }

  // Unquoted key detection: identifier followed by `:`
  if (isUnquotedKeyStart(js, i)) {
    const keyEnd = js.indexOf(":", i);
    const key = js.slice(i, keyEnd).trim();
    return [`${result}"${key}"`, keyEnd, null];
  }

  return [result + ch, i + 1, null];
}

/**
 * Check if the comma at position `i` is a trailing comma (followed only by
 * whitespace and then `}` or `]`).
 */
function isTrailingComma(str: string, i: number): boolean {
  for (let j = i + 1; j < str.length; j++) {
    const ch = str.charAt(j);
    if (/\s/.test(ch)) continue;
    return ch === "}" || ch === "]";
  }
  return false;
}

/**
 * Check if position `i` is the start of an unquoted object key.
 * Must be preceded by `{`, `,`, or `[` (after whitespace),
 * and be an identifier followed by `:`.
 */
function isUnquotedKeyStart(str: string, i: number): boolean {
  if (!/[a-zA-Z_$]/.test(str.charAt(i))) return false;

  const prev = findPrevNonWhitespace(str, i);
  if (prev !== "{" && prev !== "," && prev !== "[") return false;

  return hasColonAfterIdentifier(str, i);
}

/** Find the first non-whitespace character before position `i`. */
function findPrevNonWhitespace(str: string, i: number): string {
  for (let j = i - 1; j >= 0; j--) {
    const ch = str.charAt(j);
    if (!/\s/.test(ch)) return ch;
  }
  return "";
}

/** Check if an identifier starting at `i` is followed by `:`. */
function hasColonAfterIdentifier(str: string, i: number): boolean {
  let j = i;
  while (j < str.length && /[a-zA-Z0-9_$]/.test(str.charAt(j))) j++;
  while (j < str.length && /\s/.test(str.charAt(j))) j++;
  return j < str.length && str.charAt(j) === ":";
}

/** Check if an ENOENT error (directory does not exist). */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Scan an agent directory and produce a validated Manifest.
 *
 * Reads `agent.json`, resolves `$ref` in systemPrompt, scans `tools/*.ts`
 * and `hooks/*.ts`, then validates through `parseManifest()`.
 */
export async function scanAgentDirectory(dir: string): Promise<Manifest> {
  const agentJson = await readAgentJson(dir);
  await resolveSystemPromptRef(dir, agentJson);
  const tools = await scanTools(dir);
  const hooks = await scanHooks(dir);

  return parseManifest({ ...agentJson, tools, hooks });
}

/** Read and parse agent.json from the given directory. */
async function readAgentJson(dir: string): Promise<Record<string, unknown>> {
  const agentJsonPath = path.join(dir, "agent.json");
  let raw: string;
  try {
    raw = await fs.readFile(agentJsonPath, "utf-8");
  } catch (cause: unknown) {
    // biome-ignore lint/nursery/useErrorCause: cause is passed in the options object
    throw new Error(`Missing agent.json in ${dir}`, { cause });
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

/** If systemPrompt is a `{ $ref: "..." }` object, replace it with file contents. */
async function resolveSystemPromptRef(
  dir: string,
  agentJson: Record<string, unknown>,
): Promise<void> {
  if (!agentJson.systemPrompt || typeof agentJson.systemPrompt !== "object") return;
  const ref = agentJson.systemPrompt as { $ref?: string };
  if (ref.$ref) {
    agentJson.systemPrompt = await fs.readFile(path.join(dir, ref.$ref), "utf-8");
  }
}

/** Scan tools/*.ts and extract description + optional parameters from each. */
async function scanTools(
  dir: string,
): Promise<Record<string, { description: string; parameters?: Record<string, unknown> }>> {
  const tools: Record<string, { description: string; parameters?: Record<string, unknown> }> = {};
  const toolsDir = path.join(dir, "tools");

  let toolFiles: string[];
  try {
    toolFiles = await fs.readdir(toolsDir);
  } catch (err) {
    if (isEnoent(err)) return tools;
    throw err;
  }

  for (const file of toolFiles) {
    if (!file.endsWith(".ts")) continue;
    const toolName = file.replace(/\.ts$/, "");
    const source = await fs.readFile(path.join(toolsDir, file), "utf-8");

    const description = extractConstExport(source, "description");
    if (typeof description !== "string") {
      throw new Error(`Tool "${toolName}" (tools/${file}) must export a string "description"`);
    }

    const parameters = extractConstExport(source, "parameters");
    tools[toolName] = {
      description,
      ...(parameters !== undefined ? { parameters: parameters as Record<string, unknown> } : {}),
    };
  }

  return tools;
}

/** Scan hooks/*.ts and set flags for which hooks exist. */
async function scanHooks(dir: string): Promise<HookFlags> {
  const hooks: HookFlags = {
    onConnect: false,
    onDisconnect: false,
    onUserTranscript: false,
    onError: false,
  };
  const hooksDir = path.join(dir, "hooks");

  let hookFiles: string[];
  try {
    hookFiles = await fs.readdir(hooksDir);
  } catch (err) {
    if (isEnoent(err)) return hooks;
    throw err;
  }

  for (const file of hookFiles) {
    if (!file.endsWith(".ts")) continue;
    const baseName = file.replace(/\.ts$/, "");
    const hookKey = HOOK_FILENAME_MAP[baseName];
    if (hookKey) {
      hooks[hookKey] = true;
    }
  }

  return hooks;
}
