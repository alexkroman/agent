export default async function execute(
  args: { id: number },
  ctx: {
    kv: {
      get: <T>(key: string) => Promise<T | null>;
      set: (key: string, value: unknown) => Promise<void>;
    };
  },
) {
  const tasks = (await ctx.kv.get<{ id: number; text: string; done: boolean }[]>("tasks")) ?? [];
  const task = tasks.find((t) => t.id === args.id);
  if (!task) return { error: `Task ${args.id} not found` };
  task.done = true;
  await ctx.kv.set("tasks", tasks);
  return { completed: task };
}
