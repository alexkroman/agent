import { execa } from "execa";

export async function initProject(workDir: string): Promise<void> {
  await execa("npx", ["@alexkroman1/aai-cli", "init", "--yes", "--skipDeploy"], {
    cwd: workDir,
    env: { ...process.env },
    stdio: "pipe",
  });
}

export async function deploy(opts: { workDir: string; assemblyaiApiKey: string }): Promise<string> {
  const result = await execa("npx", ["@alexkroman1/aai-cli", "deploy", "-y"], {
    cwd: opts.workDir,
    env: {
      ...process.env,
      ASSEMBLYAI_API_KEY: opts.assemblyaiApiKey,
    },
    stdio: "pipe",
  });

  // The CLI prints "Ready: {url}" on success
  const match = result.stdout.match(/Ready:\s+(https?:\/\/\S+)/);
  if (match?.[1]) return match[1];

  // Fallback: look for any URL in stdout
  const urlMatch = result.stdout.match(/(https?:\/\/\S+)/);
  if (urlMatch?.[1]) return urlMatch[1];

  throw new Error(`Deploy succeeded but could not parse URL from output:\n${result.stdout}`);
}
