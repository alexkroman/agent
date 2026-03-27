import fs from "node:fs";
import simpleGit from "simple-git";

const REPO_URL = "git@github.com:alexkroman/examples.git";

export async function ensureRepo(repoPath: string): Promise<void> {
  if (fs.existsSync(repoPath)) {
    const git = simpleGit(repoPath);
    await git.pull("origin", "main");
  } else {
    await simpleGit().clone(REPO_URL, repoPath);
  }
}

export async function commitAndPush(
  repoPath: string,
  slug: string,
  message: string,
): Promise<void> {
  const git = simpleGit(repoPath);
  await git.add(`${slug}/.`);
  const status = await git.status();
  if (status.staged.length === 0) return;
  await git.commit(message);
  await git.push("origin", "main");
}
