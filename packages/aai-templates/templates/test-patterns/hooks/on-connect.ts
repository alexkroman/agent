export default async function onConnect(ctx: {
  kv: { set: (key: string, value: unknown) => Promise<void> };
}) {
  await ctx.kv.set("owner", "connected-user");
}
