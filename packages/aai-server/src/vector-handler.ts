// Copyright 2025 the AAI authors. MIT license.

import { errorMessage } from "@alexkroman1/aai/utils";
import type { Context } from "hono";
import { VectorRequestSchema } from "./_schemas.ts";
import type { Env } from "./context.ts";
import { createScopedVector } from "./scoped-storage.ts";

export async function handleVector(c: Context<Env>): Promise<Response> {
  const slug = c.get("slug");
  const vector = createScopedVector(
    c.env.storage,
    slug,
    c.env.modelCacheDir ? { modelCacheDir: c.env.modelCacheDir } : undefined,
  );

  const msg = VectorRequestSchema.parse(await c.req.json());

  try {
    switch (msg.op) {
      case "upsert":
        await vector.upsert(msg.id, msg.data, msg.metadata);
        return c.json({ result: "OK" });
      case "query": {
        const queryOpts: { topK?: number; filter?: string } = {};
        if (msg.topK != null) queryOpts.topK = msg.topK;
        if (msg.filter != null) queryOpts.filter = msg.filter;
        return c.json({
          result: await vector.query(msg.text, queryOpts),
        });
      }
      case "delete":
        await vector.delete(msg.ids);
        return c.json({ result: "OK" });
      default: {
        const _: never = msg;
        return c.json({ error: `Unknown op: ${(_ as { op: string }).op}` }, 400);
      }
    }
  } catch (err: unknown) {
    console.error("Vector operation failed", {
      op: msg.op,
      slug,
      error: errorMessage(err),
    });
    return c.json({ error: `Vector ${msg.op} failed: ${errorMessage(err)}` }, 500);
  }
}
