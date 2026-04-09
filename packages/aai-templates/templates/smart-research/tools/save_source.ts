export const description = "Save a source URL found during research for later analysis";

export const parameters = {
  type: "object",
  properties: {
    url: { type: "string", description: "The source URL" },
    title: { type: "string", description: "Brief title or description" },
  },
  required: ["url", "title"],
};

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
