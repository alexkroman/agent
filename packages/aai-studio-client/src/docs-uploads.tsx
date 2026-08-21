// Copyright 2026 the AAI authors. MIT license.
// The API pane's upload section: how a caller actually gets a file into this
// agent.
//
// **The routes were on the page before the calls were.** The workflow route
// table has listed `POST /workflows/uploads` and its three siblings since the
// pane existed, and every generated run body for an upload-carrying workflow
// carried an id — but the only worked example of OBTAINING one was the
// `agent.upload(file)` line inside the SDK start snippet. A reader in a shell,
// or anyone reading the run body to find out what the field wants, was told the
// property takes an upload id and left to reverse-engineer the route that mints
// one from a summary line. That is the gap this card closes: the page documents
// an API for doing the upload, in both languages, beside the API for using it.
//
// **Three shapes, because the ORDER is the interesting part.** One call that
// sends the file and answers with the id (what almost everyone wants); the
// caller-named id that lets a run start while the bytes are still on the wire;
// and the read that says how much has landed. The routes are the same for every
// agent, so nothing here would be wrong for one — but the second shape needs a
// real workflow name and a real property to put the id in, which is why the card
// is generated from the agent's own listing rather than written, exactly as the
// run examples beside it are.
//
// **It renders only for an agent some workflow of which declares an upload.**
// The routes exist regardless, and documenting a file upload to a project with
// nothing to upload TO is a page teaching a call nobody there can make — the
// same judgement that keeps the workflow route table off a voice agent.

import type { WorkflowSummary } from "@alexkroman1/aai";
import { uploadingWorkflow } from "./docs-content.ts";
import { Examples } from "./docs-examples.tsx";
import {
  curlUpload,
  curlUploadInfo,
  curlUploadStream,
  sdkUpload,
  sdkUploadInfo,
  sdkUploadStream,
} from "./docs-snippets.ts";
import { Card } from "./settings-card.tsx";

/**
 * The upload card, or nothing.
 *
 * `undefined` from {@link uploadingWorkflow} is the whole gate: no declared
 * workflow takes a file, so there is no property for an id to go in and no card
 * to render.
 */
export function UploadApi({
  base,
  token,
  declared,
}: {
  base: string;
  token: boolean;
  /** The agent's own listing, as `GET /workflows` served it. */
  declared: readonly WorkflowSummary[];
}) {
  const example = uploadingWorkflow(declared);
  if (example === undefined) return null;
  return (
    <Card title="Sending a file" blurb={uploadBlurb(example.workflow, example.property)}>
      <div className="flex flex-col gap-4">
        <Examples
          code={sdkUpload(base, token)}
          label="upload a file"
          alternates={[{ language: "curl", code: curlUpload(base, token) }]}
        />
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <span className="text-[11px] text-muted">
            Or start the run first, on an id you choose, and send the bytes into it — the run reads
            what has arrived rather than waiting for the last byte.
          </span>
          <Examples
            code={sdkUploadStream(base, example.workflow, token)}
            label="start a run, then stream the file into it"
            alternates={[
              { language: "curl", code: curlUploadStream(base, example.workflow, token) },
            ]}
          />
        </div>
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <span className="text-[11px] text-muted">
            How much of an upload has landed. The size it reports is the contiguous prefix a step
            can read, not the count of bytes received — parts arrive out of order.
          </span>
          <Examples
            code={sdkUploadInfo(base, token)}
            label="read an upload's progress"
            alternates={[{ language: "curl", code: curlUploadInfo(base, token) }]}
          />
        </div>
      </div>
    </Card>
  );
}

/**
 * Why an upload exists at all, said in terms of THIS agent's own workflow.
 *
 * The general rule (a run's input is journaled and replayed, so bytes may not
 * travel in it) is the answer to the question a reader arrives with — "why can I
 * not just put the file in the run body" — and naming the property they are
 * looking at is what connects the rule to the field in front of them.
 */
function uploadBlurb(workflow: WorkflowSummary, property: string): string {
  return (
    `${workflow.name} takes a file: its ${property} property carries an upload id rather than ` +
    "the bytes, because a run's input is journaled and replayed on every resume. The bytes go " +
    "in once through the client SDK's upload calls below, and the run carries the handle. Up " +
    "to 2 GiB by default."
  );
}
