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
