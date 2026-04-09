export const description = "Add a new task to the list";

export const parameters = {
  type: "object",
  properties: {
    text: { type: "string", description: "Task description" },
  },
  required: ["text"],
};

export default async function execute(
  args: { text: string },
  ctx: {
    kv: {
      get: <T>(key: string) => Promise<T | null>;
      set: (key: string, value: unknown) => Promise<void>;
    };
  },
) {
  const tasks = (await ctx.kv.get<{ id: number; text: string; done: boolean }[]>("tasks")) ?? [];
  const nextId = (await ctx.kv.get<number>("nextId")) ?? 1;
  const task = { id: nextId, text: args.text, done: false };
  tasks.push(task);
  await ctx.kv.set("tasks", tasks);
  await ctx.kv.set("nextId", nextId + 1);
  return { added: task, total: tasks.length };
}
