// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createToolContext } from "./_testing-context.ts";
import { agent } from "./define.ts";
import { SessionEventMetaSchema } from "./protocol-event-meta.ts";
import type { SessionEvent } from "./session-event-map.ts";
import { sessionSlot } from "./session-slot.ts";
import { fireEvent, sessionEvent } from "./testing-session-events.ts";

describe("sessionEvent", () => {
  test("builds the event with a well-formed envelope", () => {
    const event = sessionEvent("userTranscript.committed", { text: "two pizzas" });
    expect(event.type).toBe("userTranscript.committed");
    expect(event.text).toBe("two pizzas");
    // The envelope the wire schema requires, not merely the two field names.
    expect(SessionEventMetaSchema.safeParse(event.meta).success).toBe(true);
  });

  test("mints a distinct id per call and a FIXED instant, so a fixture replays", () => {
    const a = sessionEvent("reply.completed");
    const b = sessionEvent("reply.completed");
    expect(a.meta.id).not.toBe(b.meta.id);
    expect(a.meta.at).toBe(b.meta.at);
    expect(a.meta.at).toBe(Date.UTC(2026, 0, 1));
  });

  test("meta overrides pin either half of the envelope", () => {
    const event = sessionEvent("reply.completed", undefined, { id: "evt_pinned", at: 7 });
    expect(event.meta).toEqual({ id: "evt_pinned", at: 7 });
  });

  test("the fields cannot override the type", () => {
    const fields = { text: "hi", type: "reply.completed" } as unknown as { text: string };
    expect(sessionEvent("userTranscript.committed", fields).type).toBe("userTranscript.committed");
  });
});

describe("fireEvent", () => {
  const heard = sessionSlot("heard", () => ({ lines: [] as string[], seen: 0 }));

  test("runs the typed handler, then `*`, each handed the same context", async () => {
    const order: string[] = [];
    const def = agent({
      name: "Listener",
      events: {
        "userTranscript.committed": (event, ctx) => {
          order.push(`typed:${event.text}`);
          heard.update(ctx, (draft) => {
            draft.lines.push(event.text);
          });
        },
        "*": (event, ctx) => {
          order.push(`*:${event.type}`);
          heard.update(ctx, (draft) => {
            draft.seen += 1;
          });
        },
      },
    });
    const ctx = createToolContext();
    const fired = await fireEvent(
      def,
      sessionEvent("userTranscript.committed", { text: "hi" }),
      ctx,
    );
    expect(fired).toEqual({ typed: true, wildcard: true });
    expect(order).toEqual(["typed:hi", "*:userTranscript.committed"]);
    // What the handlers wrote is read back through the SAME context.
    expect(heard.get(ctx)).toEqual({ lines: ["hi"], seen: 1 });
  });

  test("reports which handlers the event reached", async () => {
    const def = agent({ name: "Listener", events: { "reply.completed": () => undefined } });
    expect(await fireEvent(def, sessionEvent("reply.completed"))).toEqual({
      typed: true,
      wildcard: false,
    });
    expect(await fireEvent(def, sessionEvent("reply.cancelled"))).toEqual({
      typed: false,
      wildcard: false,
    });
  });

  test("awaits an async handler, where the session would not", async () => {
    const def = agent({
      name: "Listener",
      events: {
        "reply.completed": async (_event, ctx) => {
          await Promise.resolve();
          heard.update(ctx, (draft) => {
            draft.seen += 1;
          });
        },
      },
    });
    const ctx = createToolContext();
    await fireEvent(def, sessionEvent("reply.completed"), ctx);
    expect(heard.get(ctx).seen).toBe(1);
  });

  test("a handler's throw propagates, where the session would log it", async () => {
    const def = agent({
      name: "Listener",
      events: {
        "reply.completed": () => {
          throw new Error("hook broke");
        },
      },
    });
    await expect(fireEvent(def, sessionEvent("reply.completed"))).rejects.toThrow("hook broke");
  });

  test("defaults to a FRESH context, i.e. a distinct session", async () => {
    const def = agent({
      name: "Listener",
      events: {
        "reply.completed": (_event, ctx) => {
          heard.update(ctx, (draft) => {
            draft.seen += 1;
          });
        },
      },
    });
    const ctx = createToolContext();
    await fireEvent(def, sessionEvent("reply.completed"));
    await fireEvent(def, sessionEvent("reply.completed"), ctx);
    expect(heard.get(ctx).seen).toBe(1);
  });

  test("an agent with no `events` is refused by name", async () => {
    const event: SessionEvent = sessionEvent("reply.completed");
    await expect(fireEvent(agent({ name: "Mute" }), event)).rejects.toThrow(
      'the agent "Mute" declares no `events`',
    );
  });
});
