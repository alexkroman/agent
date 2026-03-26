// Copyright 2025 the AAI authors. MIT license.
import type { Context } from "hono";
import type { Env } from "./context.ts";

export async function handleDelete(c: Context<Env>): Promise<Response> {
  const slug = c.get("slug");

  const existing = c.env.slots.get(slug);
  if (existing?.sandbox) {
    await existing.sandbox.terminate().catch(() => {
      // Best-effort cleanup of running sandbox
    });
  } else if (existing?.initializing) {
    await existing.initializing
      .then((sb) => sb.terminate())
      .catch(() => {
        // Best-effort cleanup of initializing sandbox
      });
  }
  c.env.slots.delete(slug);

  await c.env.store.deleteAgent(slug);

  console.info("Delete received", { slug });

  return c.json({ ok: true, message: `Deleted ${slug}` });
}
