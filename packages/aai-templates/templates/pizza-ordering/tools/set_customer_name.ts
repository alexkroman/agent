export default async function execute(
  args: { name: string },
  ctx: { kv: { set: (k: string, v: unknown) => Promise<void> } },
) {
  await ctx.kv.set("customerName", args.name);
  return { name: args.name };
}
