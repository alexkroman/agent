// Copyright 2025 the AAI authors. MIT license.
//
// Coding agent tools adapted from OpenCode (MIT license)
// https://github.com/sst/opencode

import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { Tool } from "ai";
import { z } from "zod";
import { MAX_LINE_LENGTH, MAX_OUTPUT_BYTES, MAX_READ_LINES } from "./constants.ts";

const execFileAsync = promisify(execFile);

const SKIP_DIRS = new Set(["node_modules", ".git", ".aai", "dist", "coverage"]);

function safePath(workDir: string, filePath: string): string | null {
  const abs = path.resolve(workDir, filePath);
  if (!abs.startsWith(workDir + path.sep) && abs !== workDir) return null;
  return abs;
}

function formatGrepOutput(workDir: string, stdout: string): string {
  if (!stdout.trim()) return "No matches found.";
  const byFile = new Map<string, string[]>();
  for (const line of stdout.trim().split("\n")) {
    const sep = line.indexOf(":");
    const sep2 = line.indexOf(":", sep + 1);
    if (sep === -1 || sep2 === -1) continue;
    const file = path.relative(workDir, line.slice(0, sep));
    const lineNum = line.slice(sep + 1, sep2);
    let text = line.slice(sep2 + 1);
    if (text.length > MAX_LINE_LENGTH) text = `${text.slice(0, MAX_LINE_LENGTH)}...`;
    const entries = byFile.get(file) ?? [];
    entries.push(`  Line ${lineNum}: ${text}`);
    byFile.set(file, entries);
  }
  const output: string[] = [];
  for (const [file, lines] of byFile) {
    output.push(`${file}:`);
    output.push(...lines);
  }
  return output.join("\n");
}

function formatExecError(err: unknown): string {
  if (err && typeof err === "object" && "stdout" in err) {
    const e = err as { stdout: string; stderr: string; code: number };
    return `Exit code ${e.code}\n${`${e.stdout}\n${e.stderr}`.trim()}`;
  }
  return `Error: ${errorMessage(err)}`;
}

function truncateOutput(output: string): string {
  if (!output) return "(no output)";
  if (output.length > MAX_OUTPUT_BYTES) {
    return `${output.slice(0, MAX_OUTPUT_BYTES)}\n...(truncated, ${output.length} bytes total)`;
  }
  return output;
}

function readFileWithLineNumbers(content: string, offset?: number, limit?: number): string {
  const allLines = content.split("\n");
  const startLine = Math.max(1, offset ?? 1);
  const maxLines = limit ?? MAX_READ_LINES;
  const endLine = Math.min(allLines.length, startLine + maxLines - 1);
  const lines = allLines.slice(startLine - 1, endLine);

  let output = "";
  let bytes = 0;
  let truncatedByBytes = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const text =
      raw.length > MAX_LINE_LENGTH ? `${raw.slice(0, MAX_LINE_LENGTH)}... (truncated)` : raw;
    const numbered = `${startLine + i}: ${text}\n`;
    if (bytes + numbered.length > MAX_OUTPUT_BYTES) {
      truncatedByBytes = true;
      break;
    }
    output += numbered;
    bytes += numbered.length;
  }

  const total = allLines.length;
  if (truncatedByBytes || endLine < total) {
    const shown = endLine - startLine + 1;
    output += `\n(Showing lines ${startLine}-${startLine + shown - 1} of ${total}. Use offset=${endLine + 1} to continue.)`;
  }
  return output;
}

function isRgNoMatch(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === 1);
}

function makeFileTools(workDir: string): Record<string, Tool> {
  return {
    read: {
      description:
        "Read a file or directory. Returns lines prefixed with line numbers (e.g. `1: content`). " +
        "Use offset/limit to paginate large files. Defaults to first 2000 lines. " +
        "For directories, returns a listing of entries. " +
        "Call this tool in parallel when reading multiple files.",
      inputSchema: z.object({
        filePath: z.string().describe("Path to the file or directory to read"),
        offset: z.number().optional().describe("Line number to start from (1-indexed)"),
        limit: z.number().optional().describe("Max number of lines to read (default 2000)"),
      }),
      execute: async (args) => {
        const { filePath, offset, limit } = args as {
          filePath: string;
          offset?: number;
          limit?: number;
        };
        const abs = safePath(workDir, filePath);
        if (!abs) return "Error: path outside working directory";

        let stat: Stats;
        try {
          stat = await fs.stat(abs);
        } catch {
          return `Error: file not found: ${filePath}`;
        }

        if (stat.isDirectory()) {
          const entries = await fs.readdir(abs, { withFileTypes: true });
          const lines = entries
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
          return lines.join("\n");
        }

        const content = await fs.readFile(abs, "utf-8");
        return readFileWithLineNumbers(content, offset, limit);
      },
    },

    edit: {
      description:
        "Performs exact string replacement in a file. You must read the file first before editing. " +
        "The edit will fail if oldString is not found or matches multiple locations (unless replaceAll is true). " +
        "Provide enough surrounding context in oldString to make the match unique. " +
        "Preserve exact indentation from the file.",
      inputSchema: z.object({
        filePath: z.string().describe("Path to the file to modify"),
        oldString: z.string().describe("The exact text to replace"),
        newString: z.string().describe("The replacement text (must be different from oldString)"),
        replaceAll: z
          .boolean()
          .optional()
          .describe("Replace all occurrences of oldString (default false)"),
      }),
      execute: async (args) => {
        const { filePath, oldString, newString, replaceAll } = args as {
          filePath: string;
          oldString: string;
          newString: string;
          replaceAll?: boolean;
        };
        if (oldString === newString) return "Error: oldString and newString are identical";
        const abs = safePath(workDir, filePath);
        if (!abs) return "Error: path outside working directory";

        let content: string;
        try {
          content = await fs.readFile(abs, "utf-8");
        } catch {
          return `Error: file not found: ${filePath}`;
        }

        if (!content.includes(oldString)) {
          return "Error: oldString not found in file. Make sure you are matching the exact text including whitespace and indentation.";
        }

        if (replaceAll) {
          await fs.writeFile(abs, content.replaceAll(oldString, newString));
          const count = content.split(oldString).length - 1;
          return `Replaced ${count} occurrence(s).`;
        }

        const first = content.indexOf(oldString);
        const second = content.indexOf(oldString, first + 1);
        if (second !== -1) {
          return "Error: found multiple matches for oldString. Provide more surrounding context to make it unique, or set replaceAll to true.";
        }

        await fs.writeFile(abs, content.replace(oldString, newString));
        return "OK";
      },
    },

    write: {
      description:
        "Write content to a file, creating it if it doesn't exist or overwriting if it does. " +
        "Always prefer editing existing files with the edit tool. " +
        "Only use write for new files or complete rewrites.",
      inputSchema: z.object({
        filePath: z.string().describe("Path to the file to write"),
        content: z.string().describe("The full file content to write"),
      }),
      execute: async (args) => {
        const { filePath, content } = args as { filePath: string; content: string };
        const abs = safePath(workDir, filePath);
        if (!abs) return "Error: path outside working directory";
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content);
        return `Wrote ${content.length} bytes to ${filePath}`;
      },
    },
  };
}

function makeSearchTools(workDir: string): Record<string, Tool> {
  return {
    glob: {
      description:
        "Fast file pattern matching. Supports glob patterns like '**/*.ts' or 'src/**/*.tsx'. " +
        "Returns matching file paths sorted by modification time (newest first). " +
        "Use this to find files by name or extension.",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern to match files against"),
        path: z.string().optional().describe("Directory to search in (defaults to project root)"),
      }),
      execute: async (args) => {
        const { pattern, path: searchPath } = args as {
          pattern: string;
          path?: string;
        };
        const dir = searchPath ? (safePath(workDir, searchPath) ?? workDir) : workDir;
        try {
          const { stdout } = await execFileAsync(
            "rg",
            ["--files", "--glob", pattern, "--sort=modified", dir],
            { maxBuffer: 1024 * 1024, timeout: 10_000 },
          );
          const files = stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .slice(0, 100)
            .map((f) => path.relative(workDir, f));
          if (files.length === 0) return "No files found matching pattern.";
          const truncated = files.length >= 100 ? "\n(Showing first 100 results.)" : "";
          return files.join("\n") + truncated;
        } catch (err) {
          if (isRgNoMatch(err)) {
            return "No files found matching pattern.";
          }
          return `Error running glob: ${errorMessage(err)}`;
        }
      },
    },

    grep: {
      description:
        "Fast content search using regex. Searches file contents and returns file paths with " +
        "line numbers and matching lines. Supports full regex syntax. " +
        "Use the include parameter to filter by file extension (e.g. '*.ts').",
      inputSchema: z.object({
        pattern: z.string().describe("Regex pattern to search for"),
        path: z.string().optional().describe("Directory to search in (defaults to project root)"),
        include: z
          .string()
          .optional()
          .describe('File pattern to include (e.g. "*.ts", "*.{ts,tsx}")'),
      }),
      execute: async (args) => {
        const {
          pattern,
          path: searchPath,
          include,
        } = args as {
          pattern: string;
          path?: string;
          include?: string;
        };
        const dir = searchPath ? (safePath(workDir, searchPath) ?? workDir) : workDir;
        const rgArgs = [
          "-nH",
          "--hidden",
          "--no-messages",
          "--max-count=100",
          ...(include ? ["--glob", include] : []),
          "--regexp",
          pattern,
          dir,
        ];
        try {
          const { stdout } = await execFileAsync("rg", rgArgs, {
            maxBuffer: 1024 * 1024,
            timeout: 10_000,
          });
          return formatGrepOutput(workDir, stdout);
        } catch (err) {
          if (isRgNoMatch(err)) {
            return "No matches found.";
          }
          return `Error running grep: ${errorMessage(err)}`;
        }
      },
    },

    bash: {
      description:
        "Execute a shell command. Use for git, npm, and other terminal operations. " +
        "Do NOT use for file reading/writing/searching — use the dedicated tools instead. " +
        "Commands run in the project directory by default.",
      inputSchema: z.object({
        command: z.string().describe("The shell command to execute"),
        description: z
          .string()
          .describe("Brief description of what this command does (5-10 words)"),
        timeout: z.number().optional().describe("Timeout in milliseconds (default 120000)"),
      }),
      execute: async (args) => {
        const { command, timeout } = args as {
          command: string;
          description: string;
          timeout?: number;
        };
        try {
          const { stdout, stderr } = await execFileAsync(
            process.env.SHELL ?? "bash",
            ["-c", command],
            {
              cwd: workDir,
              maxBuffer: 1024 * 1024,
              timeout: timeout ?? 120_000,
              env: process.env,
            },
          );
          const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
          return truncateOutput(output);
        } catch (err) {
          return formatExecError(err);
        }
      },
    },

    ls: {
      description:
        "List files and directories in a path. Returns entries with '/' suffix for directories. " +
        "Prefer glob or grep if you know what you're looking for.",
      inputSchema: z.object({
        path: z.string().optional().describe("Directory path (defaults to project root)"),
      }),
      execute: async (args) => {
        const { path: dirPath } = args as { path?: string };
        const abs = dirPath ? (safePath(workDir, dirPath) ?? workDir) : workDir;
        try {
          const entries = await fs.readdir(abs, { withFileTypes: true });
          return entries
            .filter((e) => !SKIP_DIRS.has(e.name))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .join("\n");
        } catch {
          return `Error: directory not found: ${dirPath ?? "."}`;
        }
      },
    },
  };
}

export function makeTools(workDir: string): Record<string, Tool> {
  return { ...makeFileTools(workDir), ...makeSearchTools(workDir) };
}
