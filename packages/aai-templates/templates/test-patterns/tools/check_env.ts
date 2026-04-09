export default async function execute(
  _args: unknown,
  ctx: { env: Record<string, string | undefined> },
) {
  return {
    hasApiKey: ctx.env.API_KEY !== undefined,
    keyPreview: ctx.env.API_KEY?.slice(0, 4) ?? "none",
  };
}
