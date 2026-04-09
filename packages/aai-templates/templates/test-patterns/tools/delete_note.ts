export const description = "Delete a note from persistent KV storage";

export const parameters = {
  type: "object",
  properties: {
    key: { type: "string" },
  },
  required: ["key"],
};

export default async function execute(
  args: { key: string },
  ctx: {
    kv: { delete: (key: string) => Promise<void> };
  },
) {
  await ctx.kv.delete(`note:${args.key}`);
  return { deleted: true, key: args.key };
}
