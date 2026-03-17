import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { extractStaticConfig } from "./_static_config.ts";

describe("extractStaticConfig", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-static-config-test-"));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeAgent(filename: string, content: string): Promise<string> {
    const filePath = path.join(tmpDir, filename);
    await fs.writeFile(filePath, content, "utf-8");
    return filePath;
  }

  test("extracts name from minimal defineAgent call", async () => {
    const agentPath = await writeAgent(
      "agent_minimal.ts",
      `
import { defineAgent } from "aai";
export default defineAgent({ name: "Test" });
`,
    );
    const result = await extractStaticConfig(agentPath);
    expect(result.config.name).toBe("Test");
  });

  test("extracts instructions and greeting", async () => {
    const agentPath = await writeAgent(
      "agent_instructions.ts",
      `
import { defineAgent } from "aai";
export default defineAgent({
  name: "Greeter",
  instructions: "You are helpful.",
  greeting: "Hello there!",
});
`,
    );
    const result = await extractStaticConfig(agentPath);
    expect(result.config.instructions).toBe("You are helpful.");
    expect(result.config.greeting).toBe("Hello there!");
  });

  test("extracts voice", async () => {
    const agentPath = await writeAgent(
      "agent_voice.ts",
      `
import { defineAgent } from "aai";
export default defineAgent({
  name: "Speaker",
  voice: "luna",
});
`,
    );
    const result = await extractStaticConfig(agentPath);
    expect(result.config.voice).toBe("luna");
  });

  test("extracts builtinTools array", async () => {
    const agentPath = await writeAgent(
      "agent_builtin.ts",
      `
import { defineAgent } from "aai";
export default defineAgent({
  name: "Tooler",
  builtinTools: ["web_search", "visit_webpage"],
});
`,
    );
    const result = await extractStaticConfig(agentPath);
    expect(result.config.builtinTools).toEqual(["web_search", "visit_webpage"]);
  });

  test("extracts maxSteps number", async () => {
    const agentPath = await writeAgent(
      "agent_maxsteps.ts",
      `
import { defineAgent } from "aai";
export default defineAgent({
  name: "Stepper",
  maxSteps: 3,
});
`,
    );
    const result = await extractStaticConfig(agentPath);
    expect(result.config.maxSteps).toBe(3);
  });

  test("extracts transport as string", async () => {
    const agentPath = await writeAgent(
      "agent_transport_str.ts",
      `
import { defineAgent } from "aai";
export default defineAgent({
  name: "Transporter",
  transport: "websocket",
});
`,
    );
    const result = await extractStaticConfig(agentPath);
    expect(result.config.transport).toEqual(["websocket"]);
  });

  test("extracts transport as array", async () => {
    const agentPath = await writeAgent(
      "agent_transport_arr.ts",
      `
import { defineAgent } from "aai";
export default defineAgent({
  name: "Transporter",
  transport: ["websocket"],
});
`,
    );
    const result = await extractStaticConfig(agentPath);
    expect(result.config.transport).toEqual(["websocket"]);
  });

  test("extracts tool schemas with description and parameters", async () => {
    const agentPath = await writeAgent(
      "agent_tools.ts",
      `
import { defineAgent } from "aai";
import { z } from "zod";
export default defineAgent({
  name: "ToolAgent",
  tools: {
    get_weather: {
      description: "Get the weather",
      parameters: z.object({
        city: z.string(),
      }),
      execute: async ({ city }) => city,
    },
  },
});
`,
    );
    const result = await extractStaticConfig(agentPath);
    expect(result.toolSchemas).toHaveLength(1);
    expect(result.toolSchemas[0].name).toBe("get_weather");
    expect(result.toolSchemas[0].description).toBe("Get the weather");
    expect(result.toolSchemas[0].parameters).toEqual({
      type: "object",
      properties: {
        city: { type: "string" },
      },
      required: ["city"],
      additionalProperties: false,
    });
  });

  test("throws BundleError when defineAgent call is missing", async () => {
    const agentPath = await writeAgent(
      "agent_missing.ts",
      `
const x = 42;
export default x;
`,
    );
    await expect(extractStaticConfig(agentPath)).rejects.toThrow("Could not find a defineAgent");
  });

  test("extracts sttPrompt", async () => {
    const agentPath = await writeAgent(
      "agent_sttprompt.ts",
      `
import { defineAgent } from "aai";
export default defineAgent({
  name: "Prompter",
  sttPrompt: "Speak clearly",
});
`,
    );
    const result = await extractStaticConfig(agentPath);
    expect(result.config.sttPrompt).toBe("Speak clearly");
  });

  test("extracts toolChoice", async () => {
    const agentPath = await writeAgent(
      "agent_toolchoice.ts",
      `
import { defineAgent } from "aai";
export default defineAgent({
  name: "Chooser",
  toolChoice: "auto",
});
`,
    );
    const result = await extractStaticConfig(agentPath);
    expect(result.config.toolChoice).toBe("auto");
  });
});
