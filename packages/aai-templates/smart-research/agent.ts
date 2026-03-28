import { defineAgent, defineTool } from "@alexkroman1/aai";
import type { HookContext } from "@alexkroman1/aai";
import { z } from "zod";

/**
 * Smart Research Agent — demonstrates advanced features:
 * 1. toolChoice: "required" — forces the LLM to use tools every step
 * 2. ctx.messages — tools can read conversation history
 * 3. maxSteps as function — adapts max steps based on session complexity
 */

type ResearchState = {
  phase: "gather" | "analyze" | "respond";
  sources: string[];
  complexity: "simple" | "deep";
};

export default defineAgent({
  name: "Smart Research Agent",
  instructions: `You are a research assistant that gathers information, \
analyzes it, then responds. You work in three phases:
1. Gather: Use search and fetch tools to collect information.
2. Analyze: Use the analyze tool to synthesize your findings.
3. Respond: Deliver your final answer.

Always search first, then analyze, then answer. Be thorough but concise.`,
  greeting:
    "I'm your research assistant. Ask me anything and I'll dig into it.",
  builtinTools: ["web_search"],

  // Feature 1: toolChoice — force the LLM to always use a tool
  toolChoice: "required",

  // Feature 3: maxSteps as function — more steps for complex research
  maxSteps: (ctx: HookContext<ResearchState>) => {
    const state = ctx.state;
    return state.complexity === "deep" ? 10 : 5;
  },

  state: (): ResearchState => ({
    phase: "gather",
    sources: [],
    complexity: "simple",
  }),

  tools: {
    save_source: defineTool<z.ZodObject<{ url: z.ZodString; title: z.ZodString }>, ResearchState>({
      description: "Save a source URL found during research for later analysis",
      parameters: z.object({
        url: z.string().describe("The source URL"),
        title: z.string().describe("Brief title or description"),
      }),
      execute: ({ url, title }, ctx) => {
        const state = ctx.state;
        state.sources.push(`${title}: ${url}`);
        return { saved: true, totalSources: state.sources.length };
      },
    }),

    mark_complex: {
      description:
        "Mark this research query as complex, allowing more search steps",
      execute: (_args, ctx) => {
        const state = ctx.state;
        state.complexity = "deep";
        return { complexity: "deep", maxSteps: 10 };
      },
    },

    advance_phase: {
      description:
        "Move to the next research phase (gather -> analyze -> respond)",
      execute: (_args, ctx) => {
        const state = ctx.state;
        if (state.phase === "gather") {
          state.phase = "analyze";
        } else if (state.phase === "analyze") {
          state.phase = "respond";
        }
        return { phase: state.phase };
      },
    },

    // Feature 2: ctx.messages — access conversation history in tools
    analyze: defineTool<z.ZodObject<{ focus: z.ZodString }>, ResearchState>({
      description:
        "Analyze all gathered sources and conversation context to form a conclusion",
      parameters: z.object({
        focus: z.string().describe("What aspect to focus the analysis on"),
      }),
      execute: ({ focus }, ctx) => {
        const state = ctx.state;
        // Use ctx.messages to see what's been discussed
        const userMessages = ctx.messages.filter((m) => m.role === "user");
        return {
          focus,
          sources: state.sources,
          conversationTurns: userMessages.length,
          totalMessages: ctx.messages.length,
          phase: state.phase,
        };
      },
    }),

    conversation_summary: {
      description: "Get a summary of the conversation so far",
      execute: (_args, ctx) => {
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
    },
  },
});
