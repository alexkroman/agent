export type Config = {
  slackBotToken: string;
  slackAppToken: string;
  anthropicApiKey: string;
  assemblyaiApiKey: string;
  serverUrl: string;
  examplesRepoPath: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function loadConfig(): Config {
  return {
    slackBotToken: requireEnv("SLACK_BOT_TOKEN"),
    slackAppToken: requireEnv("SLACK_APP_TOKEN"),
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
    assemblyaiApiKey: requireEnv("ASSEMBLYAI_API_KEY"),
    serverUrl: process.env.AAI_SERVER_URL ?? "https://aai-agent.fly.dev",
    examplesRepoPath: process.env.EXAMPLES_REPO_PATH ?? `${process.env.HOME}/.aai-slack/examples`,
  };
}
