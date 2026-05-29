import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  assertIssueLabels,
  cleanupResources,
  createE2EIssue,
  createLiveTargetBranch,
  lookupPrByBranch,
  persistResources,
  recoverStaleRuns,
  ScenarioExecutionProvider,
  ScenarioPrProvider,
  runCleanupOnly,
  stateFilePath,
} from "./harness";
import { execCapture } from "../../shared/common";
import type { ExecutionProvider } from "../../execution/execution-provider";
import type { PRProvider } from "../../providers/pr-provider";

vi.mock("../../shared/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/common")>();
  return {
    ...actual,
    execCapture: vi.fn(),
    execJson: vi.fn(),
  };
});

function makeLogger() {
  return {
    step: vi.fn(),
    line: vi.fn(),
    raw: vi.fn(),
    kv: vi.fn(),
    close: vi.fn(),
  };
}

function makeMockClient() {
  const octokit = {
    rest: {
      pulls: {
        get: vi.fn(),
        update: vi.fn(),
        list: vi.fn(),
      },
      issues: {
        create: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        listForRepo: vi.fn(),
      },
    },
    paginate: vi.fn(async (fn: any, options: any) => {
      const result = await fn(options);
      return result.data;
    }),
  } as any;
  return {
    octokit,
    owner: "test-owner",
    repo: "test-repo",
  };
}

describe("live E2E harness", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "pourkit-e2e-harness-"));
    await mkdir(path.join(root, ".pourkit", ".tmp"), { recursive: true });
    vi.resetAllMocks();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("persists run state to the expected file path", async () => {
    await persistResources(root, "run-123", {
      targetBranch: "pourkit-e2e-target/run-123",
      issueNumber: 42,
      prNumber: 99,
    });

    const filePath = stateFilePath(root, "run-123");
    const raw = await readFile(filePath, "utf-8");
    expect(JSON.parse(raw)).toEqual({
      runId: "run-123",
      targetBranch: "pourkit-e2e-target/run-123",
      issueNumber: 42,
      prNumber: 99,
    });
  });

  it("creates a recreated target branch from the configured base branch", async () => {
    vi.mocked(execCapture).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });

    const logger = makeLogger();
    const branch = await createLiveTargetBranch(
      "run-123",
      logger as never,
      "next"
    );

    expect(branch).toBe("pourkit-e2e-target/run-123");
    expect(execCapture).toHaveBeenNthCalledWith(1, "git", [
      "fetch",
      "origin",
      "next:refs/remotes/origin/next",
    ]);
    expect(execCapture).toHaveBeenNthCalledWith(2, "git", [
      "branch",
      "--force",
      "pourkit-e2e-target/run-123",
      "origin/next",
    ]);
    expect(execCapture).toHaveBeenNthCalledWith(3, "git", [
      "push",
      "--no-verify",
      "-u",
      "origin",
      "pourkit-e2e-target/run-123",
    ]);
  });

  it("recovers stale runs and removes their state file", async () => {
    const stateDir = path.join(root, ".pourkit", ".tmp", "e2e-runs");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "stale.json"),
      JSON.stringify(
        {
          runId: "stale",
          targetBranch: "pourkit-e2e-target/stale",
          agentBranch: "pourkit/123/e2e-test-issue-stale",
        },
        null,
        2
      )
    );

    vi.mocked(execCapture).mockImplementation(async (_cmd, args) => {
      if (
        args[0] === "show-ref" ||
        args[0] === "ls-remote" ||
        (args[0] === "worktree" && args[1] === "list") ||
        (args[0] === "branch" && args[1] === "-D") ||
        (args[0] === "push" && args[1] === "origin" && args[2] === "--delete")
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }

      if (args[0] === "worktree" && args[1] === "remove") {
        return { code: 0, stdout: "", stderr: "" };
      }

      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    vi.mocked(execCapture).mockImplementationOnce(async () => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));

    vi.mocked(execCapture).mockImplementationOnce(async () => ({
      code: 0,
      stdout:
        "worktree /tmp/pourkit-agent-wt\nbranch refs/heads/pourkit/123/e2e-test-issue-stale\n",
      stderr: "",
    }));

    const logger = makeLogger();
    await recoverStaleRuns(root, logger as never);

    await expect(
      readFile(path.join(stateDir, "stale.json"), "utf-8")
    ).rejects.toThrow();
  });

  it("cleans up live resources and deletes the state file", async () => {
    await persistResources(root, "run-abc", {
      targetBranch: "pourkit-e2e-target/run-abc",
      issueNumber: 7,
      issueUrl: "https://github.com/example/repo/issues/7",
      agentBranch: "pourkit/7/e2e-test-issue-run-abc",
      prNumber: 12,
      prUrl: "https://github.com/example/repo/pull/12",
    });

    const client = makeMockClient();
    client.octokit.rest.pulls.get.mockResolvedValue({
      data: { merged: true, state: "closed" },
    });
    client.octokit.rest.issues.update.mockResolvedValue({ data: {} });

    vi.mocked(execCapture).mockImplementation(async (_cmd, args) => {
      if (args[0] === "show-ref") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "ls-remote") {
        return {
          code: 0,
          stdout: `abc123 refs/heads/${args[3]}\n`,
          stderr: "",
        };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout:
            "worktree /tmp/pourkit-agent-wt\nbranch refs/heads/pourkit/7/e2e-test-issue-run-abc\n\nworktree /tmp/pourkit-target-wt\nbranch refs/heads/pourkit-e2e-target/run-abc\n",
          stderr: "",
        };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "branch" && args[1] === "-D") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        args[0] === "push" &&
        args[1] === "origin" &&
        args[2] === "--delete"
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const logger = makeLogger();
    await cleanupResources(
      {
        targetBranch: "pourkit-e2e-target/run-abc",
        issueNumber: 7,
        issueUrl: "https://github.com/example/repo/issues/7",
        agentBranch: "pourkit/7/e2e-test-issue-run-abc",
        prNumber: 12,
        prUrl: "https://github.com/example/repo/pull/12",
      },
      root,
      "run-abc",
      false,
      logger as never,
      client
    );

    expect(client.octokit.rest.pulls.get).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 12 })
    );
    expect(client.octokit.rest.pulls.update).not.toHaveBeenCalled();
    expect(client.octokit.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 7, state: "closed" })
    );
    await expect(
      readFile(stateFilePath(root, "run-abc"), "utf-8")
    ).rejects.toThrow();
  });

  it("treats already-deleted remote branches as cleaned up", async () => {
    await persistResources(root, "run-missing-remote", {
      targetBranch: "pourkit-e2e-target/run-missing-remote",
      agentBranch: "pourkit/7/test-live-e2e-missing-remote",
    });

    vi.mocked(execCapture).mockImplementation(async (_cmd, args) => {
      if (args[0] === "show-ref") {
        throw new Error("local branch missing");
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const client = makeMockClient();
    await cleanupResources(
      {
        targetBranch: "pourkit-e2e-target/run-missing-remote",
        agentBranch: "pourkit/7/test-live-e2e-missing-remote",
      },
      root,
      "run-missing-remote",
      false,
      makeLogger() as never,
      client
    );

    expect(execCapture).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["--delete"])
    );
    await expect(
      readFile(stateFilePath(root, "run-missing-remote"), "utf-8")
    ).rejects.toThrow();
  });

  it("preserves the state file when cleanup fails", async () => {
    await persistResources(root, "run-fail", {
      targetBranch: "pourkit-e2e-target/run-fail",
    });

    const client = makeMockClient();
    vi.mocked(execCapture).mockImplementation(async (_cmd, args) => {
      if (args[0] === "show-ref") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "branch" && args[1] === "-D") {
        throw new Error("delete failed");
      }
      if (
        args[0] === "push" &&
        args[1] === "origin" &&
        args[2] === "--delete"
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    await cleanupResources(
      {
        targetBranch: "pourkit-e2e-target/run-fail",
      },
      root,
      "run-fail",
      false,
      makeLogger() as never,
      client
    );

    await expect(
      readFile(stateFilePath(root, "run-fail"), "utf-8")
    ).resolves.toContain('"runId": "run-fail"');
  });

  it("deletes only stale e2e branches in cleanup-only mode", async () => {
    const stateDir = path.join(root, ".pourkit", ".tmp", "e2e-runs");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "keep.json"), "{}\n");

    const client = makeMockClient();
    client.octokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        { number: 17, pull_request: undefined },
        { number: 23, pull_request: undefined },
      ],
    });
    client.octokit.rest.issues.update.mockResolvedValue({ data: {} });

    vi.mocked(execCapture).mockImplementation(async (_cmd, args) => {
      if (args[0] === "ls-remote") {
        return {
          code: 0,
          stdout:
            "aaaaaaaa refs/heads/pourkit-e2e-target/run-123\nbbbbbbbb refs/heads/pourkit/42/e2e-test-issue-foo\ndddddddd refs/heads/pourkit/43/test-live-e2e-foo\ncccccccc refs/heads/main\n",
          stderr: "",
        };
      }
      if (args[0] === "show-ref") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "branch" && args[1] === "-D") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        args[0] === "push" &&
        args[1] === "origin" &&
        args[2] === "--delete"
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const logger = makeLogger();
    await runCleanupOnly(root, logger as never, client);

    expect(client.octokit.rest.issues.listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ labels: "pourkit-e2e", state: "open" })
    );
    expect(client.octokit.rest.issues.update).toHaveBeenCalledTimes(2);
    expect(client.octokit.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 17, state: "closed" })
    );
    expect(client.octokit.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 23, state: "closed" })
    );
    await expect(
      readFile(path.join(stateDir, "keep.json"), "utf-8")
    ).rejects.toThrow();
  });

  it("cleanupResources skips merged PR close but closes issue", async () => {
    await persistResources(root, "run-merged", {
      targetBranch: "pourkit-e2e-target/run-merged",
      issueNumber: 7,
      issueUrl: "https://github.com/example/repo/issues/7",
      agentBranch: "pourkit/7/e2e-test-issue-merged",
      prNumber: 12,
      prUrl: "https://github.com/example/repo/pull/12",
    });

    const client = makeMockClient();
    client.octokit.rest.pulls.get.mockResolvedValue({
      data: { merged: true, state: "closed" },
    });
    client.octokit.rest.issues.update.mockResolvedValue({ data: {} });

    vi.mocked(execCapture).mockImplementation(async (_cmd, args) => {
      if (args[0] === "show-ref") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "ls-remote") {
        return {
          code: 0,
          stdout: `abc123 refs/heads/${args[3]}\n`,
          stderr: "",
        };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout:
            "worktree /tmp/pourkit-agent-wt\nbranch refs/heads/pourkit/7/e2e-test-issue-merged\n\nworktree /tmp/pourkit-target-wt\nbranch refs/heads/pourkit-e2e-target/run-merged\n",
          stderr: "",
        };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "branch" && args[1] === "-D") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        args[0] === "push" &&
        args[1] === "origin" &&
        args[2] === "--delete"
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const logger = makeLogger();
    await cleanupResources(
      {
        targetBranch: "pourkit-e2e-target/run-merged",
        issueNumber: 7,
        issueUrl: "https://github.com/example/repo/issues/7",
        agentBranch: "pourkit/7/e2e-test-issue-merged",
        prNumber: 12,
        prUrl: "https://github.com/example/repo/pull/12",
      },
      root,
      "run-merged",
      false,
      logger as never,
      client
    );

    expect(client.octokit.rest.pulls.update).not.toHaveBeenCalled();
    expect(client.octokit.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 7, state: "closed" })
    );
    expect(execCapture).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["branch", "-D"])
    );
    await expect(
      readFile(stateFilePath(root, "run-merged"), "utf-8")
    ).rejects.toThrow();
  });

  it("runCleanupOnly closes pourkit-e2e issues through GitHub API", async () => {
    const client = makeMockClient();
    client.octokit.paginate.mockResolvedValue([
      { number: 17, pull_request: undefined },
      { number: 23, pull_request: undefined },
    ]);
    client.octokit.rest.issues.update.mockResolvedValue({ data: {} });

    vi.mocked(execCapture).mockImplementation(async (_cmd, args) => {
      if (args[0] === "ls-remote") {
        return {
          code: 0,
          stdout:
            "aaaaaaaa refs/heads/pourkit-e2e-target/run-123\nbbbbbbbb refs/heads/pourkit/42/e2e-test-issue-foo\ndddddddd refs/heads/pourkit/43/test-live-e2e-foo\ncccccccc refs/heads/main\n",
          stderr: "",
        };
      }
      if (args[0] === "show-ref") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "branch" && args[1] === "-D") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        args[0] === "push" &&
        args[1] === "origin" &&
        args[2] === "--delete"
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const logger = makeLogger();
    await runCleanupOnly(root, logger as never, client);

    expect(client.octokit.paginate).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ labels: "pourkit-e2e", state: "open" })
    );
    expect(client.octokit.rest.issues.update).toHaveBeenCalledTimes(2);
  });

  it("asserts issue labels with present and absent expectations", async () => {
    const client = makeMockClient();
    client.octokit.rest.issues.get = vi.fn().mockResolvedValue({
      data: { labels: [{ name: "ready-for-human" }, { name: "type:infra" }] },
    });

    await expect(
      assertIssueLabels(
        42,
        { present: ["ready-for-human"], absent: ["agent-in-progress"] },
        client
      )
    ).resolves.toBeUndefined();
  });

  it("creates a live E2E issue through the GitHub API boundary", async () => {
    const client = makeMockClient();
    client.octokit.rest.issues.create = vi.fn().mockResolvedValue({
      data: {
        number: 42,
        html_url: "https://github.com/owner/repo/issues/42",
      },
    });

    const logger = makeLogger();
    const result = await createE2EIssue(
      "run-123",
      "pourkit-e2e-target/run-123",
      logger as never,
      client,
      "E2E Test"
    );

    expect(client.octokit.rest.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: ["ready-for-agent", "type:infra", "pourkit-e2e"],
      })
    );
    expect(result).toEqual({
      number: 42,
      url: "https://github.com/owner/repo/issues/42",
    });
  });

  it("assertIssueLabels preserves missing and unexpected label errors", async () => {
    const client = makeMockClient();
    client.octokit.rest.issues.get = vi.fn().mockResolvedValue({
      data: { labels: [{ name: "ready-for-agent" }] },
    });

    await expect(
      assertIssueLabels(
        42,
        { present: ["blocked"], absent: ["ready-for-agent"] },
        client
      )
    ).rejects.toThrow(
      "Issue #42 label assertion failed (missing labels: blocked; unexpected labels: ready-for-agent)"
    );
  });

  it("lookupPrByBranch returns MERGED when merged_at is set", async () => {
    const client = makeMockClient();
    client.octokit.rest.pulls.list = vi.fn().mockResolvedValue({
      data: [
        {
          number: 42,
          node_id: "PR_nodeid",
          html_url: "https://github.com/owner/repo/pull/42",
          title: "Test PR",
          body: "PR body",
          state: "closed",
          merged_at: "2024-01-15T10:00:00Z",
          head: { ref: "feature-branch", sha: "abc123" },
          base: { ref: "main" },
        },
      ],
    });

    const result = await lookupPrByBranch("feature-branch", client);

    expect(result).not.toBeNull();
    expect(result!.state).toBe("MERGED");
    expect(result!.nodeId).toBe("PR_nodeid");
  });

  it("lookupPrByBranch returns CLOSED when merged_at is null", async () => {
    const client = makeMockClient();
    client.octokit.rest.pulls.list = vi.fn().mockResolvedValue({
      data: [
        {
          number: 43,
          node_id: "PR_nodeid_2",
          html_url: "https://github.com/owner/repo/pull/43",
          title: "Test PR Closed",
          body: "PR body",
          state: "closed",
          merged_at: null,
          head: { ref: "closed-branch", sha: "def456" },
          base: { ref: "main" },
        },
      ],
    });

    const result = await lookupPrByBranch("closed-branch", client);

    expect(result).not.toBeNull();
    expect(result!.state).toBe("CLOSED");
  });

  it("injects reviewer/finalizer behavior without changing the base harness", async () => {
    const baseProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => ({
        success: true,
        branch: options.branchName,
        worktreePath: options.worktreePath ?? root,
        commits: ["abc123"],
        logPath: null,
      })),
    };

    const provider = new ScenarioExecutionProvider(baseProvider, {
      reviewer: { verdicts: ["NEEDS_REFACTOR", "PASS"] },
      finalizer: { title: "Injected Title", body: "Injected Body" },
    });

    const reviewerResult = await provider.execute({
      stage: "reviewer",
      iteration: 1,
      artifactPath: ".pourkit/.tmp/reviewers/iteration-1.md",
      worktreePath: root,
      branchName: "pourkit/42/e2e",
      agent: "reviewer",
      model: "test",
      prompt: "prompt",
      target: {} as never,
      repoRoot: root,
      sandbox: {} as never,
      logger: makeLogger() as never,
    });
    const finalizerResult = await provider.execute({
      stage: "finalizer",
      artifactPath: ".pourkit/.tmp/finalizer/agent-output.md",
      worktreePath: root,
      branchName: "pourkit/42/e2e",
      agent: "finalizer",
      model: "test",
      prompt: "prompt",
      target: {} as never,
      repoRoot: root,
      sandbox: {} as never,
      logger: makeLogger() as never,
    });

    expect(reviewerResult.success).toBe(true);
    expect(finalizerResult.success).toBe(true);
    expect(provider.stageCalls).toEqual(["reviewer", "finalizer"]);
    await expect(
      readFile(
        path.join(root, ".pourkit/.tmp/reviewers/iteration-1.md"),
        "utf-8"
      )
    ).resolves.toContain("<verdict>NEEDS_REFACTOR</verdict>");
    await expect(
      readFile(
        path.join(root, ".pourkit/.tmp/finalizer/agent-output.md"),
        "utf-8"
      )
    ).resolves.toContain("Injected Title");
  });

  it("requires checks to be awaited before merge when requested", async () => {
    const baseProvider: PRProvider = {
      createPr: vi.fn(),
      getPr: vi.fn(),
      getCheckStatus: vi.fn(),
      mergePr: vi.fn(async () => undefined),
      enableAutoMerge: vi.fn(),
      waitForPrChecks: vi.fn(async () => []),
      getBranchStatus: vi.fn(),
    } as never;

    const provider = new ScenarioPrProvider(baseProvider, makeMockClient(), {
      requireWaitForChecksBeforeMerge: true,
    });

    await expect(provider.mergePr(7)).rejects.toThrow(
      "mergePr called before waitForPrChecks"
    );
    await provider.waitForPrChecks(7);
    await expect(provider.mergePr(7)).resolves.toBeUndefined();
  });
});
