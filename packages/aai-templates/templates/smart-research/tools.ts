type ResearchState = {
  phase: "gather" | "analyze" | "respond";
  sources: string[];
  complexity: "simple" | "deep";
};

export default {
  state: (): ResearchState => ({
    phase: "gather",
    sources: [],
    complexity: "simple",
  }),

  tools: {
    save_source: {
      description:
        "Save a source URL found during research for later analysis",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The source URL" },
          title: { type: "string", description: "Brief title or description" },
        },
        required: ["url", "title"],
      },
      execute: (args: Record<string, unknown>, ctx: ToolContext<ResearchState>) => {
        const url = args.url as string;
        const title = args.title as string;
        ctx.state.sources.push(`${title}: ${url}`);
        return { saved: true, totalSources: ctx.state.sources.length };
      },
    },

    mark_complex: {
      description:
        "Mark this research query as complex, allowing more search steps",
      execute: (_args: Record<string, unknown>, ctx: ToolContext<ResearchState>) => {
        ctx.state.complexity = "deep";
        return { complexity: "deep", maxSteps: 10 };
      },
    },

    advance_phase: {
      description:
        "Move to the next research phase (gather -> analyze -> respond)",
      execute: (_args: Record<string, unknown>, ctx: ToolContext<ResearchState>) => {
        if (ctx.state.phase === "gather") {
          ctx.state.phase = "analyze";
        } else if (ctx.state.phase === "analyze") {
          ctx.state.phase = "respond";
        }
        return { phase: ctx.state.phase };
      },
    },

    analyze: {
      description:
        "Analyze all gathered sources and conversation context to form a conclusion",
      parameters: {
        type: "object",
        properties: {
          focus: {
            type: "string",
            description: "What aspect to focus the analysis on",
          },
        },
        required: ["focus"],
      },
      execute: (args: Record<string, unknown>, ctx: ToolContext<ResearchState>) => {
        const focus = args.focus as string;
        const userMessages = ctx.messages.filter((m) => m.role === "user");
        return {
          focus,
          sources: ctx.state.sources,
          conversationTurns: userMessages.length,
          totalMessages: ctx.messages.length,
          phase: ctx.state.phase,
        };
      },
    },

    conversation_summary: {
      description: "Get a summary of the conversation so far",
      execute: (_args: Record<string, unknown>, ctx: ToolContext<ResearchState>) => {
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
} satisfies AgentTools<ResearchState>;
