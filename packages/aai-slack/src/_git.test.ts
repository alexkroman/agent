import { beforeEach, describe, expect, test, vi } from "vitest";

const mockPull = vi.fn().mockResolvedValue(undefined);
const mockClone = vi.fn().mockResolvedValue(undefined);
const mockAdd = vi.fn().mockResolvedValue(undefined);
const mockStatus = vi.fn();
const mockCommit = vi.fn().mockResolvedValue(undefined);
const mockPush = vi.fn().mockResolvedValue(undefined);

vi.mock("simple-git", () => ({
  default: vi.fn(() => ({
    pull: mockPull,
    clone: mockClone,
    add: mockAdd,
    status: mockStatus,
    commit: mockCommit,
    push: mockPush,
  })),
}));

vi.mock("node:fs", () => ({
  default: { existsSync: vi.fn() },
}));

import fs from "node:fs";
import { commitAndPush, ensureRepo } from "./_git.ts";

beforeEach(() => {
  mockPull.mockClear();
  mockClone.mockClear();
  mockAdd.mockClear();
  mockStatus.mockReset();
  mockCommit.mockClear();
  mockPush.mockClear();
});

describe("ensureRepo", () => {
  test("pulls when repo exists", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    await ensureRepo("/tmp/examples");
    expect(mockPull).toHaveBeenCalledWith("origin", "main");
  });

  test("clones when repo does not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    await ensureRepo("/tmp/examples");
    expect(mockClone).toHaveBeenCalledWith(
      "git@github.com:alexkroman/examples.git",
      "/tmp/examples",
    );
  });
});

describe("commitAndPush", () => {
  test("adds, commits, and pushes when there are staged files", async () => {
    mockStatus.mockResolvedValue({ staged: ["agent.ts"] });

    await commitAndPush("/tmp/examples", "my-app", "Create my-app");

    expect(mockAdd).toHaveBeenCalledWith("my-app/.");
    expect(mockCommit).toHaveBeenCalledWith("Create my-app");
    expect(mockPush).toHaveBeenCalledWith("origin", "main");
  });

  test("skips commit and push when nothing staged", async () => {
    mockStatus.mockResolvedValue({ staged: [] });

    await commitAndPush("/tmp/examples", "my-app", "Update my-app");

    expect(mockAdd).toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
