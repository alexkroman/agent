export const description = "Save a note to persistent KV storage with optional TTL";

export const parameters = {
  type: "object",
  properties: {
    key: { type: "string" },
    value: { type: "string" },
    ttl_ms: { type: "number", description: "Time-to-live in milliseconds" },
  },
  required: ["key", "value"],
};

export default async function execute(
  args: { key: string; value: string; ttl_ms?: number },
  ctx: {
    kv: {
      set: (key: string, value: unknown, opts?: { expireIn: number }) => Promise<void>;
    };
  },
) {
  await ctx.kv.set(
    `note:${args.key}`,
    args.value,
    args.ttl_ms ? { expireIn: args.ttl_ms } : undefined,
  );
  return { saved: true, key: args.key };
}
