export default async function execute(
  args: { url: string; title: string },
  ctx: {
    kv: {
      get: <T>(k: string) => Promise<T | undefined>;
      set: (k: string, v: unknown) => Promise<void>;
    };
  },
) {
  const sources: string[] = (await ctx.kv.get("sources")) ?? [];
  const updated = [...sources, `${args.title}: ${args.url}`];
  await ctx.kv.set("sources", updated);
  return { saved: true, totalSources: updated.length };
}
