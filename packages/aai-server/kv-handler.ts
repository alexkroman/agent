// Copyright 2025 the AAI authors. MIT license.

import { errorMessage, type Kv } from "@alexkroman1/aai";
import type { KvRequest } from "@alexkroman1/aai/protocol";
import type { ValidatedAppContext } from "./context.ts";

export async function handleKv(c: ValidatedAppContext<KvRequest>, kv: Kv): Promise<Response> {
  const slug = c.var.slug;
  const msg = c.req.valid("json");

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
    return c.json({ error: `KV ${msg.op} failed` }, 500);
  }
}
