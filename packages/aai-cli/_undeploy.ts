// Copyright 2025 the AAI authors. MIT license.

export type UndeployOpts = {
  url: string;
  slug: string;
  apiKey: string;
  /** Optional fetch implementation for testing. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
};

export async function runUndeploy(opts: UndeployOpts): Promise<void> {
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);

  let resp: Response;
  try {
    resp = await fetchFn(`${opts.url}/${opts.slug}/undeploy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
      },
    });
  } catch (err: unknown) {
    const hint = opts.url.startsWith("http://localhost")
      ? "Is the local dev server running? Start it with `aai dev`."
      : "Check your network connection and verify the server URL is correct.";
    throw new Error(`undeploy failed: could not reach ${opts.url}\n  ${hint}`, { cause: err });
  }

  if (resp.ok) return;

  const text = await resp.text();

  let hint = "";
  if (resp.status === 401) {
    hint =
      "Your API key may be invalid. Check ~/.config/aai/config.json or set ASSEMBLYAI_API_KEY.";
  } else if (resp.status === 404) {
    hint = "The agent may not be deployed. Check `.aai/project.json` for the correct slug.";
  }
  throw new Error(`undeploy failed (HTTP ${resp.status}): ${text}${hint ? `\n  ${hint}` : ""}`);
}
