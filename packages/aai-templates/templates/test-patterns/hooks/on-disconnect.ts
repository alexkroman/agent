export default async function onDisconnect(ctx: {
  kv: {
    get: <T>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<void>;
  };
}) {
  const tasks = await ctx.kv.get<{ id: number; text: string; done: boolean }[]>("tasks");
  await ctx.kv.set("session:tasks", tasks ?? []);
}
