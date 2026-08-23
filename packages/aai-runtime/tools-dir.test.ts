// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for directory tool discovery.
 *
 * The claim under test is not "a registry was built" but "the model was offered
 * the tool and the runtime ran it", so the last spec drives a real text session
 * against a scripted model: nothing between `tool-dirs/ok/tools/roll_die.ts`
 * existing and a tool result reaching the next request is stubbed.
 *
 * The error specs go through `withToolsDir` rather than `toolRegistry` on
 * purpose. Their messages belong to the registry and this adds a third source
 * of paths to feed it — a scan whose keys are shaped wrong reaches the right
 * diagnostic for the wrong reason, or the wrong diagnostic entirely, and
 * neither is visible from the registry's own specs.
 */

import { agent } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { createFakeLanguageModel } from "./_fake-llm.ts";
import { silentLogger } from "./_test-utils.ts";
import { createTextAgent } from "./text-agent.ts";
import { withToolsDir } from "./tools-dir.ts";

/** As much of the model's prompt as the last spec reads a tool result out of. */
type PromptPart = { type: string; toolName?: string; output?: { value?: unknown } };
type PromptMessage = { content?: unknown };

const partsOf = (message: PromptMessage): PromptPart[] =>
  Array.isArray(message.content) ? (message.content as PromptPart[]) : [];

/**
 * A fixture project's `tools/`, addressed the way a self-hosted `server.mjs`
 * does. One directory per case, each really NAMED `tools/`, because that is
 * what a project looks like and what the diagnostics talk about.
 */
const toolsDir = (project: string): URL =>
  new URL(`./fixtures/tool-dirs/${project}/tools/`, import.meta.url);

const chatAgent = () => agent({ name: "Roller", text: true });

describe("withToolsDir", () => {
  test("registers a tools/ file under the name the file declares", async () => {
    const served = await withToolsDir(chatAgent(), toolsDir("ok"));

    expect(Object.keys(served.tools)).toEqual(["roll_die"]);
    expect(served.tools.roll_die?.description).toBe(
      "Roll a single die with the given number of sides.",
    );
  });

  test("takes the directory as a path as well as a URL", async () => {
    const served = await withToolsDir(chatAgent(), new URL(toolsDir("ok")).pathname);

    expect(Object.keys(served.tools)).toEqual(["roll_die"]);
  });

  test("leaves the definition it was given alone", async () => {
    const def = chatAgent();
    const served = await withToolsDir(def, toolsDir("ok"));

    expect(def.tools).toEqual({});
    expect(served).not.toBe(def);
  });

  test("names the directory when there is none, rather than finding no tools", async () => {
    await expect(withToolsDir(chatAgent(), toolsDir("absent"))).rejects.toThrow(
      /No tools directory at .*absent\/tools/,
    );
  });

  test("rejects a file name no provider would accept", async () => {
    await expect(withToolsDir(chatAgent(), toolsDir("bad-name"))).rejects.toThrow(
      /RollDie\.ts is not a usable tool name/,
    );
  });

  test("rejects a file that does not default-export its tool", async () => {
    await expect(withToolsDir(chatAgent(), toolsDir("no-default"))).rejects.toThrow(
      /echo\.ts has no default export/,
    );
  });

  test("reports a file one directory too deep instead of skipping it", async () => {
    await expect(withToolsDir(chatAgent(), toolsDir("nested"))).rejects.toThrow(
      /sub\/echo\.ts is nested inside tools\//,
    );
  });

  test("refuses a name the definition already carries", async () => {
    const served = await withToolsDir(chatAgent(), toolsDir("ok"));

    await expect(withToolsDir(served, toolsDir("ok"))).rejects.toThrow(
      /"roll_die" is declared twice/,
    );
  });

  test("offers the discovered tool to the model and runs what it calls", async () => {
    const model = createFakeLanguageModel({
      steps: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "roll_die", input: '{"sides":6}' }],
        [{ type: "text", text: "rolled" }],
      ],
    });
    const chat = createTextAgent({
      agent: await withToolsDir(chatAgent(), toolsDir("ok")),
      model,
      logger: silentLogger,
    });

    let reply = "";
    for await (const delta of chat.stream({ messages: [{ role: "user", content: "roll" }] })
      .textStream) {
      reply += delta;
    }

    expect(reply).toBe("rolled");
    // What the model was offered on the first request — the schema list a
    // hand-written map is the usual way to be missing from.
    const offered = model.calls[0]?.tools as { name: string }[] | undefined;
    expect(offered?.map((t) => t.name)).toEqual(["roll_die"]);
    // …and what came back on the second: the file's own `execute` ran
    // in-process, and its value is in the prompt the model reads next.
    const prompt = (model.calls[1]?.prompt ?? []) as PromptMessage[];
    const results = prompt.flatMap(partsOf).filter((part) => part.type === "tool-result");
    expect(results).toHaveLength(1);
    expect(results[0]?.toolName).toBe("roll_die");
    expect(JSON.parse(String(results[0]?.output?.value))).toEqual({
      rolled: expect.any(Number),
    });
  });
});
