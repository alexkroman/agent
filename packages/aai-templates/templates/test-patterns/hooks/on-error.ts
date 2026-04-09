export default async function onError(
  error: Error,
  ctx:
    | {
        kv: { set: (key: string, value: unknown) => Promise<void> };
      }
    | undefined,
) {
  if (ctx) await ctx.kv.set("lastError", error.message);
}
