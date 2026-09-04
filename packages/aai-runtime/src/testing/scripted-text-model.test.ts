// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the published scripted `LanguageModel`.
 *
 * What they assert is the WIRE fidelity this module exists to own, and every
 * one of them is made through a real `createTextAgent` turn rather than by
 * calling `doStream` and reading frames. That is deliberate twice over: a
 * `LanguageModel` is a union admitting a bare model id, so reaching its methods
 * from a spec costs a cast — the thing this module was published to delete —
 * and a frame-level assertion would only prove the fake emits what the fake was
 * written to emit. What matters is that the SDK, running the real turn, reads
 * those frames the way the script means: a tool-call step runs its tool and
 * comes back for another step, a plain step ends the turn.
 *
 * That property is the whole reason the harness is shared. It rests on the
 * `finish` frame reporting `tool-calls` as a `{ unified, raw }` PAIR, and every
 * hand-written copy of this fake got some part of it wrong at some point — a
 * bare string ran no tools at all (thirty pipeline specs, none naming the fake).
 * A spec that checks the frame cannot see that; a spec that checks the turn can.
 */

import { type AgentDef, agent, tool } from "@alexkroman1/aai";
import { type ToolRegistry, withTools } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createTextAgent } from "../text-agent.ts";
import { scriptedTextModel } from "./scripted-text-model.ts";

/** A text agent WITH its tools — `agent()` takes none, a tool being a FILE. */
function textAgent(tools: ToolRegistry = {}): AgentDef {
  return withTools(agent({ name: "Desk", text: true, systemPrompt: "Be brief." }), tools);
}

/** Drain a turn, which is also what forces the tool loop to run. */
async function drain(result: { textStream: AsyncIterable<string> }): Promise<string> {
  let out = "";
  for await (const delta of result.textStream) out += delta;
  return out;
}

/** One turn against `script`, drained. */
async function turn(
  script: Parameters<typeof scriptedTextModel>[0],
  tools: ToolRegistry = {},
): Promise<string> {
  const chat = createTextAgent({ agent: textAgent(tools), model: scriptedTextModel(script) });
  return await drain(chat.stream({ messages: [{ role: "user", content: "hi" }] }));
}

describe("scriptedTextModel", () => {
  test("is a drop-in for createTextAgent's model, and streams the script", async () => {
    expect(await turn([{ text: "It shipped yesterday." }])).toBe("It shipped yesterday.");
  });

  test("a tool-call step RUNS the tool and comes back for the next step", async () => {
    // The property the `{ unified, raw }` finish pair buys, asserted where it is
    // observable: a step reporting a bare `finishReason` string executes no tool
    // and takes no follow-up step, so this reads as an agent that went silent.
    const ran: string[] = [];
    const text = await turn([{ toolCalls: [{ name: "ping" }] }, { text: "pong." }], {
      ping: tool({
        description: "Ping",
        execute: () => {
          ran.push("ping");
          return "pong";
        },
      }),
    });

    expect(ran).toEqual(["ping"]);
    expect(text).toBe("pong.");
  });

  test("a step's arguments reach the tool through the real coercion path", async () => {
    // The script writes an OBJECT; the wire carries a JSON string; the executor
    // coerces and validates it. All three are in the path here, which is what a
    // spec calling `execute` directly gives up.
    const got: unknown[] = [];
    await turn(
      [
        { toolCalls: [{ name: "book", input: { size: "4", guest: { name: "Ada" } } }] },
        { text: "Booked." },
      ],
      {
        book: tool({
          description: "Book",
          inputSchema: z.object({ size: z.number(), guest: z.object({ name: z.string() }) }),
          execute: (args) => {
            got.push(args);
            return "ok";
          },
        }),
      },
    );

    expect(got).toEqual([{ size: 4, guest: { name: "Ada" } }]);
  });

  test("text comes BEFORE a step's tool calls, as a provider streams it", async () => {
    // A model narrates and then calls, so a caller watching the stream sees the
    // narration while the tool runs. Reversing the two would make a spec about
    // that ordering pass against the wrong thing.
    const seen: string[] = [];
    const chat = createTextAgent({
      agent: textAgent({
        ping: tool({
          description: "Ping",
          execute: () => {
            seen.push("tool");
            return "pong";
          },
        }),
      }),
      model: scriptedTextModel([
        { text: "Let me check.", toolCalls: [{ name: "ping" }] },
        { text: "Done." },
      ]),
    });

    const result = chat.stream({ messages: [{ role: "user", content: "hi" }] });
    for await (const delta of result.textStream) if (delta !== "") seen.push(`text:${delta}`);

    expect(seen).toEqual(["text:Let me check.", "tool", "text:Done."]);
  });

  test("mints incrementing call ids across the whole script, and honours a named one", async () => {
    const ids: string[] = [];
    const noted = tool({
      description: "Note",
      execute: (_args, ctx) => {
        ids.push(ctx.sessionId);
        return "ok";
      },
    });
    const chat = createTextAgent({
      agent: textAgent({ note: noted }),
      model: scriptedTextModel([
        { toolCalls: [{ name: "note" }, { name: "note" }] },
        { toolCalls: [{ name: "note", id: "chosen" }] },
        { text: "All noted." },
      ]),
    });
    const result = chat.stream({ messages: [{ role: "user", content: "hi" }] });
    await drain(result);

    // Ids are minted while the script is PROJECTED, so they run across steps
    // rather than restarting per step — two calls of one tool in one step are
    // still distinguishable, which is what the SDK pairs results on.
    expect((await result.steps).flatMap((step) => step.toolCalls.map((c) => c.toolCallId))).toEqual(
      ["call-1", "call-2", "chosen"],
    );
    expect(ids).toHaveLength(3);
  });

  test("the same script replays identically, ids included", async () => {
    // A run whose ids depend on how far a previous one got is not replayable,
    // which is why they are minted once per model rather than per stream.
    const script = [{ toolCalls: [{ name: "ping" }] }, { text: "pong." }];
    const tools = { ping: tool({ description: "Ping", execute: () => "pong" }) };

    const first = createTextAgent({ agent: textAgent(tools), model: scriptedTextModel(script) });
    const second = createTextAgent({ agent: textAgent(tools), model: scriptedTextModel(script) });
    const a = first.stream({ messages: [{ role: "user", content: "hi" }] });
    const b = second.stream({ messages: [{ role: "user", content: "hi" }] });
    await drain(a);
    await drain(b);

    const idsOf = async (result: typeof a) =>
      (await result.steps).flatMap((step) => step.toolCalls.map((c) => c.toolCallId));
    expect(await idsOf(a)).toEqual(await idsOf(b));
  });

  test("answers past the end of the script instead of running dry", async () => {
    // A one-step script driven for a SECOND call: the model answers an empty
    // step, so a turn that took one step more than the spec expected fails on
    // the assertion that names the difference rather than inside the fake.
    const chat = createTextAgent({
      agent: textAgent(),
      model: scriptedTextModel([{ text: "one" }]),
    });
    const first = chat.stream({ messages: [{ role: "user", content: "a" }] });
    const second = chat.stream({ messages: [{ role: "user", content: "b" }] });

    expect(await drain(first)).toBe("one");
    expect(await drain(second)).toBe("");
  });

  test("an empty script completes the turn rather than hanging it", async () => {
    // What a spec passes when the model is never expected to be reached at all
    // — a request the handler refuses before the turn starts.
    expect(await turn([])).toBe("");
  });
});
