// Copyright 2026 the AAI authors. MIT license.
/**
 * `read_logs` — the coding agent reading what the agent it is BUILDING printed.
 *
 * Every other tool here looks at source: the workspace, a type check, a build,
 * a bundle loaded in this sandbox. None of them can see the one thing that only
 * happens with a real caller on the line — a tool that throws mid-call, a
 * provider key the deployed agent does not have, the `console.error` on the
 * branch nobody exercised. Until this tool the evidence existed (the studio's
 * Logs pane shows it) and the agent's only route to it was asking the user to
 * read it out.
 *
 * ## It is a host RPC, not a fetch
 *
 * The logs belong to a DIFFERENT sandbox — the project's deployed preview or
 * production agent — and this guest knows neither its slug (stamped on the
 * workspace, after a deploy this sandbox does not perform) nor the platform
 * origin. Both live on the host, which resolves them from the (scope, project)
 * this sandbox is pinned to; the guest names an ENVIRONMENT and nothing else.
 * See `aai-studio-server/studio-agent-logs.ts` for what that buys.
 *
 * ## The tool is deliberately not a tail
 *
 * No cursor, no follow: a model does not poll, it asks a question and reads an
 * answer. So a call is always "the last N lines", and the host does the ring
 * paging that turns a cursor-indexed buffer into that.
 */

import { errorMessage, type ToolDef, tool } from "@alexkroman1/aai";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { hostRequest } from "./harness-rpc.ts";
import { LOGS_TOOL_MAX_LINES, STUDIO_TOOL_DESCRIPTIONS } from "./studio-tool-descriptions.ts";

/**
 * Deadline for the log RPC.
 *
 * The host drains up to five pages out of the deployed guest's ring, each with
 * its own 10s budget, so the worst honest case is well under this — and the
 * tool's own 120s executor timeout is the ceiling either way. Shorter than the
 * sync RPCs because nothing is lost by giving up on a diagnostic read.
 */
const LOGS_RPC_TIMEOUT_MS = 60_000;

/** One captured line, as the host hands it over. */
type LogLine = { seq: number; at: number; stream: "stdout" | "stderr"; text: string };

type LogsResult = {
  slug?: string;
  running: boolean;
  lines: LogLine[];
  dropped: number;
  total: number;
};

/** The environments a project deploys, as the tool names them. */
const ENVIRONMENTS = ["preview", "production"] as const;

function isLogLine(value: unknown): value is LogLine {
  return (
    isRecord(value) &&
    typeof value.at === "number" &&
    typeof value.text === "string" &&
    (value.stream === "stdout" || value.stream === "stderr")
  );
}

/**
 * Read the host's answer defensively — it crossed a JSON-RPC channel, and a
 * shape that does not parse must read as "no logs", never as a thrown tool.
 */
function parseResult(value: unknown): LogsResult | null {
  if (!(isRecord(value) && Array.isArray(value.lines))) return null;
  const lines = value.lines.filter(isLogLine);
  return {
    ...(typeof value.slug === "string" ? { slug: value.slug } : {}),
    running: value.running === true,
    lines,
    dropped: typeof value.dropped === "number" ? value.dropped : 0,
    total: typeof value.total === "number" ? value.total : lines.length,
  };
}

/** `HH:MM:SS.mmm` — the same shape the Logs pane and `aai logs` print. */
function formatTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** `stderr` is called out by name — it is usually the half worth reading. */
function formatLine(line: LogLine): string {
  return `${formatTime(line.at)}${line.stream === "stderr" ? " ERR" : "    "}  ${line.text}`;
}

/**
 * What to say when there is nothing to read, which is three different states
 * with three different next moves — and the reason `running` is on the wire at
 * all. "Deployed and silent" wants a session driven; "not running" wants one
 * started; "never deployed" wants an edit (preview) or the user (production).
 */
function emptyReport(environment: string, result: LogsResult): string {
  if (!result.slug) {
    return environment === "production"
      ? "This project has never been published, so there is no production agent to read. Its preview agent is what your edits deploy to — read that instead."
      : "No preview agent has been deployed yet. A preview deploys after a turn that changes files, so make an edit and try again in a moment.";
  }
  if (!result.running) {
    return `${result.slug} is not running, so its log is empty — the buffer lives in the agent's sandbox and goes when it does. Ask the user to open the ${environment} agent and talk to it, then read again.`;
  }
  return `${result.slug} is running and has printed nothing since its sandbox started. Ask the user to exercise the part you are debugging, or add console.log lines and wait for the next preview deploy.`;
}

/** Build the coding agent's log-reading tool. */
export function createLogsTool(): Record<string, ToolDef> {
  return {
    read_logs: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.read_logs,
      inputSchema: z.object({
        environment: z
          .enum(ENVIRONMENTS)
          .optional()
          .describe("Which of the project's agents to read (default preview)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(LOGS_TOOL_MAX_LINES)
          .optional()
          .describe(`Most recent lines to return (default 100, max ${LOGS_TOOL_MAX_LINES})`),
      }),
      execute: async ({ environment = "preview", limit }) => {
        let raw: unknown;
        try {
          raw = await hostRequest(
            "studio/agent-logs",
            omitUndefined({ environment, limit }),
            LOGS_RPC_TIMEOUT_MS,
          );
        } catch (err) {
          return `Error: could not read the ${environment} agent's logs: ${errorMessage(err)}`;
        }
        const result = parseResult(raw);
        if (!result) return "Error: the platform returned an unreadable log page.";
        if (result.lines.length === 0) return emptyReport(environment, result);

        const header = `${result.slug} (${environment}) — ${result.running ? "running" : "not running"}, showing the last ${result.lines.length} of ${result.total} line(s) held`;
        const gap =
          result.dropped > 0
            ? `\n(${result.dropped} earlier line(s) fell out of the agent's buffer)`
            : "";
        return `${header}${gap}\n\n${result.lines.map(formatLine).join("\n")}`;
      },
    }),
  };
}
