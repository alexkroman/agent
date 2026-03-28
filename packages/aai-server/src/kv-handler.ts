// Copyright 2025 the AAI authors. MIT license.

import { createUnstorageKv, errorMessage } from "@alexkroman1/aai/internal";
import { KvRequestSchema } from "@alexkroman1/aai/protocol";
import type { AppContext } from "./factory.ts";

export async function handleKv(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  const kv = createUnstorageKv({ storage: c.env.storage, prefix: `agents/${slug}/kv` });

  const msg = KvRequestSchema.parse(await c.req.json());

  try {
    switch (msg.op) {
      case "get":
        return c.json({ result: await kv.get(msg.key) });
      case "set":
        await kv.set(msg.key, msg.value, msg.expireIn ? { expireIn: msg.expireIn } : undefined);
        return c.json({ result: "OK" });
      case "del":
        await kv.delete(msg.key);
        return c.json({ result: "OK" });
      case "keys":
        return c.json({ result: await kv.keys(msg.pattern) });
      case "list": {
        const opts: { limit?: number; reverse?: boolean } = {};
        if (msg.limit !== undefined) opts.limit = msg.limit;
        if (msg.reverse !== undefined) opts.reverse = msg.reverse;
        return c.json({ result: await kv.list(msg.prefix, opts) });
      }
      default: {
        const _: never = msg;
        return c.json({ error: `Unknown KV op: ${(_ as { op: string }).op}` }, 400);
      }
    }
  } catch (err: unknown) {
    console.error("KV operation failed", {
      op: msg.op,
      slug,
      error: errorMessage(err),
    });
    return c.json({ error: `KV ${msg.op} failed: ${errorMessage(err)}` }, 500);
  }
}
