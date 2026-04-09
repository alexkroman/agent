export default async function execute(
  _args: Record<string, never>,
  ctx: { kv: { set: (k: string, v: unknown) => Promise<void> } },
) {
  await ctx.kv.set("complexity", "deep");
  return { complexity: "deep", maxSteps: 10 };
}
