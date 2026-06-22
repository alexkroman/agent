// Copyright 2025 the AAI authors. MIT license.

import { errorMessage } from "@alexkroman1/aai";
import type { VectorRequest } from "@alexkroman1/aai/protocol";
import type { Vector, VectorQueryOptions } from "@alexkroman1/aai/runtime";
import type { ValidatedAppContext } from "./context.ts";

export async function handleVector(
  c: ValidatedAppContext<VectorRequest>,
  vector: Vector,
): Promise<Response> {
  const slug = c.var.slug;
  const msg = c.req.valid("json");

  try {
    switch (msg.op) {
      case "upsert":
        await vector.upsert(msg.id, msg.text, msg.metadata);
        return c.json({ result: "OK" });
      case "query": {
        const opts: VectorQueryOptions = {};
        if (msg.topK !== undefined) opts.topK = msg.topK;
        if (msg.filter !== undefined) opts.filter = msg.filter;
        return c.json({ result: await vector.query(msg.text, opts) });
      }
      case "delete":
        await vector.delete(msg.ids);
        return c.json({ result: "OK" });
      default: {
        const _: never = msg;
        return c.json({ error: "Unknown Vector op" }, 400);
      }
    }
  } catch (err: unknown) {
    console.error("Vector operation failed", {
      op: msg.op,
      slug,
      error: errorMessage(err),
    });
    return c.json({ error: `Vector ${msg.op} failed` }, 500);
  }
}
