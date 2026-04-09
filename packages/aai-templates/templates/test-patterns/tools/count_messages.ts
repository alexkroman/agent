export default async function execute(_args: unknown, ctx: { messages: { role: string }[] }) {
  const byRole: Record<string, number> = {};
  for (const msg of ctx.messages) {
    byRole[msg.role] = (byRole[msg.role] ?? 0) + 1;
  }
  return { total: ctx.messages.length, byRole };
}
