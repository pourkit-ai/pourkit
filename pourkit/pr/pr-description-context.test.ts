import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import {
  collectFinalizerContext,
  buildFinalizerPrompt,
  type FinalizerContext,
} from "./pr-description-context";
const { execCaptureMock } = vi.hoisted(() => ({
  execCaptureMock: vi.fn(),
}));

vi.mock("../shared/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/common")>();
  return {
    ...actual,
    execCapture: execCaptureMock,
  };
});

const TEST_DIR = "/tmp/pourkit-finalizer-context-test";
const WORKTREE_PATH = join(TEST_DIR, "worktree");
const REVIEW_ARTIFACT_PATH = join(
  WORKTREE_PATH,
  "pourkit",
  ".tmp",
  "reviewers",
  "iteration-1.md"
);

function makeLogger() {
  return {
    line: vi.fn(),
    raw: vi.fn(),
    step: vi.fn(),
    status: vi.fn(),
    kv: vi.fn(),
    close: vi.fn(),
  };
}

describe("collectFinalizerContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(join(REVIEW_ARTIFACT_PATH, ".."), { recursive: true });
    mkdirSync(WORKTREE_PATH, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it("collects context with non-empty commit range", async () => {
    execCaptureMock.mockResolvedValue({
      code: 0,
      stdout: "abc123 fix: implement feature\ndef456 refactor: cleanup\n",
      stderr: "",
    });

    writeFileSync(REVIEW_ARTIFACT_PATH, "<verdict>PASS</verdict>", "utf-8");

    const context = await collectFinalizerContext({
      targetBase: "main",
      branchName: "pourkit/42/test-issue",
      worktreePath: WORKTREE_PATH,
      reviewArtifactPath: REVIEW_ARTIFACT_PATH,
      logger: makeLogger(),
    });

    expect(context.commits).toBe(
      "abc123 fix: implement feature\ndef456 refactor: cleanup"
    );
    expect(context.reviewArtifact).toBe("<verdict>PASS</verdict>");
    expect(context.targetBase).toBe("main");
    expect(context.branchName).toBe("pourkit/42/test-issue");

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      [
        "log",
        "origin/main..pourkit/42/test-issue",
        "--oneline",
        "--no-decorate",
      ],
      expect.objectContaining({ cwd: WORKTREE_PATH })
    );
  });

  it("does not double-prefix an explicit remote target base", async () => {
    execCaptureMock.mockResolvedValue({
      code: 0,
      stdout: "abc123 fix: implement feature\n",
      stderr: "",
    });

    writeFileSync(REVIEW_ARTIFACT_PATH, "<verdict>PASS</verdict>", "utf-8");

    await collectFinalizerContext({
      targetBase: "upstream/main",
      branchName: "pourkit/42/test-issue",
      worktreePath: WORKTREE_PATH,
      reviewArtifactPath: REVIEW_ARTIFACT_PATH,
      logger: makeLogger(),
    });

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      [
        "log",
        "upstream/main..pourkit/42/test-issue",
        "--oneline",
        "--no-decorate",
      ],
      expect.objectContaining({ cwd: WORKTREE_PATH })
    );
  });

  it("handles empty commit range (git log succeeds with no output)", async () => {
    execCaptureMock.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });

    writeFileSync(REVIEW_ARTIFACT_PATH, "<verdict>PASS</verdict>", "utf-8");

    const context = await collectFinalizerContext({
      targetBase: "main",
      branchName: "pourkit/42/test-issue",
      worktreePath: WORKTREE_PATH,
      reviewArtifactPath: REVIEW_ARTIFACT_PATH,
      logger: makeLogger(),
    });

    expect(context.commits).toBe("");
    expect(context.reviewArtifact).toBe("<verdict>PASS</verdict>");
  });

  it("propagates git log execution failure", async () => {
    execCaptureMock.mockRejectedValue(new Error("git: repository not found"));

    writeFileSync(REVIEW_ARTIFACT_PATH, "<verdict>PASS</verdict>", "utf-8");

    await expect(
      collectFinalizerContext({
        targetBase: "main",
        branchName: "pourkit/42/test-issue",
        worktreePath: WORKTREE_PATH,
        reviewArtifactPath: REVIEW_ARTIFACT_PATH,
        logger: makeLogger(),
      })
    ).rejects.toThrow("git: repository not found");
  });

  it("throws on missing review artifact", async () => {
    execCaptureMock.mockResolvedValue({
      code: 0,
      stdout: "abc123 fix: implement feature\n",
      stderr: "",
    });

    await expect(
      collectFinalizerContext({
        targetBase: "main",
        branchName: "pourkit/42/test-issue",
        worktreePath: WORKTREE_PATH,
        reviewArtifactPath: REVIEW_ARTIFACT_PATH,
        logger: makeLogger(),
      })
    ).rejects.toThrow("Review artifact not found");
  });

  it("throws on empty review artifact", async () => {
    execCaptureMock.mockResolvedValue({
      code: 0,
      stdout: "abc123 fix: implement feature\n",
      stderr: "",
    });

    writeFileSync(REVIEW_ARTIFACT_PATH, "   ", "utf-8");

    await expect(
      collectFinalizerContext({
        targetBase: "main",
        branchName: "pourkit/42/test-issue",
        worktreePath: WORKTREE_PATH,
        reviewArtifactPath: REVIEW_ARTIFACT_PATH,
        logger: makeLogger(),
      })
    ).rejects.toThrow("Review artifact at");
    await expect(
      collectFinalizerContext({
        targetBase: "main",
        branchName: "pourkit/42/test-issue",
        worktreePath: WORKTREE_PATH,
        reviewArtifactPath: REVIEW_ARTIFACT_PATH,
        logger: makeLogger(),
      })
    ).rejects.toThrow("is empty");
  });
});

describe("buildFinalizerPrompt", () => {
  it("includes all context fields in the prompt", () => {
    const context: FinalizerContext = {
      commits: "abc123 fix: implement feature\ndef456 refactor: cleanup",
      reviewArtifact: "PASS",
      targetBase: "main",
      branchName: "pourkit/42/test-issue",
    };

    const prompt = buildFinalizerPrompt(context, "Write a PR description.");

    expect(prompt).toContain(".pourkit/.tmp/run-context.md");
    expect(prompt).toContain("main");
    expect(prompt).toContain("pourkit/42/test-issue");
    expect(prompt).toContain("abc123 fix: implement feature");
    expect(prompt).toContain("PASS");
    expect(prompt).toContain("## PR Title");
    expect(prompt).toContain("## PR Body");
    expect(prompt).toContain("## Summary");
    expect(prompt).toContain("## Changes");
    expect(prompt).toContain("final-state wording");
    expect(prompt).toContain(
      "exactly one closing reference for the current Issue"
    );
    expect(prompt).toContain(
      "Never close parent PRDs, sibling Issues, or unrelated Issues"
    );
    expect(prompt).toContain(
      "Omit the closing footer when no Issue is attached"
    );
    expect(prompt).toContain(".pourkit/.tmp/finalizer/agent-output.md");
  });

  it("shows placeholder when commits are empty", () => {
    const context: FinalizerContext = {
      commits: "",
      reviewArtifact: "PASS",
      targetBase: "main",
      branchName: "pourkit/42/test-issue",
    };

    const prompt = buildFinalizerPrompt(context, "Write PR description.");

    expect(prompt).toContain("(no commits in range)");
  });
});
