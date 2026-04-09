export const description = "Get a summary of the conversation so far";

export default async function execute(
  _args: Record<string, never>,
  ctx: { messages: { role: string }[] },
) {
  const msgs = ctx.messages;
  return {
    totalMessages: msgs.length,
    byRole: {
      user: msgs.filter((m) => m.role === "user").length,
      assistant: msgs.filter((m) => m.role === "assistant").length,
      tool: msgs.filter((m) => m.role === "tool").length,
    },
  };
}
