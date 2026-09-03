// Copyright 2025 the AAI authors. MIT license.
/**
 * The `run_code` builtin.
 *
 * run_code executes untrusted JavaScript and is ONLY ever run inside the
 * guest sandbox: the platform's guest harness passes its in-sandbox executor
 * as `RuntimeOptions.runCode`, and the Modal container is the security
 * boundary. The executor runs code with the same authority as the rest of
 * the sandboxed agent (open egress, filesystem, env) — nothing more; an
 * escape lands in a container that is already confined. Without an executor
 * — the self-hosted path (`aai dev`), which has no sandbox — this refuses
 * rather than evaluating attacker-influenceable code in the host process.
 */

import { z } from "zod";
import type { ToolDef } from "../sdk/types.ts";

/** In-sandbox executor backing the run_code builtin (see createRunCode). */
export type RunCodeExecutor = (code: string) => Promise<string | { error: string }>;

const runCodeParams = z.object({
  code: z.string().describe("JavaScript code to execute. Use console.log() for output."),
});

export function createRunCode(
  runCode?: RunCodeExecutor,
): ToolDef<typeof runCodeParams> & { guidance: string } {
  return {
    guidance:
      "You MUST use the run_code tool for ANY question involving math, counting, calculations, " +
      "data processing, or code. NEVER do mental math or recite code verbally. " +
      "run_code executes JavaScript (not Python). Always write JavaScript.",
    description:
      "Execute JavaScript code in a sandbox and return the output. Use this for calculations, data transformations, string manipulation, or any task that benefits from running code. Output is captured from console.log().",
    inputSchema: runCodeParams,
    async execute({ code }) {
      if (!runCode) {
        return {
          error:
            "run_code is only available in the sandboxed runtime and cannot run in this environment.",
        };
      }
      return await runCode(code);
    },
  };
}
