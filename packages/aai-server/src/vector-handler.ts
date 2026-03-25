// Copyright 2025 the AAI authors. MIT license.

// biome-ignore lint/correctness/noUnresolvedImports: workspace dependency resolved at build time
import { errorMessage } from "@alexkroman1/aai/utils";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { VectorRequestSchema } from "./_schemas.ts";
import type { Env } from "./context.ts";

export async function handleVector(c: Context<Env>): Promise<Response> {
  const { vectorStore } = c.env;
  const scope = c.get("scope");

  if (!vectorStore) {
    throw new HTTPException(503, { message: "Vector store not configured" });
  }

  const msg = VectorRequestSchema.parse(await c.req.json());

  try {
    switch (msg.op) {
      case "upsert":
        await vectorStore.upsert(scope, msg.id, msg.data, msg.metadata);
        return c.json({ result: "OK" });
      case "query":
        return c.json({
          result: await vectorStore.query(scope, msg.text, msg.topK, msg.filter),
        });
      case "remove":
        await vectorStore.remove(scope, msg.ids);
        return c.json({ result: "OK" });
      default: {
        const _: never = msg;
        return c.json({ error: `Unknown op: ${(_ as { op: string }).op}` }, 400);
      }
    }
  } catch (err: unknown) {
    console.error("Vector operation failed", {
      op: msg.op,
      slug: scope.slug,
      error: errorMessage(err),
    });
    return c.json({ error: `Vector operation failed: ${msg.op}` }, 500);
  }
}
