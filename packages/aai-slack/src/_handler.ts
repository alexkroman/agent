import fs from "node:fs";
import path from "node:path";
import type { WebClient } from "@slack/web-api";
import { generateCode } from "./_claude.ts";
import type { Config } from "./_config.ts";
import { deploy, initProject } from "./_deploy.ts";
import { commitAndPush, ensureRepo } from "./_git.ts";
import type { ThreadState } from "./_state.ts";
import { getOrCreateThread, hasThread, setSessionId } from "./_state.ts";
import type { StatusUpdater } from "./_status.ts";
import { createStatus } from "./_status.ts";

const GITHUB_BASE = "https://github.com/alexkroman/examples/tree/main";

type MessageEvent = {
  text?: string;
  channel: string;
  channel_type?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
};

/** Strip `<@U12345>` mention tags so Claude gets a clean prompt. */
function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

async function processMessage(
  config: Config,
  thread: ThreadState,
  appDir: string,
  userText: string,
  threadTs: string,
  status: StatusUpdater,
): Promise<string> {
  await ensureRepo(config.examplesRepoPath);

  if (thread.isNew) {
    await status.update("Scaffolding project...");
    fs.mkdirSync(appDir, { recursive: true });
    await initProject(appDir);
  }

  await status.update("Generating agent code...");
  const { sessionId } = await generateCode({
    prompt: userText,
    workDir: appDir,
    ...(thread.sessionId ? { sessionId: thread.sessionId } : {}),
  });
  setSessionId(threadTs, sessionId);

  await status.update("Deploying...");
  const deployedUrl = await deploy({
    workDir: appDir,
    assemblyaiApiKey: config.assemblyaiApiKey,
  });

  await status.update("Saving to GitHub...");
  const commitMsg = thread.isNew ? `Create ${thread.slug}` : `Update ${thread.slug}`;
  await commitAndPush(config.examplesRepoPath, thread.slug, commitMsg);

  return deployedUrl;
}

async function handleEvent(config: Config, event: MessageEvent, client: WebClient): Promise<void> {
  const threadTs = event.thread_ts ?? event.ts;
  const thread = getOrCreateThread(threadTs);
  const appDir = path.join(config.examplesRepoPath, thread.slug);
  const githubUrl = `${GITHUB_BASE}/${thread.slug}`;

  const prompt = stripMentions(event.text ?? "");
  if (!prompt) return;

  const status = await createStatus(client, event.channel, threadTs, "Setting up...");

  try {
    const deployedUrl = await processMessage(config, thread, appDir, prompt, threadTs, status);
    await status.update(`Your agent is live: ${deployedUrl}\nCode: ${githubUrl}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await status.update(`Failed: ${msg}`);
  }
}

export function createMessageHandler(config: Config) {
  return ({ event, client }: { event: MessageEvent; client: WebClient }) => {
    if (event.bot_id || event.subtype || !event.text) return;

    const isDM = event.channel_type === "im";
    const isMention = /<@[A-Z0-9]+>/.test(event.text);
    const isThreadReply = Boolean(event.thread_ts);
    const isKnownThread = isThreadReply && event.thread_ts && hasThread(event.thread_ts);

    if (!(isDM || isMention || isKnownThread)) return;

    // Fire and forget — don't block the event loop so multiple requests run concurrently.
    // Errors are caught inside handleEvent and reported via Slack status message.
    void handleEvent(config, event, client);
  };
}
