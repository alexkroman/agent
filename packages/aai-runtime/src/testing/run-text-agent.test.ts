// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the published text-agent harness.
 *
 * What they are for is the PROJECTION and the FORWARDING, which is all this
 * module owns: the turn underneath is `createTextAgent`'s and has its own suite
 * one directory up. So each of these asserts either that a real path was taken
 * (a tool's arguments arrive coerced and validated, a throw arrives as a
 * readable failure, the step budget still ends a capped turn with an answer) or
 * that an option a caller sets actually reaches the agent — the failure mode a
 * derived-by-subtraction option bag exists to prevent, and the one a harness
 * presents as a spec quietly asserting against a default.
 *
 * The scripted MODEL has its own co-located suite; nothing here re-asserts what
 * the wire carries.
 */

import { type AgentDef, agent, tool } from "@alexkroman1/aai";
import { type ToolRegistry, withTools } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { runTextAgent } from "./run-text-agent.ts";

/** A text agent WITH its tools — `agent()` takes none, a tool being a FILE. */
function textAgent(def: Parameters<typeof agent>[0], tools: ToolRegistry = {}): AgentDef {
  return withTools(agent(def), tools);
}

const desk = (tools: ToolRegistry = {}) =>
  textAgent({ name: "Desk", text: true, systemPrompt: "Be brief." }, tools);

describe("runTextAgent", () => {
  test("hands back what the agent said, per step and concatenated", async () => {
    const run = await runTextAgent(
      desk({ noop: tool({ description: "n", execute: () => "ok" }) }),
      "hi",
      {
        script: [
          { text: "Let me check.", toolCalls: [{ name: "noop" }] },
          { text: "It shipped yesterday." },
        ],
      },
    );

    expect(run.texts).toEqual(["Let me check.", "It shipped yesterday."]);
    expect(run.text).toBe("Let me check.It shipped yesterday.");
    expect(run.steps).toHaveLength(2);
  });

  test("takes a conversation as well as a bare prompt", async () => {
    const run = await runTextAgent(desk(), [{ role: "user", content: "and then?" }], {
      script: [{ text: "Then it shipped." }],
    });
    expect(run.text).toBe("Then it shipped.");
  });

  test("runs tool calls through the real executor: coerced args, joined result", async () => {
    const got: number[] = [];
    const run = await runTextAgent(
      desk({
        add: tool({
          description: "Add one",
          inputSchema: z.object({ n: z.number() }),
          execute: ({ n }) => {
            got.push(n);
            return n + 1;
          },
        }),
      }),
      "add one to 4",
      {
        // A STRING where the schema wants a number: what a real provider emits,
        // and what `executeToolCall`'s coercion is for. A harness that called
        // `execute` directly would never see it.
        script: [{ toolCalls: [{ name: "add", input: { n: "4" } }] }, { text: "It is 5." }],
      },
    );

    // The tool really got a NUMBER — the coercion ran — and the projection
    // reports what each side of the wire actually carried: the model's own
    // arguments, and the serialized result the model reads back.
    expect(got).toEqual([4]);
    expect(run.toolCalls).toEqual([{ name: "add", id: "call-1", args: { n: "4" }, result: "5" }]);
  });

  test("keeps tool calls in order across steps, and mints distinguishable ids", async () => {
    const run = await runTextAgent(
      desk({
        note: tool({
          description: "Note",
          inputSchema: z.object({ what: z.string() }),
          execute: ({ what }) => `noted ${what}`,
        }),
      }),
      "note two things",
      {
        script: [
          { toolCalls: [{ name: "note", input: { what: "first" } }] },
          { toolCalls: [{ name: "note", input: { what: "second" } }] },
          { text: "Both noted." },
        ],
      },
    );

    expect(run.toolCalls.map((call) => [call.id, call.args])).toEqual([
      ["call-1", { what: "first" }],
      ["call-2", { what: "second" }],
    ]);
    expect(run.toolCalls.map((call) => call.result)).toEqual(["noted first", "noted second"]);
    // Flattened across steps: the projection is about the ORDER the turn called
    // in, not about how the loop was cut.
    expect(run.steps).toHaveLength(3);
  });

  test("honours an id the script names", async () => {
    const run = await runTextAgent(
      desk({ ping: tool({ description: "Ping", execute: () => "pong" }) }),
      "ping",
      { script: [{ toolCalls: [{ name: "ping", id: "chosen" }] }, { text: "pong." }] },
    );
    expect(run.toolCalls.map((call) => call.id)).toEqual(["chosen"]);
  });

  test("a throwing tool arrives as a readable result, not a rejection", async () => {
    const run = await runTextAgent(
      desk({
        boom: tool({
          description: "Boom",
          execute: () => {
            throw new Error("the disk is full");
          },
        }),
      }),
      "boom",
      { script: [{ toolCalls: [{ name: "boom" }] }, { text: "Sorry." }] },
    );

    expect(run.toolCalls).toHaveLength(1);
    expect(String(run.toolCalls[0]?.result)).toContain("the disk is full");
    expect(run.text).toContain("Sorry.");
  });

  test("appends the assistant reply and every tool exchange to `messages`", async () => {
    const run = await runTextAgent(
      desk({ ping: tool({ description: "Ping", execute: () => "pong" }) }),
      "ping",
      { script: [{ toolCalls: [{ name: "ping" }] }, { text: "Done." }] },
    );

    expect(run.messages.map((message) => message.role)).toEqual(["assistant", "tool", "assistant"]);
  });

  test("forwards `env` and `sessionId` into the tool's ctx", async () => {
    const seen: { token: unknown; sessionId: string }[] = [];
    const run = await runTextAgent(
      desk({
        look: tool({
          description: "Look",
          execute: (_args, ctx) => {
            seen.push({ token: ctx.env.TOKEN, sessionId: ctx.sessionId });
            return "looked";
          },
        }),
      }),
      "look",
      {
        env: { TOKEN: "t-1" },
        sessionId: "sid-1",
        script: [{ toolCalls: [{ name: "look" }] }, { text: "Looked." }],
      },
    );

    expect(seen).toEqual([{ token: "t-1", sessionId: "sid-1" }]);
    expect(run.text).toBe("Looked.");
  });

  test("forwards `maxSteps`, so the turn stops on the agent's own budget", async () => {
    // The budget is `maxSteps` TOOL-calling steps plus one reserved for the
    // forced answer — the same rule the voice pipeline takes. So a script
    // offering three steps is cut after two, and the third never runs.
    //
    // What is NOT asserted is that the reserved step made no tool call: that
    // step is sent `toolChoice: "none"`, and a scripted model answers its script
    // regardless. Honouring a tool choice is a real provider's business, and a
    // spec claiming otherwise here would be asserting against the fake.
    const run = await runTextAgent(
      desk({ ping: tool({ description: "Ping", execute: () => "pong" }) }),
      "ping thrice",
      {
        maxSteps: 1,
        script: [
          { toolCalls: [{ name: "ping" }] },
          { toolCalls: [{ name: "ping" }] },
          { text: "That is all I can do." },
        ],
      },
    );

    expect(run.steps).toHaveLength(2);
    expect(run.text).not.toContain("That is all I can do.");
  });

  test("forwards a per-turn `systemPrompt` override", async () => {
    // Asserted through the TOOL rather than the model, since a scripted model
    // publishes no record of what it was asked: `ctx.messages` is the turn's own
    // conversation, and a system message is deliberately not in it.
    const roles: string[][] = [];
    await runTextAgent(
      desk({
        look: tool({
          description: "Look",
          execute: (_args, ctx) => {
            roles.push(ctx.messages.map((message) => message.role));
            return "ok";
          },
        }),
      }),
      "look",
      {
        systemPrompt: "Answer like a pirate.",
        script: [{ toolCalls: [{ name: "look" }] }, { text: "Arr." }],
      },
    );

    expect(roles).toEqual([["user"]]);
  });

  test("refuses an agent that did not opt into text mode", async () => {
    await expect(
      runTextAgent(textAgent({ name: "Voice" }), "hi", { script: [{ text: "hi" }] }),
    ).rejects.toThrow(/not a text agent/);
  });

  test("forwards `signal`, and raises what ended the stream rather than reporting silence", async () => {
    // The whole reason the harness re-throws: an aborted turn produced no text,
    // and a projection that handed back `text: ""` would be indistinguishable
    // from an agent that chose to say nothing.
    const controller = new AbortController();
    controller.abort();

    await expect(
      runTextAgent(desk({ ping: tool({ description: "Ping", execute: () => "pong" }) }), "ping", {
        signal: controller.signal,
        script: [{ text: "never said" }],
      }),
    ).rejects.toThrow(/abort/i);
  });
});
