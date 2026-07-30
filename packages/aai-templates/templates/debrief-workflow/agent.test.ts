import type { Db, GenerateOptions, ToolContext } from "@alexkroman1/aai";
import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { describe, expect, test, vi } from "vitest";
import agentDef from "./agent.ts";

/**
 * Map-backed fake of the app database, implementing exactly the two SQL
 * statements fileRecord emits (create table / upsert). Values are stored
 * parsed, the way a postgres driver returns jsonb.
 */
function makeDb(): { db: Db; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const db: Db = {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (sql.startsWith("create table if not exists app_state")) return [];
      if (sql.startsWith("insert into app_state")) {
        const [key, json] = params as [string, string];
        store.set(key, JSON.parse(json)); // $2::jsonb — parsed like postgres would
        return [];
      }
      throw new Error(`unexpected SQL in test: ${sql}`);
    },
  };
  return { db, store };
}

function makeCtx(
  overrides: Partial<ToolContext> = {},
): ToolContext & { store: Map<string, unknown> } {
  const { db, store } = makeDb();
  return {
    env: {},
    state: {},
    db,
    vector: {} as ToolContext["vector"],
    generate: () => Promise.reject(new Error("generate not mocked")),
    messages: [],
    sessionId: "run-1",
    send: vi.fn(),
    ...overrides,
    store,
  };
}

describe("debrief-workflow template", () => {
  test("config passes manifest validation", () => {
    // Same conversion `aai build`/`aai deploy` run — catches a workflow
    // config that violates the kind rules (assertAgentKind).
    expect(() => toAgentConfig(agentDef)).not.toThrow();
  });

  test("is a workflow, text-only by default", () => {
    expect(agentDef.kind).toBe("workflow");
    // tts omitted → none(): the output is the run report, not speech.
    expect(agentDef.tts?.kind).toBe("none");
    expect(toAgentConfig(agentDef)).toMatchObject({ kind: "workflow", mode: "pipeline" });
  });

  test("declares Slack as the send channel for notify actions", () => {
    expect(agentDef.send?.kind).toBe("slack");
  });

  test("extract_actions turns the transcript into typed actions via ctx.generate", async () => {
    const extracted = {
      actions: [
        {
          type: "quote",
          summary: "Quote the Hendersons for a water heater",
          customer: "Hendersons",
          amountUsd: 1800,
          assumptions: ["'around $1,800' rounded to 1800"],
        },
        {
          type: "notify",
          summary: "Tell Mike the Oak Street job slips a day",
          message: "Heads up: the Oak Street job slips a day.",
          assumptions: [],
        },
      ],
    };
    const generate = vi.fn(async (opts: GenerateOptions) => {
      // The tool must ship a JSON Schema (never a Zod schema) — this is the
      // exact contract the sandbox RPC enforces in production.
      expect(opts.schema).toBeDefined();
      expect(typeof (opts.schema as { safeParse?: unknown }).safeParse).not.toBe("function");
      return { text: JSON.stringify(extracted), object: extracted };
    });
    const ctx = makeCtx({ generate });

    const transcript =
      "finished the Hendersons' inspection, water heater needs replacing — " +
      "quote them around $1,800... and tell Mike the Oak Street job slips a day";
    const result = await agentDef.tools?.extract_actions?.execute({ transcript }, ctx);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]?.prompt).toContain("Hendersons");
    expect(result).toEqual(extracted);
  });

  test("extract_actions rejects a malformed extraction instead of passing it on", async () => {
    const bad = { actions: [{ type: "teleport", summary: 1 }] };
    const ctx = makeCtx({ generate: async () => ({ text: JSON.stringify(bad), object: bad }) });
    await expect(
      agentDef.tools?.extract_actions?.execute({ transcript: "t" }, ctx),
    ).rejects.toThrow();
  });

  test("file_quote, order_part, and schedule_followup persist records to ctx.db", async () => {
    const ctx = makeCtx();

    const quote = (await agentDef.tools?.file_quote?.execute(
      { customer: "Hendersons", amountUsd: 1800, description: "Water heater replacement" },
      ctx,
    )) as { filed: boolean; id: string };
    const order = (await agentDef.tools?.order_part?.execute(
      { part: "50-gal water heater", forCustomer: "Hendersons" },
      ctx,
    )) as { ordered: boolean; id: string };
    const followup = (await agentDef.tools?.schedule_followup?.execute(
      { customer: "Hendersons", when: "Thursday morning" },
      ctx,
    )) as { scheduled: boolean; id: string };

    expect(quote.filed).toBe(true);
    expect(order.ordered).toBe(true);
    expect(followup.scheduled).toBe(true);
    // Each record landed in the database under its returned id, with a filed timestamp.
    for (const { id } of [quote, order, followup]) {
      expect(ctx.store.get(id)).toMatchObject({ filedAt: expect.any(String) });
    }
    expect(ctx.store.get(quote.id)).toMatchObject({ customer: "Hendersons", amountUsd: 1800 });
    expect(ctx.store.get(followup.id)).toMatchObject({ when: "Thursday morning" });
  });
});
