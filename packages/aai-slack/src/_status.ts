import type { WebClient } from "@slack/web-api";

export type StatusUpdater = {
  update: (text: string) => Promise<void>;
};

export async function createStatus(
  client: WebClient,
  channel: string,
  threadTs: string,
  initialText: string,
): Promise<StatusUpdater> {
  const result = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: initialText,
  });
  const messageTs = result.ts ?? "";

  return {
    async update(text: string) {
      await client.chat.update({ channel, ts: messageTs, text });
    },
  };
}
