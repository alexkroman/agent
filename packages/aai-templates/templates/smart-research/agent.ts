import { agent, tool } from "@alexkroman1/aai";
import { z } from "zod";

export default agent({
  name: "Smart Research Agent",
  systemPrompt:
    "You are a research assistant that gathers information, analyzes it, then responds. You work in three phases:\n1. Gather: Use search and fetch tools to collect information.\n2. Analyze: Use the analyze tool to synthesize your findings.\n3. Respond: Deliver your final answer.\n\nAlways search first, then analyze, then answer. Be thorough but concise.",
  greeting: "I'm your research assistant. Ask me anything and I'll dig into it.",
  builtinTools: ["web_search"],
  toolChoice: "required",
  maxSteps: 10,

  tools: {
    advance_phase: tool({
      description: "Move to the next research phase (gather -> analyze -> respond)",
      async execute(_args, ctx) {
        const phase: string = (await ctx.kv.get("phase")) ?? "gather";
        let nextPhase: string;

        if (phase === "gather") {
          nextPhase = "analyze";
        } else if (phase === "analyze") {
          nextPhase = "respond";
        } else {
          nextPhase = phase;
        }

        await ctx.kv.set("phase", nextPhase);
        return { phase: nextPhase };
      },
    }),

    analyze: tool({
      description: "Analyze all gathered sources and conversation context to form a conclusion",
      parameters: z.object({
        focus: z.string().describe("What aspect to focus the analysis on"),
      }),
      async execute(args, ctx) {
        const sources: string[] = (await ctx.kv.get("sources")) ?? [];
        const phase: string = (await ctx.kv.get("phase")) ?? "gather";

        const userMessages = ctx.messages.filter((m) => m.role === "user");
        return {
          focus: args.focus,
          sources,
          conversationTurns: userMessages.length,
          totalMessages: ctx.messages.length,
          phase,
        };
      },
    }),

    conversation_summary: tool({
      description: "Get a summary of the conversation so far",
      async execute(_args, ctx) {
        const msgs = ctx.messages;
        return {
          totalMessages: msgs.length,
          byRole: {
            user: msgs.filter((m) => m.role === "user").length,
            assistant: msgs.filter((m) => m.role === "assistant").length,
            tool: msgs.filter((m) => m.role === "tool").length,
          },
        };
      },
    }),

    mark_complex: tool({
      description: "Mark this research query as complex, allowing more search steps",
      async execute(_args, ctx) {
        await ctx.kv.set("complexity", "deep");
        return { complexity: "deep", maxSteps: 10 };
      },
    }),

    save_source: tool({
      description: "Save a source URL found during research for later analysis",
      parameters: z.object({
        url: z.string().describe("The source URL"),
        title: z.string().describe("Brief title or description"),
      }),
      async execute(args, ctx) {
        const sources: string[] = (await ctx.kv.get("sources")) ?? [];
        const updated = [...sources, `${args.title}: ${args.url}`];
        await ctx.kv.set("sources", updated);
        return { saved: true, totalSources: updated.length };
      },
    }),
  },
});
