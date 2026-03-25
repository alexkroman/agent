import { defineAgent, type ToolDef } from "@alexkroman1/aai";
import { z } from "zod";

/**
 * Test Patterns Agent — demonstrates every testable agent pattern.
 *
 * This agent exists to showcase the testing harness. Each tool and hook
 * exercises a different pattern you'd want to verify in tests.
 */

interface TaskState {
  tasks: { id: number; text: string; done: boolean }[];
  nextId: number;
  owner: string;
}

/** Helper to preserve state generic through tool definitions. */
function taskTool<P extends z.ZodObject<z.ZodRawShape>>(
  def: ToolDef<P, TaskState>,
): ToolDef<P, TaskState> {
  return def;
}

export default defineAgent({
  name: "Test Patterns",
  instructions: "You are a task manager that demonstrates testable agent patterns.",
  greeting: "Hey, I'm your task manager. Try adding a task.",

  state: (): TaskState => ({
    tasks: [],
    nextId: 1,
    owner: "",
  }),

  builtinTools: ["run_code"],

  onConnect: (ctx) => {
    ctx.state.owner = "connected-user";
  },

  onTurn: (_text, _ctx) => {
    // Hook fires on each user turn — tracked by harness via t.turns
  },

  onStep: (step, _ctx) => {
    if (step.stepNumber < 1) throw new Error("Invalid step number");
  },

  tools: {
    add_task: taskTool({
      description: "Add a new task to the list",
      parameters: z.object({
        text: z.string().min(1).describe("Task description"),
      }),
      execute: ({ text }, ctx) => {
        const task = { id: ctx.state.nextId++, text, done: false };
        ctx.state.tasks.push(task);
        return { added: task, total: ctx.state.tasks.length };
      },
    }),

    complete_task: taskTool({
      description: "Mark a task as done",
      parameters: z.object({
        id: z.number().describe("Task ID to complete"),
      }),
      execute: ({ id }, ctx) => {
        const task = ctx.state.tasks.find((t) => t.id === id);
        if (!task) return { error: `Task ${id} not found` };
        task.done = true;
        return { completed: task };
      },
    }),

    list_tasks: {
      description: "List all tasks with their status",
      execute: (_args, ctx) => {
        const state = ctx.state as TaskState;
        return {
          tasks: state.tasks,
          total: state.tasks.length,
          completed: state.tasks.filter((t) => t.done).length,
          owner: state.owner,
        };
      },
    },

    save_note: taskTool({
      description: "Save a note to persistent KV storage",
      parameters: z.object({
        key: z.string().min(1),
        value: z.string(),
      }),
      execute: async ({ key, value }, ctx) => {
        await ctx.kv.set(key, value);
        return { saved: true, key };
      },
    }),

    load_note: taskTool({
      description: "Load a note from persistent KV storage",
      parameters: z.object({
        key: z.string().min(1),
      }),
      execute: async ({ key }, ctx) => {
        const value = await ctx.kv.get<string>(key);
        return value ?? "not found";
      },
    }),

    check_env: {
      description: "Check if an environment variable is set",
      execute: (_args, ctx) => ({
        hasApiKey: ctx.env.API_KEY !== undefined,
        keyPreview: ctx.env.API_KEY?.slice(0, 4) ?? "none",
      }),
    },

    count_messages: {
      description: "Count conversation messages by role",
      execute: (_args, ctx) => {
        const byRole: Record<string, number> = {};
        for (const msg of ctx.messages) {
          byRole[msg.role] = (byRole[msg.role] ?? 0) + 1;
        }
        return { total: ctx.messages.length, byRole };
      },
    },

    get_owner: {
      description: "Get the session owner set by onConnect",
      execute: (_args, ctx) => {
        const state = ctx.state as TaskState;
        return { owner: state.owner };
      },
    },
  },
});
