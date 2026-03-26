// Copyright 2025 the AAI authors. MIT license.

import { KvRequestSchema } from "@alexkroman1/aai/protocol";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { Context } from "hono";
import type { Env } from "./context.ts";

export async function handleKv(c: Context<Env>): Promise<Response> {
  const { kvStore } = c.env;
  const scope = c.get("scope");

  let msg: ReturnType<typeof KvRequestSchema.parse>;
  try {
    msg = KvRequestSchema.parse(await c.req.json());
  } catch (err: unknown) {
    return c.json({ error: `Invalid KV request: ${errorMessage(err)}` }, 400);
  }

  try {
    switch (msg.op) {
      case "get":
        return c.json({ result: await kvStore.get(scope, msg.key) });
      case "set":
        await kvStore.set(scope, msg.key, msg.value, msg.expireIn);
        return c.json({ result: "OK" });
      case "del":
        await kvStore.del(scope, msg.key);
        return c.json({ result: "OK" });
      case "keys":
        return c.json({ result: await kvStore.keys(scope, msg.pattern) });
      case "list": {
        const opts: { limit?: number; reverse?: boolean } = {};
        if (msg.limit !== undefined) opts.limit = msg.limit;
        if (msg.reverse !== undefined) opts.reverse = msg.reverse;
        return c.json({ result: await kvStore.list(scope, msg.prefix, opts) });
      }
      default: {
        const _: never = msg;
        return c.json({ error: `Unknown KV op: ${(_ as { op: string }).op}` }, 400);
      }
    }
  } catch (err: unknown) {
    console.error("KV operation failed", {
      op: msg.op,
      slug: scope.slug,
      error: errorMessage(err),
    });
    return c.json({ error: `KV ${msg.op} failed: ${errorMessage(err)}` }, 500);
  }
}
