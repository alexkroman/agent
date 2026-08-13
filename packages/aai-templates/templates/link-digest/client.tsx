// Copyright 2026 the AAI authors. MIT license.
/**
 * The browser half of a workflow app.
 *
 * Mounted with `page()` rather than `client()`: there is no session to build, so
 * there is no socket, no audio graph, and no microphone request. Everything else
 * is the same — the same `client.tsx` filename, React, Tailwind, and the same
 * theme tokens the voice components read.
 *
 * What replaces `useSession()` is two things: `createWorkflowApi()` to start a
 * run, and `useWorkflowRun()` to watch it. The API is durable, so the `runId` is
 * the whole state — it survives a reload, a different device, or `curl`.
 */

import { createWorkflowApi, page, useWorkflowRun } from "@alexkroman1/aai-ui";
import "@alexkroman1/aai-ui/styles.css";
// ERASED at build time, so naming the agent's own type costs the browser bundle
// nothing — and it is what stops this file restating a shape `workflows/
// digest.ts` already declares.
import type { WorkflowOutputOf } from "@alexkroman1/aai";
// The one runtime import from the SDK a browser bundle wants: `/utils` is the
// zod-free subpath, so it costs a few hundred bytes rather than the root
// barrel's module graph.
import { errorMessage } from "@alexkroman1/aai/utils";
import { useState } from "react";
import type { digest } from "./agent.ts";

/** What a completed run reports, derived from the workflow rather than restated. */
type Digest = WorkflowOutputOf<typeof digest>;

/**
 * Hoisted out of the component deliberately.
 *
 * `useWorkflowRun` holds the client in a ref precisely so a fresh object per
 * render cannot restart its watch, but building one in render is still a new
 * `fetch` closure every time and reads as though it were free.
 */
const api = createWorkflowApi();

export function App() {
  const [url, setUrl] = useState("");
  const [runId, setRunId] = useState<string>();
  const [error, setError] = useState<string>();
  // The generic is what makes `run.status === "completed"` narrow to a TYPED
  // `run.output` instead of `unknown`.
  const { run, polling } = useWorkflowRun<Digest>(runId, { api });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);
    try {
      // Resolves as soon as the run exists — deliberately not when it finishes.
      // That is the whole mechanism: the digest sleeps for a while, and this
      // page is free to be closed in the meantime.
      setRunId(await api.start("digest", { url }));
    } catch (err) {
      // The agent's own sentence: an input failing the workflow's schema names
      // the issue, which is better copy than anything this page could write.
      setError(errorMessage(err));
    }
  };

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <h1 className="text-2xl font-medium">Link Digest</h1>

      <form onSubmit={submit} className="flex gap-2">
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/article"
          className="flex-1 rounded-md border px-3 py-2"
        />
        <button type="submit" disabled={polling} className="rounded-md border px-4 py-2">
          {polling ? "Working…" : "Digest"}
        </button>
      </form>

      {error !== undefined && <p className="text-red-600">{error}</p>}

      {/* A run that has not settled says so. `polling` is not derivable from the
          snapshot alone — an id the agent never knew leaves `run` undefined,
          which would otherwise read as "still waiting" forever. */}
      {polling && <p>Reading the link. You can close this tab — the run continues.</p>}

      {run?.status === "failed" && <p className="text-red-600">That one failed: {run.error}</p>}

      {run?.status === "completed" && (
        <article className="flex flex-col gap-3">
          <h2 className="text-xl">{run.output.headline}</h2>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {run.output.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <p className="text-sm opacity-70">Filed {run.output.filedAt}</p>
        </article>
      )}
    </main>
  );
}

page({ name: "Link Digest", component: App });
