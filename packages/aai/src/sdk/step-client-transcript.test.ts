// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CLIENT_TRANSCRIPT_UNAVAILABLE_MESSAGE,
  type ClientTranscriptReader,
  publishClientTranscriptReader,
  publishedClientTranscriptReader,
  stepClientTranscript,
} from "./step-client-transcript.ts";
import { FatalError } from "./step-error-classes.ts";

afterEach(() => publishClientTranscriptReader(undefined));

describe("stepClientTranscript", () => {
  test("hands the published reader the client and the options, and answers what it read", async () => {
    const transcript = {
      sessions: [
        {
          sessionId: "s1",
          startedAt: 1,
          lastEventIndex: 4,
          messages: [{ role: "user" as const, text: "hi", at: 2 }],
          tools: [],
        },
      ],
    };
    const reader = vi.fn<ClientTranscriptReader>(async () => transcript);
    publishClientTranscriptReader(reader);
    const cursor = { sessionId: "s0", index: 9 };

    await expect(stepClientTranscript("kitchen", { afterEventIndex: cursor })).resolves.toBe(
      transcript,
    );
    expect(reader).toHaveBeenCalledWith("kitchen", { afterEventIndex: cursor });
  });

  test("defaults the options to none", async () => {
    const reader = vi.fn<ClientTranscriptReader>(async () => ({ sessions: [] }));
    publishClientTranscriptReader(reader);
    await stepClientTranscript("kitchen");
    expect(reader).toHaveBeenCalledWith("kitchen", {});
  });

  test("with nothing published it is FATAL, naming the fix", async () => {
    const err = await stepClientTranscript("kitchen").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FatalError);
    expect((err as Error).message).toBe(CLIENT_TRANSCRIPT_UNAVAILABLE_MESSAGE);
  });

  test("a malformed client id is refused before the reader is asked", async () => {
    const reader = vi.fn<ClientTranscriptReader>(async () => ({ sessions: [] }));
    publishClientTranscriptReader(reader);
    await expect(stepClientTranscript("a b")).rejects.toBeInstanceOf(FatalError);
    expect(reader).not.toHaveBeenCalled();
  });

  test("the slot is global, so a second copy of this module reads the same reader", () => {
    const reader: ClientTranscriptReader = async () => ({ sessions: [] });
    publishClientTranscriptReader(reader);
    const slot = Symbol.for("@alexkroman1/aai.clientTranscriptReader");
    expect((globalThis as Record<symbol, unknown>)[slot]).toBe(reader);
    expect(publishedClientTranscriptReader()).toBe(reader);
    publishClientTranscriptReader(undefined);
    expect(publishedClientTranscriptReader()).toBeUndefined();
  });
});
