export const description = "Get the session owner set by onConnect";

export default async function execute(
  _args: unknown,
  ctx: { kv: { get: <T>(key: string) => Promise<T | null> } },
) {
  const owner = (await ctx.kv.get<string>("owner")) ?? "";
  return { owner };
}
