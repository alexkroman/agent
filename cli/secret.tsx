// Copyright 2025 the AAI authors. MIT license.

import { getApiKey, readProjectConfig, resolveServerUrl } from "./_discover.ts";
import { Detail, runWithInk, Step, StepInfo } from "./_ink.tsx";
import { askPassword } from "./_prompts.tsx";

async function requireProjectConfig(cwd: string) {
  const config = await readProjectConfig(cwd);
  if (!config) {
    throw new Error("No .aai/project.json found — deploy first with `aai deploy`");
  }
  return config;
}

async function getServerInfo(cwd: string) {
  const config = await requireProjectConfig(cwd);
  const apiKey = await getApiKey();
  const serverUrl = resolveServerUrl(undefined, config.serverUrl);
  const slug = config.slug;
  return { serverUrl, slug, apiKey };
}

async function apiFetch(
  cwd: string,
  pathSuffix: string,
  init?: RequestInit,
): Promise<{ resp: Response; slug: string }> {
  const { serverUrl, slug, apiKey } = await getServerInfo(cwd);
  const resp = await fetch(`${serverUrl}/${slug}/secret${pathSuffix}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...init?.headers },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Secret operation failed: ${text}`);
  }
  return { resp, slug };
}

export async function runSecretPut(cwd: string, name: string): Promise<void> {
  const value = await askPassword(`Enter value for ${name}`);
  if (!value) throw new Error("No value provided");

  await runWithInk(async ({ log }) => {
    const { slug } = await apiFetch(cwd, "", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [name]: value }),
    });
    log(<Step action="Set" msg={`${name} for ${slug}`} />);
  });
}

export async function runSecretDelete(cwd: string, name: string): Promise<void> {
  await runWithInk(async ({ log }) => {
    const { slug } = await apiFetch(cwd, `/${name}`, { method: "DELETE" });
    log(<Step action="Deleted" msg={`${name} from ${slug}`} />);
  });
}

export async function runSecretList(cwd: string): Promise<void> {
  await runWithInk(async ({ log }) => {
    const { resp } = await apiFetch(cwd, "");
    const { vars } = await resp.json();
    if (vars.length === 0) {
      log(<StepInfo action="Secrets" msg="none set" />);
    } else {
      for (const name of vars) {
        log(<Detail msg={name} />);
      }
    }
  });
}
