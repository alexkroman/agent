export const description = "List all tasks with their status";

export default async function execute(
  _args: unknown,
  ctx: {
    kv: {
      get: <T>(key: string) => Promise<T | null>;
    };
  },
) {
  const tasks = (await ctx.kv.get<{ id: number; text: string; done: boolean }[]>("tasks")) ?? [];
  const owner = (await ctx.kv.get<string>("owner")) ?? "";
  return {
    tasks,
    total: tasks.length,
    completed: tasks.filter((t) => t.done).length,
    owner,
  };
}
