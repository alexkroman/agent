import { query } from "@anthropic-ai/claude-agent-sdk";

const SYSTEM_PROMPT = `You are generating a voice agent using the AAI framework.

The project has already been scaffolded with \`aai init\`. Your job is to modify agent.ts to match the user's request.

Key rules:
- agent.ts must export a default defineAgent() call
- Import from "@alexkroman1/aai"
- Optimize the \`instructions\` field for spoken conversation (short sentences, no visual formatting, no markdown)
- Available builtinTools: "web_search", "visit_webpage", "fetch_json", "run_code", "vector_search", "memory"
- You can define custom tools with the \`tools\` field using Zod schemas
- Available defineAgent options: name, instructions, greeting, tools, builtinTools, maxSteps, state, sttPrompt
- Access secrets via ctx.env in tool execute functions
- Only modify agent.ts (and optionally client.tsx for custom UI)
- Do NOT create extra files or install packages`;

export async function generateCode(opts: {
  prompt: string;
  workDir: string;
  sessionId?: string;
}): Promise<{ sessionId: string }> {
  let capturedSessionId = opts.sessionId ?? "";

  const options: Parameters<typeof query>[0]["options"] = {
    cwd: opts.workDir,
    allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    systemPrompt: SYSTEM_PROMPT,
    maxTurns: 20,
  };

  if (opts.sessionId) {
    (options as Record<string, unknown>).resume = opts.sessionId;
  }

  for await (const message of query({ prompt: opts.prompt, options })) {
    if (
      "type" in message &&
      message.type === "system" &&
      "subtype" in message &&
      message.subtype === "init" &&
      "session_id" in message
    ) {
      capturedSessionId = message.session_id as string;
    }
  }

  if (!capturedSessionId) {
    throw new Error("Claude Agent SDK did not return a session ID");
  }

  return { sessionId: capturedSessionId };
}
