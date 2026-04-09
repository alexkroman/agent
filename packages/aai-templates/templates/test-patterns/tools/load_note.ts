export default async function execute(
  args: { key: string },
  ctx: {
    kv: { get: <T>(key: string) => Promise<T | null> };
  },
) {
  const value = await ctx.kv.get<string>(`note:${args.key}`);
  return value ?? "not found";
}
