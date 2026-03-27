import { App } from "@slack/bolt";
import { loadConfig } from "./_config.ts";
import { ensureRepo } from "./_git.ts";
import { createMessageHandler } from "./_handler.ts";

const config = loadConfig();

// Clone/pull the examples repo at startup so it's ready for the first message
await ensureRepo(config.examplesRepoPath);
console.log(`examples repo ready at ${config.examplesRepoPath}`);

const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
});

const handleMessage = createMessageHandler(config);

// biome-ignore lint/suspicious/noExplicitAny: Bolt event types are complex unions
app.event("message", handleMessage as any);
// biome-ignore lint/suspicious/noExplicitAny: Bolt event types are complex unions
app.event("app_mention", handleMessage as any);

await app.start();
console.log("aai slack bot is running");

function shutdown() {
  app.stop().then(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
