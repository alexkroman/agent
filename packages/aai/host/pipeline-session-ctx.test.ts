// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { buildPipelineCtx } from "./pipeline-session-ctx.ts";
import { consoleLogger } from "./runtime-config.ts";

const baseDeps = {
  id: "sess-1",
  agent: "demo",
  client: { event: () => undefined, playAudioChunk: () => undefined } as never,
  agentConfig: { name: "demo", systemPrompt: "", maxSteps: 3 } as never,
  executeTool: (async () => "") as never,
  log: consoleLogger,
};

describe("buildPipelineCtx", () => {
  test("starts with null provider sessions", () => {
    const ctx = buildPipelineCtx(baseDeps);
    expect(ctx.stt).toBeNull();
    expect(ctx.tts).toBeNull();
  });

  test("pushMessages + beginReply + cancelReply match S2S semantics", () => {
    const ctx = buildPipelineCtx(baseDeps);
    ctx.pushMessages({ role: "user", content: "hi" });
    ctx.beginReply("r1");
    expect(ctx.reply.currentReplyId).toBe("r1");
    ctx.cancelReply();
    expect(ctx.reply.currentReplyId).toBeNull();
    expect(ctx.conversationMessages).toEqual([{ role: "user", content: "hi" }]);
  });
});
