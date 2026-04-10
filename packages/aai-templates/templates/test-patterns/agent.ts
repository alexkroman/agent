import { agent, tool } from "aai";
import { z } from "zod";

export default agent({
  name: "Test Patterns",
  systemPrompt: "You are a task manager that demonstrates testable agent patterns.",
  greeting: "Hey, I'm your task manager. Try adding a task.",
  sttPrompt: "Task management: add task, complete task, list tasks, save note, delete note",
  idleTimeoutMs: 120_000,
  builtinTools: ["run_code"],

  tools: {
    add_task: tool({
      description: "Add a new task to the list",
      parameters: z.object({
        text: z.string().describe("Task description"),
      }),
      async execute(args, ctx) {
        const tasks =
          (await ctx.kv.get<{ id: number; text: string; done: boolean }[]>("tasks")) ?? [];
        const nextId = (await ctx.kv.get<number>("nextId")) ?? 1;
        const task = { id: nextId, text: args.text, done: false };
        tasks.push(task);
        await ctx.kv.set("tasks", tasks);
        await ctx.kv.set("nextId", nextId + 1);
        return { added: task, total: tasks.length };
      },
    }),

    check_env: tool({
      description: "Check if an environment variable is set",
      async execute(_args, ctx) {
        return {
          hasApiKey: ctx.env.API_KEY !== undefined,
          keyPreview: ctx.env.API_KEY?.slice(0, 4) ?? "none",
        };
      },
    }),

    complete_task: tool({
      description: "Mark a task as done",
      parameters: z.object({
        id: z.number().describe("Task ID to complete"),
      }),
      async execute(args, ctx) {
        const tasks =
          (await ctx.kv.get<{ id: number; text: string; done: boolean }[]>("tasks")) ?? [];
        const task = tasks.find((t) => t.id === args.id);
        if (!task) return { error: `Task ${args.id} not found` };
        task.done = true;
        await ctx.kv.set("tasks", tasks);
        return { completed: task };
      },
    }),

    count_messages: tool({
      description: "Count conversation messages by role",
      async execute(_args, ctx) {
        const byRole: Record<string, number> = {};
        for (const msg of ctx.messages) {
          byRole[msg.role] = (byRole[msg.role] ?? 0) + 1;
        }
        return { total: ctx.messages.length, byRole };
      },
    }),

    delete_note: tool({
      description: "Delete a note from persistent KV storage",
      parameters: z.object({
        key: z.string(),
      }),
      async execute(args, ctx) {
        await ctx.kv.delete(`note:${args.key}`);
        return { deleted: true, key: args.key };
      },
    }),

    get_owner: tool({
      description: "Get the session owner from KV storage",
      async execute(_args, ctx) {
        const owner = (await ctx.kv.get<string>("owner")) ?? "";
        return { owner };
      },
    }),

    list_tasks: tool({
      description: "List all tasks with their status",
      async execute(_args, ctx) {
        const tasks =
          (await ctx.kv.get<{ id: number; text: string; done: boolean }[]>("tasks")) ?? [];
        const owner = (await ctx.kv.get<string>("owner")) ?? "";
        return {
          tasks,
          total: tasks.length,
          completed: tasks.filter((t) => t.done).length,
          owner,
        };
      },
    }),

    load_note: tool({
      description: "Load a note from persistent KV storage",
      parameters: z.object({
        key: z.string(),
      }),
      async execute(args, ctx) {
        const value = await ctx.kv.get<string>(`note:${args.key}`);
        return value ?? "not found";
      },
    }),

    save_note: tool({
      description: "Save a note to persistent KV storage with optional TTL",
      parameters: z.object({
        key: z.string(),
        value: z.string(),
        ttl_ms: z.number().describe("Time-to-live in milliseconds").optional(),
      }),
      async execute(args, ctx) {
        await ctx.kv.set(
          `note:${args.key}`,
          args.value,
          args.ttl_ms ? { expireIn: args.ttl_ms } : undefined,
        );
        return { saved: true, key: args.key };
      },
    }),

    session_info: tool({
      description: "Get current session metadata",
      async execute(_args, ctx) {
        const owner = (await ctx.kv.get<string>("owner")) ?? "";
        const tasks =
          (await ctx.kv.get<{ id: number; text: string; done: boolean }[]>("tasks")) ?? [];
        const lastError = (await ctx.kv.get<string>("lastError")) ?? null;
        return {
          sessionId: ctx.sessionId,
          owner,
          taskCount: tasks.length,
          lastError,
        };
      },
    }),
  },
});
