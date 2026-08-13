// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:workflow` epoch 5.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why this package's own
 * imports are relative.
 *
 * Epoch 5 moved the REQUESTS into the SDK. `WorkflowApi` is no longer declared
 * here — it is re-exported from `@alexkroman1/aai/workflow-api`, and
 * `createWorkflowApi` is a wrapper that supplies the one thing a browser owns,
 * the page's own base URL. No name was added or removed, so epochs 1-4 all still
 * compile beside this one; what they could not express is what epoch 5 made
 * TRUE.
 *
 * What it made true is interchangeability: a client built by the SDK factory is
 * the same type as one built here, so a page can accept either — a `baseUrl`
 * pointing at another agent, a bearer-carrying client for a token-protected one,
 * a `timeoutMs` for a console that must not hang — without the structural cast
 * two independently-declared types would have needed.
 *
 * The SDK is reached by its PACKAGE specifier, as every other module here reaches
 * it: a relative hop into a sibling package is a `TS6059` under the build config
 * and a `noRestrictedImports` failure under Biome, and in dev the specifier
 * resolves to that package's source anyway.
 */

import { createWorkflowApiClient } from "@alexkroman1/aai/workflow-api";
import {
  createWorkflowApi,
  type UseWorkflowProgressResult,
  type UseWorkflowRunResult,
  useWorkflowProgress,
  useWorkflowRun,
  type WorkflowApi,
} from "../../../index.ts";

type Digest = { headline: string };

/** The browser wrapper: `location` is the default base URL, hence no `baseUrl`. */
const own: WorkflowApi = createWorkflowApi();

/**
 * The SDK factory, which requires one — and satisfies the same type.
 *
 * This assignment IS the epoch-5 property. Through epoch 4 the two were
 * structurally similar and nominally unrelated, so a page holding one and a hook
 * expecting the other had no supported way to say so.
 */
const remote: WorkflowApi = createWorkflowApiClient({
  baseUrl: "https://agents.example/other-agent",
  token: "s3cret",
  timeoutMs: 30_000,
});

/** So a component can take either, which is the point of them being one type. */
export function Watcher({
  runId,
  api = own,
}: {
  // `| undefined` explicitly, so a caller may FORWARD an optional id — under
  // `exactOptionalPropertyTypes` a bare `runId?: string` refuses one.
  runId?: string | undefined;
  api?: WorkflowApi;
}) {
  const result: UseWorkflowRunResult<Digest> = useWorkflowRun<Digest>(runId, { api });
  const progress: UseWorkflowProgressResult = useWorkflowProgress(runId, { api });
  if (result.error !== undefined) return <p>{result.error}</p>;
  if (result.run?.status === "completed") return <p>{result.run.output.headline}</p>;
  if (!progress.supported) return <p>{result.polling ? "working…" : "idle"}</p>;
  return <p>{progress.latest ?? (progress.streaming ? "working…" : "idle")}</p>;
}

export function Remote({ runId }: { runId?: string | undefined }) {
  return <Watcher runId={runId} api={remote} />;
}
