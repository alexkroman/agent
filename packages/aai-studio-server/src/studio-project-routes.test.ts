// Copyright 2026 the AAI authors. MIT license.
/**
 * The project document's own routes (studio-project-routes.ts), exercised
 * through the full orchestrator: create/list/read, the two file routes, the
 * delete cascade, and `aai push`'s `PUT …/source`.
 *
 * Split from studio-routes.test.ts alongside the source split, and for the
 * same reason — both files were at the length cap. What stays there is the
 * machinery around the document (page + routing order, auth, chat history,
 * deploy, sessions); the response CONTRACT for all of it is
 * studio-routes-contract.test.ts, and the shared fakes are in
 * _studio-routes-test-utils.ts.
 */

import { authFetch, deployAgent, type TestFetch } from "aai-server/test-utils";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createFakedCombined,
  createProject,
  refreshSessionMock,
  schedulePreviewMock,
} from "./_studio-routes-test-utils.ts";
import { mutateWorkspace, studioScope } from "./studio-workspace.ts";

// `createFakedCombined` injects the same fakes as studio-routes.test.ts: no
// bundler, no sandbox, no preview deploy runs here.
describe("project CRUD", () => {
  let fetch: TestFetch;
  beforeEach(async () => {
    ({ fetch } = await createFakedCombined());
  });

  test("create starts an EMPTY project", async () => {
    // No starter agent: the coding agent's first turn goes into the user's
    // agent rather than into dismantling a dice roller.
    const res = await authFetch(fetch, "/studio/projects", { body: { kind: "agent" } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { files: Record<string, string> };
    expect(Object.keys(body.files)).toEqual([]);
  });

  test("create stamps the project's kind", async () => {
    // The kind selects the coding agent's system prompt at every later session
    // install, so it is stored on the workspace rather than held per request.
    const created = await authFetch(fetch, "/studio/projects", { body: { kind: "workflow" } });
    expect(created.status).toBe(201);
    const { name, kind } = (await created.json()) as { name: string; kind?: string };
    expect(kind).toBe("workflow");
    const read = await authFetch(fetch, `/studio/projects/${name}`, { method: "GET" });
    expect((await read.json()) as { kind?: string }).toMatchObject({ kind: "workflow" });
  });

  test("a first push, which has no switcher to ask, creates a voice agent", async () => {
    await createProject(fetch, "voice");
    const plain = await authFetch(fetch, "/studio/projects/voice", { method: "GET" });
    expect((await plain.json()) as { kind?: string }).toMatchObject({ kind: "agent" });
  });

  test.each([
    ["a kind that is not one of the two", { kind: "phone" }],
    ["no kind at all", {}],
    // The caller does not name the project: the server generates it.
    ["a name", { name: "mine", kind: "agent" }],
  ])("create rejects %s", async (_label, body) => {
    // An unknown kind would otherwise be stamped and select no prompt — a
    // request that looks accepted and does the opposite of what it asked for.
    const res = await authFetch(fetch, "/studio/projects", { body });
    expect(res.status).toBe(400);
  });

  test("create with a prompt generates a v0-style name (base + suffix)", async () => {
    // The chat-first flow: the client sends the first message, the SERVER
    // names the project — same generator as slugless CLI deploys.
    const res = await authFetch(fetch, "/studio/projects", {
      body: { prompt: "Build me a contact form agent for my site", kind: "agent" },
    });
    expect(res.status).toBe(201);
    const { name } = (await res.json()) as { name: string };
    expect(name).toMatch(/^contact-form(-[a-z0-9-]+)?-[a-z0-9]{6}$/);
    // Addressable like any other project.
    expect((await authFetch(fetch, `/studio/projects/${name}`, { method: "GET" })).status).toBe(
      200,
    );
  });

  test("create with the same prompt twice yields two distinct projects", async () => {
    const make = async () => {
      const res = await authFetch(fetch, "/studio/projects", {
        body: { prompt: "pizza ordering", kind: "agent" },
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { name: string }).name;
    };
    expect(await make()).not.toBe(await make());
  });

  test("create with no prompt still generates a name", async () => {
    const res = await authFetch(fetch, "/studio/projects", { body: { kind: "agent" } });
    expect(res.status).toBe(201);
    const { name } = (await res.json()) as { name: string };
    expect(name).toMatch(/-[a-z0-9]{6}$/);
  });

  test("get returns the project's files; 404 when missing", async () => {
    await createProject(fetch);
    await authFetch(fetch, "/studio/projects/proj/file", {
      method: "PUT",
      body: { path: "agent.ts", content: "export default {};" },
    });
    const res = await authFetch(fetch, "/studio/projects/proj", { method: "GET" });
    expect(res.status).toBe(200);
    expect(Object.keys(((await res.json()) as { files: Record<string, string> }).files)).toContain(
      "agent.ts",
    );
    expect((await authFetch(fetch, "/studio/projects/ghost", { method: "GET" })).status).toBe(404);
  });

  test("file write, delete, and delete-missing behave", async () => {
    schedulePreviewMock.mockClear();
    await createProject(fetch);
    const put = await authFetch(fetch, "/studio/projects/proj/file", {
      method: "PUT",
      body: { path: "extra.ts", content: "export {};" },
    });
    expect(put.status).toBe(200);
    // A manual save is a settled edit — it schedules an auto preview deploy
    // with the caller's key and the public origin the guest's CLI dials.
    expect(schedulePreviewMock).toHaveBeenCalledWith(
      studioScope("key1"),
      "proj",
      expect.objectContaining({ apiKey: "key1", serverUrl: expect.stringMatching(/^https?:/) }),
    );
    const files = (
      (await (await authFetch(fetch, "/studio/projects/proj", { method: "GET" })).json()) as {
        files: Record<string, string>;
      }
    ).files;
    expect(files["extra.ts"]).toBe("export {};");

    schedulePreviewMock.mockClear();
    const del = await authFetch(fetch, "/studio/projects/proj/file?path=extra.ts", {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(schedulePreviewMock).toHaveBeenCalledTimes(1);
    schedulePreviewMock.mockClear();
    expect(
      (await authFetch(fetch, "/studio/projects/proj/file?path=extra.ts", { method: "DELETE" }))
        .status,
    ).toBe(404);
    // A rejected delete is not an edit — nothing to preview.
    expect(schedulePreviewMock).not.toHaveBeenCalled();
    expect(
      (await authFetch(fetch, "/studio/projects/proj/file", { method: "DELETE" })).status,
    ).toBe(400);
  });

  test("concurrent file writes both survive", async () => {
    await createProject(fetch);
    const put = (path: string, content: string) =>
      authFetch(fetch, "/studio/projects/proj/file", { method: "PUT", body: { path, content } });
    await Promise.all([put("a.ts", "a"), put("b.ts", "b")]);
    const { files } = (await (
      await authFetch(fetch, "/studio/projects/proj", { method: "GET" })
    ).json()) as { files: Record<string, string> };
    expect(files["a.ts"]).toBe("a");
    expect(files["b.ts"]).toBe("b");
  });

  test("file write rejects traversal paths", async () => {
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/projects/proj/file", {
      method: "PUT",
      body: { path: "../evil.ts", content: "x" },
    });
    expect(res.status).toBe(400);
  });

  test("a file DELETE addresses the normalized path, and refuses an unusable one", async () => {
    // The PUT body normalizes through `SafePathSchema`, so the stored key is
    // `agent.ts`; a delete spelling it `./agent.ts` names the same file and
    // must not 404 against a key nothing can hold.
    await createProject(fetch);
    await authFetch(fetch, "/studio/projects/proj/file", {
      method: "PUT",
      body: { path: "tools/x.ts", content: "export {};" },
    });
    const del = await authFetch(fetch, "/studio/projects/proj/file?path=./tools/x.ts", {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    // A path that cannot normalize is "no such file" — this route's only
    // other answer, and never a 500.
    expect(
      (await authFetch(fetch, "/studio/projects/proj/file?path=../evil.ts", { method: "DELETE" }))
        .status,
    ).toBe(404);
  });

  test("delete project removes it from the list", async () => {
    await createProject(fetch);
    await authFetch(fetch, "/studio/projects/proj", { method: "DELETE" });
    const list = (await (await authFetch(fetch, "/studio/projects", { method: "GET" })).json()) as {
      projects: string[];
    };
    expect(list.projects).toEqual([]);
  });

  test("delete project cascades to BOTH of its deployed agents", async () => {
    const combined = await createFakedCombined();
    // The two agents Publish and the preview auto-deploy would have created.
    // Neither is named `*-preview` here: `POST /deploy` REFUSES that suffix
    // (only the studio's own preview deployer may claim it), so deploying one
    // through this route silently 400s and leaves nothing to cascade to —
    // which is how this assertion passed vacuously for a while.
    await deployAgent(combined.fetch, "proj", "key1");
    await deployAgent(combined.fetch, "proj-pv", "key1");
    expect(await combined.store.getAgent("proj")).not.toBeNull();
    expect(await combined.store.getAgent("proj-pv")).not.toBeNull();

    await createProject(combined.fetch);
    // Stamp the deploy metadata the way Publish/preview do.
    await mutateWorkspace(combined.workspaces, studioScope("key1"), "proj", (current) => ({
      ...current,
      deployedSlug: "proj",
      previewSlug: "proj-pv",
    }));

    const res = await authFetch(combined.fetch, "/studio/projects/proj", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await combined.store.getAgent("proj")).toBeNull();
    expect(await combined.store.getAgent("proj-pv")).toBeNull();
  });

  test("delete project spares a slug the caller does not own", async () => {
    const combined = await createFakedCombined();
    // A workspace naming someone else's slug — however it got there — must not
    // become a deletion oracle. Ownership is the agents row's credential
    // hash, never project scope alone.
    await deployAgent(combined.fetch, "someone-elses", "key2");
    await createProject(combined.fetch);
    await mutateWorkspace(combined.workspaces, studioScope("key1"), "proj", (current) => ({
      ...current,
      deployedSlug: "someone-elses",
    }));

    const res = await authFetch(combined.fetch, "/studio/projects/proj", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await combined.store.getAgent("someone-elses")).not.toBeNull();
  });

  // The `aai push` surface; fast-forward/no-op/metadata semantics are unit
  // tested in studio-workspace.test.ts — this covers the route wiring.
  test("source sync: first push creates, stale baseHash 409s, no-op skips preview", async () => {
    schedulePreviewMock.mockClear();
    refreshSessionMock.mockClear();
    const push = (body: unknown) =>
      authFetch(fetch, "/studio/projects/pushed/source", { method: "PUT", body });
    const created = await push({ files: { "agent.ts": "export {};" } });
    expect(created.status).toBe(201);
    const { sourceHash } = (await created.json()) as { sourceHash: string };
    expect(schedulePreviewMock).toHaveBeenCalledTimes(1);
    // A push edits the workspace from OUTSIDE the studio, so the project's
    // live coding-agent sandbox has to be re-installed with the pushed tree —
    // otherwise its next end-of-turn sync writes the pre-push files back.
    expect(refreshSessionMock).toHaveBeenCalledWith(studioScope("key1"), "pushed", "key1");
    // GET returns the same fast-forward token the push did.
    const got = (await (
      await authFetch(fetch, "/studio/projects/pushed", { method: "GET" })
    ).json()) as { files: Record<string, string>; sourceHash: string };
    expect(got.sourceHash).toBe(sourceHash);
    expect(got.files["agent.ts"]).toBe("export {};");

    // Identical files: accepted, but nothing changed — no preview churn, and
    // no reason to reinstall a session already holding these exact files.
    schedulePreviewMock.mockClear();
    refreshSessionMock.mockClear();
    const noop = await push({ files: { "agent.ts": "export {};" }, baseHash: sourceHash });
    expect(noop.status).toBe(200);
    expect(schedulePreviewMock).not.toHaveBeenCalled();
    expect(refreshSessionMock).not.toHaveBeenCalled();

    // A stale token (the studio edited since the pull) is a 409, not a stomp.
    const stale = await push({ files: { "agent.ts": "changed" }, baseHash: "not-the-hash" });
    expect(stale.status).toBe(409);
    // The current token fast-forwards.
    expect((await push({ files: { "agent.ts": "changed" }, baseHash: sourceHash })).status).toBe(
      200,
    );
  });

  test("source sync rejects reserved names and traversal paths", async () => {
    expect(
      (
        await authFetch(fetch, "/studio/projects/studio/source", {
          method: "PUT",
          body: { files: {} },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await authFetch(fetch, "/studio/projects/proj2/source", {
          method: "PUT",
          body: { files: { "../evil.ts": "x" } },
        })
      ).status,
    ).toBe(400);
  });
});
