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
