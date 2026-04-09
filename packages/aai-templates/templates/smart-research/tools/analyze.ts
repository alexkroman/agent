export const description =
  "Analyze all gathered sources and conversation context to form a conclusion";

export const parameters = {
  type: "object",
  properties: {
    focus: {
      type: "string",
      description: "What aspect to focus the analysis on",
    },
  },
  required: ["focus"],
};

export default async function execute(
  args: { focus: string },
  ctx: {
    kv: { get: <T>(k: string) => Promise<T | undefined> };
    messages: { role: string }[];
  },
) {
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
}
