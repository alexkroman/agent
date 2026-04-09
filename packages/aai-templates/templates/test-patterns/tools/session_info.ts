export const description = "Get current session metadata";

export default async function execute(
  _args: unknown,
  ctx: {
    sessionId: string;
    kv: { get: <T>(key: string) => Promise<T | null> };
  },
) {
  const owner = (await ctx.kv.get<string>("owner")) ?? "";
  const tasks = (await ctx.kv.get<{ id: number; text: string; done: boolean }[]>("tasks")) ?? [];
  const lastError = (await ctx.kv.get<string>("lastError")) ?? null;
  return {
    sessionId: ctx.sessionId,
    owner,
    taskCount: tasks.length,
    lastError,
  };
}
