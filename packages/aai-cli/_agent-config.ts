// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Read agent.json from an agent directory and resolve $ref fields.
 * Shared by the bundler (production builds) and dev server.
 */
export async function resolveAgentConfig(cwd: string): Promise<Record<string, unknown>> {
  const agentJsonPath = path.join(cwd, "agent.json");
  let agentConfig: Record<string, unknown>;
  try {
    agentConfig = JSON.parse(await fs.readFile(agentJsonPath, "utf-8"));
  } catch (err) {
    throw new Error(`Missing agent.json in ${cwd}`, { cause: err });
  }

  if (!agentConfig.name || typeof agentConfig.name !== "string") {
    throw new Error("agent.json must have a name field");
  }

  // Resolve $ref in systemPrompt (e.g. { "$ref": "system-prompt.md" })
  if (agentConfig.systemPrompt && typeof agentConfig.systemPrompt === "object") {
    const ref = (agentConfig.systemPrompt as { $ref?: string }).$ref;
    if (ref) {
      agentConfig.systemPrompt = await fs.readFile(path.join(cwd, ref), "utf-8");
    }
  }

  return agentConfig;
}
