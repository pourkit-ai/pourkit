import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runIssueCommand } from "../commands/issue";
import {
  checkIssueGates,
  startIssueRun,
  type IssueGates,
} from "../commands/issue-run";
import type {
  PourkitConfig,
  ReviewerConfig,
  StageAgentConfig,
  Target,
} from "../shared/config";
import { FakeIssueProvider } from "../providers/issue-provider";
import type { PRProvider, PullRequest } from "../providers/pr-provider";
import {
  FakeExecutionProvider,
  type ExecutionResult,
} from "../execution/execution-provider";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from "fs";
import { join } from "path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  WORKTREE_RUN_STATE_PATH,
  readWorktreeRunState,
  writeWorktreeRunState,
} from "../shared/worktree-run-state";

const { execCaptureMock, repoRootMock } = vi.hoisted(() => ({
  execCaptureMock: vi.fn(),
  repoRootMock: vi.fn(() => "/tmp/pourkit-issue-test"),
}));

vi.mock("../shared/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/common")>();
  return {
    ...actual,
    execCapture: execCaptureMock,
    repoRoot: repoRootMock,
  };
});

const makeConfig = (
  overrides: {
    reviewerEnabled?: boolean;
    target?: Record<string, any>;
    builder?: StageAgentConfig;
    reviewer?: ReviewerConfig;
    refactor?: StageAgentConfig;
    finalizer?: StageAgentConfig;
    maxIterations?: number;
  } & Record<string, any> = {}
): PourkitConfig => {
  const reviewerEnabled = overrides.reviewerEnabled ?? false;
  const { reviewerEnabled: _, target: targetOverrides, ...rest } = overrides;
  const builder = overrides.builder ?? {
    agent: "build",
    model: "test",
    promptTemplate: "test.md",
  };
  const reviewer = overrides.reviewer ?? {
    agent: "review",
    model: "test-review",
    promptTemplate: "review.md",
    criteria: ["correctness", "quality"],
  };
  const refactorConfig = overrides.refactor ?? {
    agent: "refactor",
    model: "test-refactor",
    promptTemplate: "refactor.md",
  };
  const prDescriptionAgent = overrides.finalizer ?? {
    agent: "finalizer",
    model: "test-finalizer",
    promptTemplate: "finalizer.md",
  };
  const strategy = targetOverrides?.strategy ?? {
    type: "review-refactor-loop" as const,
    implement: { builder },
    review: {
      reviewer,
      refactor: refactorConfig,
      maxIterations: overrides.maxIterations ?? 3,
      passWithNotesRefactorAttempts: 2,
    },
    verify: {
      commands: [{ command: "npm run typecheck", label: "typecheck" }],
    },
    finalize: {
      prDescriptionAgent,
      maxAttempts: 2,
    },
  };

  return {
    targets: [
      {
        name: "test",
        baseBranch: "main",
        branchTemplate: "pourkit/{{issue.number}}/{{issue.slug}}",
        autoMerge: true,
        strategy,
        ...targetOverrides,
      },
    ],
    labels: {
      readyForAgent: "ready-for-agent",
      agentInProgress: "agent-in-progress",
      blocked: "blocked",
      prOpenAwaitingMerge: "pr-open-awaiting-merge",
      readyForHuman: "ready-for-human",
      needsTriage: "needs-triage",
    },
    sandbox: { provider: "docker" },
    checks: {
      requiredLabels: [],
      allowedAuthors: [],
      checksFoundTimeoutSeconds: 60,
      checksCompletionTimeoutSeconds: 1800,
      pollIntervalSeconds: 0,
      issueListLimit: 50,
    },
    serena: {
      enabled: false,
      required: false,
      mcpUrl: "http://localhost:9121/mcp",
      sandboxMcpUrl: "http://localhost:9121/mcp",
      dataDir: ".pourkit/serena/",
      autoStart: false,
    },
    cleanup: {
      enabled: true,
      worktreeRetentionDays: 14,
      logRetentionDays: 30,
    },
    ...Object.fromEntries(
      Object.entries(rest).filter(
        ([key]) =>
          ![
            "builder",
            "reviewer",
            "refactor",
            "finalizer",
            "maxIterations",
          ].includes(key)
      )
    ),
  };
};

const makeIssue = (
  overrides: Partial<{
    title: string;
    body: string;
    state: "open" | "closed";
    labels: string[];
    createdAt: Date;
  }> = {}
) => ({
  number: 42,
  title: "Test issue",
  body: "Test body",
  state: "open" as const,
  labels: [] as string[],
  comments: [],
  createdAt: new Date("2024-01-01T00:00:00Z"),
  ...overrides,
});

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

function makePullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    nodeId: "PR_7",
    url: "https://github.com/test/repo/pull/7",
    title: "Test issue",
    body: "Closes #42",
    headRefName: "pourkit/42/test-issue",
    baseRefName: "main",
    state: "OPEN",
    headRefOid: "abc123",
    ...overrides,
  };
}

function writeSyntheticStageArtifact(
  opts: any,
  fallbackWorktreePath: string,
  verdict: string
) {
  const artifactPath = join(
    opts.worktreePath ?? fallbackWorktreePath,
    opts.artifactPath ??
      (opts.stage === "finalizer"
        ? ".pourkit/.tmp/finalizer/agent-output.md"
        : ".pourkit/.tmp/reviewers/iteration-1.md")
  );
  mkdirSync(join(artifactPath, ".."), { recursive: true });
  writeFileSync(
    artifactPath,
    opts.stage === "finalizer"
      ? "## PR Title\n\nfix: Test issue\n\n## PR Body\n\n## Summary\n\n- Why this branch exists.\n\n## Changes\n\n- Final net change 1.\n\nCloses #42"
      : [
          "## Findings",
          "",
          "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
          "|----|------------|----------|-----------|-------|----------------|",
          "| none | n/a | n/a | n/a | No findings. | n/a |",
          "",
          `<verdict>${verdict}</verdict>`,
        ].join("\n"),
    "utf-8"
  );
}

function writeReviewerArtifact(
  artifactPath: string,
  verdict: string,
  includePriorRefactorAssessment = false
) {
  mkdirSync(join(artifactPath, ".."), { recursive: true });
  const assessmentSection = includePriorRefactorAssessment
    ? [
        "## Prior Refactor Response Assessment",
        "",
        "| Prior Finding ID | Refactor Classification | Reviewer Assessment | Next Action |",
        "|------------------|-------------------------|---------------------|-------------|",
        "| R1.F1 | accepted | accepted-refactor-response | No further action needed. |",
        "",
      ].join("\n")
    : "";
  writeFileSync(
    artifactPath,
    [
      "## Findings",
      "",
      "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
      "|----|------------|----------|-----------|-------|----------------|",
      "| none | n/a | n/a | n/a | No findings. | n/a |",
      "",
      assessmentSection,
      `<verdict>${verdict}</verdict>`,
    ]
      .filter((l) => l !== "")
      .join("\n"),
    "utf-8"
  );
}

function makePrProvider(): PRProvider {
  return {
    createPr: vi.fn(async () => makePullRequest()),
    getPr: vi.fn(async () => null),
    getCheckStatus: vi.fn(async () => []),
    mergePr: vi.fn(async () => undefined),
    enableAutoMerge: vi.fn(async () => undefined),
    waitForPrChecks: vi.fn(async () => []),
    getBranchStatus: vi.fn(async () => ({
      headSha: "abc123",
      state: "green" as const,
      checks: [
        {
          name: "ci",
          conclusion: "SUCCESS" as const,
          status: "COMPLETED" as const,
        },
      ],
    })),
  };
}

describe("checkIssueGates", () => {
  it("passes for a clean open issue with ready-for-agent", () => {
    const config = makeConfig();
    const issue = makeIssue({ labels: ["ready-for-agent"] });

    const result = checkIssueGates(issue, config, false);

    expect(result.allowed).toBe(true);
    expect(result.gates).toEqual<IssueGates>({
      isOpen: true,
      isReadyForAgent: true,
      isNotBlocked: true,
      isNotInProgress: true,
    });
  });

  it("fails when issue has multiple gate violations", () => {
    const config = makeConfig();
    const issue = makeIssue({
      state: "closed",
      labels: ["blocked", "agent-in-progress"],
    });

    const result = checkIssueGates(issue, config, false);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not open");
    expect(result.reason).toContain("ready-for-agent");
    expect(result.reason).toContain("blocked");
    expect(result.reason).toContain("agent-in-progress");
  });

  it("passes with force even when gates fail", () => {
    const config = makeConfig();
    const issue = makeIssue({ state: "closed", labels: [] });

    const result = checkIssueGates(issue, config, true);

    expect(result.allowed).toBe(true);
  });
});

describe("runIssueCommand", () => {
  let executionProvider: FakeExecutionProvider;
  const TEST_DIR = "/tmp/pourkit-issue-test";

  beforeEach(() => {
    vi.clearAllMocks();
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "show-ref") {
        throw new Error("branch not found");
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      if (command === "git" && args[0] === "status") {
        return { code: 0, stdout: "?? changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    executionProvider = new FakeExecutionProvider({
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${TEST_DIR}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${TEST_DIR}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    });

    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  it("passes run context to Builder, pushes branch, and opens a PR", async () => {
    const originalLiveE2E = process.env.POURKIT_RUN_LIVE_E2E;
    process.env.POURKIT_RUN_LIVE_E2E = "true";

    try {
      const config = makeConfig({
        builder: {
          agent: "build",
          model: "test",
          promptTemplate: "builder.prompt.md",
        },
      });
      expect(config.targets[0].strategy!.implement.builder.promptTemplate).toBe(
        "builder.prompt.md"
      );
      expect(config.targets[0]).not.toHaveProperty("verificationCommands");

      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent", "pr-open-awaiting-merge"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();

      const result = await runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      });

      expect(execCaptureMock).not.toHaveBeenCalledWith(
        "bash",
        ["-lc", "npm run typecheck"],
        expect.objectContaining({ label: "verify typecheck" })
      );
      expect(execCaptureMock).toHaveBeenCalledWith(
        "git",
        ["push", "-u", "origin", "pourkit/42/test-issue"],
        expect.objectContaining({
          cwd: "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
        })
      );
      const builderCall = executionProvider.calls.find(
        (call) => call.stage === "builder"
      );
      expect(builderCall?.timeoutMs).toBe(30 * 60 * 1000);
      expect(builderCall?.artifacts).toEqual([
        expect.objectContaining({
          path: ".pourkit/.tmp/run-context.md",
          content: expect.stringContaining("# Pourkit Run Context"),
        }),
      ]);
      expect(prProvider.createPr).toHaveBeenCalledWith({
        title: "fix: Test issue",
        body: "Closes #42",
        head: "pourkit/42/test-issue",
        base: "main",
      });
      expect(prProvider.waitForPrChecks).toHaveBeenCalledWith(7, {
        checksFoundTimeoutMs: 60 * 1000,
        checksCompletionTimeoutMs: 30 * 60 * 1000,
        pollIntervalMs: 0,
      });
      expect(prProvider.mergePr).toHaveBeenCalledWith(7, {
        method: "squash",
        matchHeadCommit: "abc123",
      });
      expect(prProvider.enableAutoMerge).not.toHaveBeenCalled();
      expect(prProvider.getBranchStatus).toHaveBeenCalled();

      expect(result.prNumber).toBe(7);
      const updatedIssue = await issueProvider.fetchIssue(42);
      expect(updatedIssue.labels).not.toContain("pr-open-awaiting-merge");
      expect(updatedIssue.labels).not.toContain("ready-for-agent");
      expect(updatedIssue.labels).not.toContain("agent-in-progress");
    } finally {
      if (originalLiveE2E === undefined) {
        delete process.env.POURKIT_RUN_LIVE_E2E;
      } else {
        process.env.POURKIT_RUN_LIVE_E2E = originalLiveE2E;
      }
    }
  });

  it("skips merge and hands off to human when auto-merge is disabled", async () => {
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    vi.spyOn(issueProvider, "closeIssue");

    const result = await runIssueCommand({
      issueNumber: 42,
      config: makeConfig({ target: { autoMerge: false } }),
      issueProvider,
      prProvider,
      executionProvider,
      force: false,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(prProvider.waitForPrChecks).toHaveBeenCalledWith(7, {
      checksFoundTimeoutMs: 60 * 1000,
      checksCompletionTimeoutMs: 30 * 60 * 1000,
      pollIntervalMs: 0,
    });
    expect(prProvider.mergePr).not.toHaveBeenCalled();
    expect(prProvider.getBranchStatus).not.toHaveBeenCalled();
    expect(result.prNumber).toBe(7);

    expect(issueProvider.closeIssue).not.toHaveBeenCalled();

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("pr-open-awaiting-merge");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
  });

  it("keeps awaiting-merge label when merge is blocked", async () => {
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    vi.mocked(prProvider.mergePr).mockRejectedValue(new Error("merge blocked"));

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config: makeConfig(),
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow("merge blocked");

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).toContain("pr-open-awaiting-merge");
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
  });

  it("clears awaiting-merge label when auto-merge is blocked", async () => {
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    vi.mocked(prProvider.mergePr).mockRejectedValue(
      new Error("auto-merge rejected")
    );

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config: makeConfig(),
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow("auto-merge rejected");

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
    expect(updatedIssue.labels).toContain("pr-open-awaiting-merge");
  });

  it("rejects with original coordinator error when label removal fails after direct auto merge failure", async () => {
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    vi.mocked(prProvider.mergePr).mockRejectedValue(
      new Error("auto-merge rejected")
    );

    const removeLabelOrig = issueProvider.removeLabel.bind(issueProvider);
    vi.spyOn(issueProvider, "removeLabel").mockImplementation(
      async (issueNumber, label) => {
        if (label === "pr-open-awaiting-merge") {
          throw new Error("label removal failed");
        }
        return removeLabelOrig(issueNumber, label);
      }
    );

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config: makeConfig(),
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow("auto-merge rejected");
  });

  it("includes the protected-work rule in the builder prompt", async () => {
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();

    await runIssueCommand({
      issueNumber: 42,
      config: makeConfig(),
      issueProvider,
      prProvider,
      executionProvider,
      force: false,
      logger: makeLogger(),
      repoRoot: "/tmp/pourkit-issue-test",
    });

    const builderCall = executionProvider.calls.find(
      (call) => call.stage === "builder"
    );
    expect(builderCall?.prompt).toContain("## Hard Rule");
    expect(builderCall?.prompt).toContain(
      "Do **not** revert, delete, or substantially strip already-landed protected sibling/base work unless the issue explicitly requires those files."
    );
  });

  it("loads bare builder prompt filenames from .pourkit/prompts", async () => {
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();
    const repoRoot = repoRootMock();
    const promptFileDir = join(repoRoot, ".pourkit", "prompts");
    const promptFilePath = join(promptFileDir, "builder.prompt.md");
    mkdirSync(promptFileDir, { recursive: true });
    writeFileSync(promptFilePath, "fixture builder prompt", "utf-8");

    await runIssueCommand({
      issueNumber: 42,
      config: makeConfig({
        builder: {
          agent: "build",
          model: "test",
          promptTemplate: "builder.prompt.md",
        },
      }),
      issueProvider,
      prProvider,
      executionProvider,
      force: false,
      logger,
      repoRoot,
    });

    const builderCall = executionProvider.calls.find(
      (call) => call.stage === "builder"
    );
    expect(builderCall?.prompt).toContain("fixture builder prompt");
  });

  it("loads explicit .pourkit prompt paths from repo root", async () => {
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();
    const repoRoot = repoRootMock();
    const promptFileDir = join(repoRoot, ".pourkit", "prompts");
    const promptFilePath = join(promptFileDir, "builder.prompt.md");
    mkdirSync(promptFileDir, { recursive: true });
    writeFileSync(promptFilePath, "fixture builder prompt", "utf-8");

    await runIssueCommand({
      issueNumber: 42,
      config: makeConfig({
        builder: {
          agent: "build",
          model: "test",
          promptTemplate: ".pourkit/prompts/builder.prompt.md",
        },
      }),
      issueProvider,
      prProvider,
      executionProvider,
      force: false,
      logger,
      repoRoot,
    });

    const builderCall = executionProvider.calls.find(
      (call) => call.stage === "builder"
    );
    expect(builderCall?.prompt).toContain("fixture builder prompt");
  });

  it("missing prompt template still falls back to literal content", async () => {
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();
    const repoRoot = repoRootMock();

    await runIssueCommand({
      issueNumber: 42,
      config: makeConfig({
        builder: {
          agent: "build",
          model: "test",
          promptTemplate: "literal prompt text",
        },
      }),
      issueProvider,
      prProvider,
      executionProvider,
      force: false,
      logger,
      repoRoot,
    });

    const builderCall = executionProvider.calls.find(
      (call) => call.stage === "builder"
    );
    expect(builderCall?.prompt).toContain("literal prompt text");
  });

  it("reuses existing worktree and reruns builder when state is missing", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }

      return { code: 0, stdout: "", stderr: "" };
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(execCaptureMock).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "remove"]),
      expect.anything()
    );

    expect(execCaptureMock).not.toHaveBeenCalledWith(
      "git",
      ["branch", "-D", expect.any(String)],
      expect.anything()
    );

    const builderCall = executionProvider.calls.find(
      (call) => call.stage === "builder"
    );
    expect(builderCall).toBeDefined();
    expect(builderCall?.worktreePath).toBe(
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue"
    );

    const reviewCall = executionProvider.calls.find(
      (call) => call.stage === "reviewer"
    );
    expect(reviewCall?.worktreePath).toBe(
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue"
    );
  });

  it("first-time issue still runs builder", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: false,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(executionProvider.calls[0]?.stage).toBe("builder");
  });

  it("fresh issue setup fetches remote base without force-updating local base branch", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: false,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["fetch", "origin", "main"],
      expect.anything()
    );
    expect(execCaptureMock).not.toHaveBeenCalledWith(
      "git",
      ["branch", "--force", "main", "origin/main"],
      expect.anything()
    );
    expect(
      executionProvider.calls.some((call) => call.stage === "builder")
    ).toBe(true);
    const builderCall = executionProvider.calls.find(
      (call) => call.stage === "builder"
    );
    expect(builderCall?.baseRef).toBe("origin/main");
  });

  it("fetch failure stops before Builder execution", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "fetch" && args[1] === "origin") {
        throw new Error("fetch failed");
      }
      if (command === "git" && args[0] === "show-ref") {
        throw new Error("branch not found");
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow();

    expect(
      executionProvider.calls.some((call) => call.stage === "builder")
    ).toBe(false);
  });

  it("Builder receives plain Target baseBranch", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: false,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    const builderCall = executionProvider.calls.find(
      (call) => call.stage === "builder"
    );
    expect(builderCall?.target.baseBranch).toBe("main");
  });

  it("resumes builder with worktreePath from existing worktree with state builder incomplete", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    mkdirSync(worktreePath, { recursive: true });
    writeWorktreeRunState(worktreePath, {
      issueNumber: 42,
      targetName: "test",
      branchName: "pourkit/42/test-issue",
      baseBranch: "main",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      completedStages: { builder: false },
      review: { lifetimeIterations: 0 },
    });
    expect(existsSync(join(worktreePath, WORKTREE_RUN_STATE_PATH))).toBe(true);

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    const builderCall = executionProvider.calls.find(
      (call) => call.stage === "builder"
    );
    expect(builderCall).toBeDefined();
    expect(builderCall!.worktreePath).toBe(worktreePath);
  });

  it("missing state for existing worktree reruns builder before review", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    const builderCall = executionProvider.calls.find(
      (call) => call.stage === "builder"
    );
    expect(builderCall).toBeDefined();
    expect(builderCall!.worktreePath).toBe(
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue"
    );
  });

  it("refreshes stale existing worktree branch and skips builder", async () => {
    let mergeBaseCalls = 0;
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "merge-base" &&
        args[1] === "--is-ancestor"
      ) {
        mergeBaseCalls++;
        if (mergeBaseCalls === 1) {
          throw new Error("not ancestor");
        }
      }
      if (command === "git" && args[0] === "rebase") {
        return {
          code: 0,
          stdout:
            "Successfully rebased and updated refs/heads/pourkit/42/test-issue.\n",
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    mkdirSync(worktreePath, { recursive: true });
    writeWorktreeRunState(worktreePath, {
      issueNumber: 42,
      targetName: "test",
      branchName: "pourkit/42/test-issue",
      baseBranch: "main",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      completedStages: { builder: true },
      review: { lifetimeIterations: 0 },
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["rebase", "--autostash", "origin/main"],
      expect.objectContaining({ cwd: worktreePath })
    );

    expect(
      executionProvider.calls.some((call) => call.stage === "builder")
    ).toBe(false);
  });

  it("clears downstream state after stale base refresh", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "merge-base" &&
        args[1] === "--is-ancestor"
      ) {
        throw new Error("not ancestor");
      }
      if (command === "git" && args[0] === "rebase") {
        return {
          code: 0,
          stdout: "Successfully rebased.\n",
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    mkdirSync(worktreePath, { recursive: true });
    writeWorktreeRunState(worktreePath, {
      issueNumber: 42,
      targetName: "test",
      branchName: "pourkit/42/test-issue",
      baseBranch: "main",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      completedStages: { builder: true },
      review: {
        lifetimeIterations: 2,
        lastVerdict: "PASS",
        lastArtifactPath: ".pourkit/.tmp/reviewers/iteration-2.md",
        refactorCompletedForLastReview: true,
        exhaustedPreviousRun: false,
      },
      finalizer: {
        completed: true,
        artifactPath: ".pourkit/.tmp/finalizer/agent-output.md",
        title: "fix: test",
        body: "Closes #42",
      },
      finalCommit: { completed: true, sha: "abc123" },
      pr: {
        created: true,
        number: 7,
        url: "https://github.com/test/repo/pull/7",
        merged: false,
      },
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    const result = await startIssueRun({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    const state = result.worktreeState;
    expect(state).not.toBeNull();
    expect(state!.completedStages.builder).toBe(true);
    expect(state!.review.lastVerdict).toBeUndefined();
    expect(state!.finalizer).toBeUndefined();
    expect(state!.finalCommit).toBeUndefined();
    expect(state!.pr).toBeUndefined();
  });

  it("Base Refresh rebases onto remote-backed Target base", async () => {
    let mergeBaseCalls = 0;
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "merge-base" &&
        args[1] === "--is-ancestor"
      ) {
        mergeBaseCalls++;
        if (mergeBaseCalls === 1) {
          throw new Error("not ancestor");
        }
      }
      if (command === "git" && args[0] === "rebase") {
        return {
          code: 0,
          stdout:
            "Successfully rebased and updated refs/heads/pourkit/42/test-issue.\n",
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    mkdirSync(worktreePath, { recursive: true });
    writeWorktreeRunState(worktreePath, {
      issueNumber: 42,
      targetName: "test",
      branchName: "pourkit/42/test-issue",
      baseBranch: "main",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      completedStages: { builder: true },
      review: { lifetimeIterations: 0 },
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["merge-base", "--is-ancestor", "origin/main", "HEAD"],
      expect.anything()
    );
    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["rebase", "--autostash", "origin/main"],
      expect.anything()
    );
  });

  it("Base Refresh keeps plain baseBranch in Worktree Run State", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "merge-base" &&
        args[1] === "--is-ancestor"
      ) {
        throw new Error("not ancestor");
      }
      if (command === "git" && args[0] === "rebase") {
        return {
          code: 0,
          stdout: "Successfully rebased.\n",
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    mkdirSync(worktreePath, { recursive: true });
    writeWorktreeRunState(worktreePath, {
      issueNumber: 42,
      targetName: "test",
      branchName: "pourkit/42/test-issue",
      baseBranch: "main",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      completedStages: { builder: true },
      review: { lifetimeIterations: 2 },
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    await startIssueRun({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    const state = readWorktreeRunState(worktreePath);
    expect(state?.baseBranch).toBe("main");
  });

  it("published history refusal still prevents rebase", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "merge-base" &&
        args[1] === "--is-ancestor"
      ) {
        throw new Error("not ancestor");
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    mkdirSync(worktreePath, { recursive: true });
    writeWorktreeRunState(worktreePath, {
      issueNumber: 42,
      targetName: "test",
      branchName: "pourkit/42/test-issue",
      baseBranch: "main",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      completedStages: { builder: true },
      review: { lifetimeIterations: 0 },
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    vi.mocked(prProvider.getPr).mockResolvedValue(
      makePullRequest({ state: "OPEN" })
    );

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: true,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow("Cannot auto-refresh published history");

    expect(execCaptureMock).not.toHaveBeenCalledWith(
      "git",
      ["rebase", "--autostash", "origin/main"],
      expect.anything()
    );
  });

  it("skips base refresh when existing worktree branch is current", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "merge-base" &&
        args[1] === "--is-ancestor"
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    mkdirSync(worktreePath, { recursive: true });
    writeWorktreeRunState(worktreePath, {
      issueNumber: 42,
      targetName: "test",
      branchName: "pourkit/42/test-issue",
      baseBranch: "main",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      completedStages: { builder: true },
      review: { lifetimeIterations: 0 },
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(execCaptureMock).not.toHaveBeenCalledWith(
      "git",
      ["rebase", "--autostash", "origin/main"],
      expect.anything()
    );

    expect(
      executionProvider.calls.some((call) => call.stage === "builder")
    ).toBe(false);
  });

  it("creates worktree from existing branch and reruns builder when state is missing", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      if (command === "git" && args[0] === "status") {
        return { code: 0, stdout: "?? changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: false,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(execCaptureMock).not.toHaveBeenCalledWith(
      "git",
      ["branch", "-D", expect.any(String)],
      expect.anything()
    );

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", expect.any(String), "pourkit/42/test-issue"],
      expect.anything()
    );

    const builderCall = executionProvider.calls.find(
      (call) => call.stage === "builder"
    );
    expect(builderCall).toBeDefined();
    expect(builderCall?.worktreePath).toBe(
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue"
    );

    const reviewCall = executionProvider.calls.find(
      (call) => call.stage === "reviewer"
    );
    expect(reviewCall?.worktreePath).toBe(
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue"
    );
  });

  it("refreshes stale existing branch and skips builder", async () => {
    let mergeBaseCalls = 0;
    execCaptureMock.mockImplementation(async (command, args) => {
      if (
        command === "git" &&
        args[0] === "merge-base" &&
        args[1] === "--is-ancestor"
      ) {
        mergeBaseCalls++;
        if (mergeBaseCalls === 1) {
          throw new Error("not ancestor");
        }
      }
      if (command === "git" && args[0] === "rebase") {
        return {
          code: 0,
          stdout:
            "Successfully rebased and updated refs/heads/pourkit/42/test-issue.\n",
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    mkdirSync(worktreePath, { recursive: true });
    writeWorktreeRunState(worktreePath, {
      issueNumber: 42,
      targetName: "test",
      branchName: "pourkit/42/test-issue",
      baseBranch: "main",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      completedStages: { builder: true },
      review: { lifetimeIterations: 0 },
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["show-ref", "--verify", "--quiet", "refs/heads/pourkit/42/test-issue"],
      expect.anything()
    );

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", expect.any(String), "pourkit/42/test-issue"],
      expect.anything()
    );

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["rebase", "--autostash", "origin/main"],
      expect.objectContaining({ cwd: worktreePath })
    );

    expect(
      executionProvider.calls.some((call) => call.stage === "builder")
    ).toBe(false);
  });

  it("force does not reset worktree", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }

      return { code: 0, stdout: "", stderr: "" };
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(execCaptureMock).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "remove"]),
      expect.anything()
    );
  });

  it("reset-worktree refuses open PR", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "show-ref") {
        throw new Error("branch not found");
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    vi.mocked(prProvider.getPr).mockResolvedValue(
      makePullRequest({ state: "OPEN" })
    );

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        resetWorktree: true,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow(/open PR/i);

    expect(execCaptureMock).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["branch", "-D"]),
      expect.anything()
    );
  });

  it("reset-worktree deletes existing worktree and branch then starts fresh", async () => {
    let worktreeListCallCount = 0;
    let showRefCallCount = 0;

    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        worktreeListCallCount++;
        if (worktreeListCallCount === 1) {
          return {
            code: 0,
            stdout: [
              "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
              "HEAD abc123",
              "branch refs/heads/pourkit/42/test-issue",
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }

      if (command === "git" && args[0] === "show-ref") {
        showRefCallCount++;
        if (showRefCallCount === 1) {
          return { code: 0, stdout: "", stderr: "" };
        }
        throw new Error("branch not found");
      }

      return { code: 0, stdout: "", stderr: "" };
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    vi.mocked(prProvider.getPr).mockResolvedValue(null);

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: false,
      resetWorktree: true,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "remove", "--force"]),
      expect.anything()
    );

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["branch", "-D"]),
      expect.anything()
    );

    expect(
      executionProvider.calls.some((call) => call.stage === "builder")
    ).toBe(true);
  });

  it("reset-worktree deletes detached issue worktree left by conflicted rebase", async () => {
    let worktreeListCallCount = 0;
    let showRefCallCount = 0;

    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        worktreeListCallCount++;
        if (worktreeListCallCount === 1) {
          return {
            code: 0,
            stdout: [
              "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
              "HEAD abc123",
              "detached",
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }

      if (command === "git" && args[0] === "show-ref") {
        showRefCallCount++;
        if (showRefCallCount === 1) {
          return { code: 0, stdout: "", stderr: "" };
        }
        throw new Error("branch not found");
      }

      return { code: 0, stdout: "", stderr: "" };
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    vi.mocked(prProvider.getPr).mockResolvedValue(null);

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: false,
      resetWorktree: true,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      [
        "worktree",
        "remove",
        "--force",
        "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
      ],
      expect.anything()
    );

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["branch", "-D"]),
      expect.anything()
    );
  });

  it("moves issue to ready-for-human if start transition partially fails", async () => {
    const config = makeConfig();

    class FailingProvider extends FakeIssueProvider {
      override async removeLabel(
        issueNumber: number,
        label: string
      ): Promise<void> {
        if (label === "ready-for-agent") {
          throw new Error("remove failed");
        }

        await super.removeLabel(issueNumber, label);
      }
    }

    const issueProvider = new FailingProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider: makePrProvider(),
        executionProvider,
        force: false,
        logger: makeLogger(),
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow("remove failed");

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).toContain("ready-for-agent");
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
  });

  it("moves issue to ready-for-human when the Sandcastle run fails", async () => {
    executionProvider.result = {
      success: false,
      branch: "",
      worktreePath: "",
      commits: [],
      logPath: null,
      error: "boom",
    };

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config: makeConfig(),
        issueProvider,
        prProvider: makePrProvider(),
        executionProvider,
        force: false,
        logger: makeLogger(),
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow("Sandcastle failed: boom");

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
  });

  it("moves issue to ready-for-human when check waiting fails", async () => {
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    vi.mocked(prProvider.waitForPrChecks).mockRejectedValue(
      new Error("Checks failed: test=FAILURE")
    );

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config: makeConfig(),
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger: makeLogger(),
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow("Checks failed: test=FAILURE");

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
  });

  it("creates PR when reviewer returns PASS", async () => {
    const testDir = "/tmp/pourkit-issue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${testDir}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const artifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/reviewers/iteration-1.md`;

    const reviewResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: [],
      logPath: null,
    };

    const config = makeConfig({ reviewerEnabled: true });
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    let callCount = 0;
    const multiExecutionProvider = {
      async execute(opts: any) {
        callCount++;
        if (callCount === 1) {
          return builderResult;
        }
        if (opts.stage === "finalizer") {
          writeSyntheticStageArtifact(opts, builderResult.worktreePath, "PASS");
          return reviewResult;
        }
        const reviewerArtifactPath = join(
          opts.worktreePath ?? builderResult.worktreePath,
          opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
        );
        mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
        writeReviewerArtifact(reviewerArtifactPath, "PASS");
        return reviewResult;
      },
    };

    const result = await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider: multiExecutionProvider as any,
      force: false,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(result.prNumber).toBe(7);
    expect(prProvider.createPr).toHaveBeenCalled();
    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).not.toContain("pr-open-awaiting-merge");

    const state = readWorktreeRunState(builderResult.worktreePath);
    expect(state).not.toBeNull();
    expect(state!.review.lifetimeIterations).toBe(1);
    expect(state!.review.lastVerdict).toBe("PASS");
    expect(state!.review.lastArtifactPath).toBe(
      join(builderResult.worktreePath, ".pourkit/.tmp/reviewers/iteration-1.md")
    );
    expect(state!.review.refactorCompletedForLastReview).toBe(false);
    expect(state!.review.exhaustedPreviousRun).toBeUndefined();
  });

  it("uses resolved branchName when builder execution result omits branch", async () => {
    const testDir = "/tmp/pourkit-issue-test";
    const worktreePath = `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`;
    const builderResult = {
      success: true,
      branch: undefined,
      worktreePath,
      commits: ["fix: implement feature"],
      logPath: `${testDir}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    } as unknown as ExecutionResult;

    const reviewResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath,
      commits: [],
      logPath: null,
    };

    const config = makeConfig({ reviewerEnabled: true });
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();
    const executionCalls: Array<{ stage: string; branchName: string }> = [];

    let callCount = 0;
    const multiExecutionProvider = {
      async execute(opts: any) {
        executionCalls.push({ stage: opts.stage, branchName: opts.branchName });
        callCount++;
        if (callCount === 1) {
          return builderResult;
        }
        if (opts.stage === "finalizer") {
          writeSyntheticStageArtifact(opts, worktreePath, "PASS");
          return reviewResult;
        }
        const reviewerArtifactPath = join(
          opts.worktreePath ?? worktreePath,
          opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
        );
        mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
        writeReviewerArtifact(reviewerArtifactPath, "PASS");
        return reviewResult;
      },
    };

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider: multiExecutionProvider as any,
      force: false,
      logger,
      repoRoot: testDir,
    });

    expect(executionCalls).toEqual(
      expect.arrayContaining([
        { stage: "builder", branchName: "pourkit/42/test-issue" },
        { stage: "reviewer", branchName: "pourkit/42/test-issue" },
        { stage: "finalizer", branchName: "pourkit/42/test-issue" },
      ])
    );
    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["push", "-u", "origin", "pourkit/42/test-issue"],
      expect.objectContaining({ cwd: worktreePath, label: "git push" })
    );
  });

  it("creates PR when reviewer returns PASS_WITH_NOTES", async () => {
    const testDir = "/tmp/pourkit-issue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${testDir}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const artifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/reviewers/iteration-1.md`;

    const reviewResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: [],
      logPath: null,
    };

    const config = makeConfig({ reviewerEnabled: true });
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    let callCount = 0;
    let refactorHasRun = false;
    const multiExecutionProvider = {
      async execute(opts: any) {
        callCount++;
        if (callCount === 1) {
          return builderResult;
        }
        if (opts.stage === "finalizer") {
          writeSyntheticStageArtifact(opts, builderResult.worktreePath, "PASS");
          return reviewResult;
        }
        if (opts.stage === "refactor") {
          refactorHasRun = true;
          const refactorArtifactPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/refactors/iteration-1.md"
          );
          mkdirSync(join(refactorArtifactPath, ".."), { recursive: true });
          writeFileSync(
            refactorArtifactPath,
            [
              "## Finding Responses",
              "",
              "| Finding ID | Classification | Rationale | Files Changed |",
              "|------------|----------------|-----------|---------------|",
              "| R1.F1 | accepted | Fixed the issue | src/test.ts |",
              "",
              "## Verification",
              "",
              "| Command | Result | Notes |",
              "|---------|--------|-------|",
              "| npm test | passed | All good |",
              "",
              "## Open Blockers",
              "",
              "| Blocker | Needed From |",
              "|---------|-------------|",
              "| none | n/a |",
              "",
            ].join("\n"),
            "utf-8"
          );
          return reviewResult;
        }
        const reviewerArtifactPath = join(
          opts.worktreePath ?? builderResult.worktreePath,
          opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
        );
        mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
        writeReviewerArtifact(
          reviewerArtifactPath,
          "PASS_WITH_NOTES",
          refactorHasRun
        );
        return reviewResult;
      },
    };

    const result = await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider: multiExecutionProvider as any,
      force: false,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(result.prNumber).toBe(7);
    expect(prProvider.createPr).toHaveBeenCalled();
  });

  it("does not push or create PR when reviewer returns FAIL", async () => {
    const testDir = "/tmp/pourkit-issue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${testDir}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const artifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/reviewers/iteration-1.md`;

    const reviewResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: [],
      logPath: null,
    };

    const config = makeConfig({ reviewerEnabled: true });
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    let callCount = 0;
    let refactorHasRun = false;
    const multiExecutionProvider = {
      async execute(opts: any) {
        callCount++;
        if (callCount === 1) {
          return builderResult;
        }
        if (opts.stage === "finalizer") {
          writeSyntheticStageArtifact(opts, builderResult.worktreePath, "PASS");
          return reviewResult;
        }
        if (opts.stage === "refactor") {
          refactorHasRun = true;
          const refactorArtifactPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/refactors/iteration-1.md"
          );
          mkdirSync(join(refactorArtifactPath, ".."), { recursive: true });
          writeFileSync(
            refactorArtifactPath,
            [
              "## Finding Responses",
              "",
              "| Finding ID | Classification | Rationale | Files Changed |",
              "|------------|----------------|-----------|---------------|",
              "| R1.F1 | accepted | Fixed the issue | src/test.ts |",
              "",
              "## Verification",
              "",
              "| Command | Result | Notes |",
              "|---------|--------|-------|",
              "| npm test | passed | All good |",
              "",
              "## Open Blockers",
              "",
              "| Blocker | Needed From |",
              "|---------|-------------|",
              "| none | n/a |",
              "",
            ].join("\n"),
            "utf-8"
          );
          return reviewResult;
        }
        const reviewerArtifactPath = join(
          opts.worktreePath ?? builderResult.worktreePath,
          opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
        );
        mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
        writeReviewerArtifact(reviewerArtifactPath, "FAIL", refactorHasRun);
        return reviewResult;
      },
    };

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider: multiExecutionProvider as any,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow("Max review iterations (3) exhausted");
    expect(
      execCaptureMock.mock.calls.some(
        ([command, args]) => command === "git" && args[0] === "push"
      )
    ).toBe(false);
    expect(prProvider.createPr).not.toHaveBeenCalled();

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
    expect(updatedIssue.labels).not.toContain("pr-open-awaiting-merge");
  });

  it("FAIL verdict still runs refactor", async () => {
    const testDir = "/tmp/pourkit-issue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${testDir}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const config = makeConfig({
      reviewerEnabled: true,
      refactor: {
        agent: "refactor",
        model: "test-refactor",
        promptTemplate: "refactor.prompt.md",
      },
    });

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    const stageCalls: string[] = [];
    let refactorHasRun = false;
    const multiExecutionProvider = {
      async execute(opts: any) {
        stageCalls.push(opts.stage);
        if (opts.stage === "builder") {
          return builderResult;
        }
        if (opts.stage === "reviewer") {
          const reviewerArtifactPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
          );
          mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
          writeReviewerArtifact(reviewerArtifactPath, "FAIL", refactorHasRun);
        }
        if (opts.stage === "refactor") {
          refactorHasRun = true;
          const refactorArtifactPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/refactors/iteration-1.md"
          );
          mkdirSync(join(refactorArtifactPath, ".."), { recursive: true });
          writeFileSync(
            refactorArtifactPath,
            [
              "## Finding Responses",
              "",
              "| Finding ID | Classification | Rationale | Files Changed |",
              "|------------|----------------|-----------|---------------|",
              "| R1.F1 | accepted | Fixed the issue | src/test.ts |",
              "",
              "## Verification",
              "",
              "| Command | Result | Notes |",
              "|---------|--------|-------|",
              "| npm test | passed | All good |",
              "",
              "## Open Blockers",
              "",
              "| Blocker | Needed From |",
              "|---------|-------------|",
              "| none | n/a |",
              "",
            ].join("\n"),
            "utf-8"
          );
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: builderResult.worktreePath,
          commits: [],
          logPath: null,
        };
      },
    };

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider: multiExecutionProvider as any,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow("Max review iterations (3) exhausted");

    expect(stageCalls).toContain("refactor");
    expect(
      execCaptureMock.mock.calls.some(
        ([command, args]) => command === "git" && args[0] === "push"
      )
    ).toBe(false);
    expect(prProvider.createPr).not.toHaveBeenCalled();

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
  });

  it("NEEDS_HUMAN stops before refactor", async () => {
    const testDir = "/tmp/pourkit-issue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${testDir}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const config = makeConfig({
      reviewerEnabled: true,
      refactor: {
        agent: "refactor",
        model: "test-refactor",
        promptTemplate: "refactor.prompt.md",
      },
    });

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();
    const repoRoot = repoRootMock();

    const stageCalls: string[] = [];
    const multiExecutionProvider = {
      async execute(opts: any) {
        stageCalls.push(opts.stage);
        if (opts.stage === "builder") {
          return builderResult;
        }
        if (opts.stage === "reviewer") {
          const reviewerArtifactPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
          );
          mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
          writeFileSync(
            reviewerArtifactPath,
            [
              "## Findings",
              "",
              "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
              "|----|------------|----------|-----------|-------|----------------|",
              "| R1.F1 | - | high | src/test.ts:10 | Something wrong | Fix it |",
              "",
              "## Summary",
              "",
              "Needs human decision.",
              "",
              "## Human Handoff Summary",
              "",
              "Human decision required.",
              "",
              "## Human Handoff Reason",
              "",
              "Details about what needs human input.",
              "",
              "<verdict>NEEDS_HUMAN</verdict>",
            ].join("\n"),
            "utf-8"
          );
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: builderResult.worktreePath,
          commits: [],
          logPath: null,
        };
      },
    };

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider: multiExecutionProvider as any,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow("NEEDS_HUMAN");

    expect(stageCalls).not.toContain("refactor");
    expect(prProvider.createPr).not.toHaveBeenCalled();

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
    expect(updatedIssue.labels).not.toContain("ready-for-agent");

    const comments = await issueProvider.getComments(42);
    expect(comments.length).toBeGreaterThanOrEqual(1);
    expect(comments[0]).toContain("Pourkit stopped the review/refactor loop");
    expect(comments[0]).toContain("Human decision required.");
    expect(comments[0]).toContain("Artifacts:");
    expect(comments[0]).toContain("- Review:");
    expect(comments[0]).toContain("- Refactors:");
  });

  it("NEEDS_HUMAN does not create handoff commit", async () => {
    const testDir = "/tmp/pourkit-issue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${testDir}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const config = makeConfig({
      reviewerEnabled: true,
      refactor: {
        agent: "refactor",
        model: "test-refactor",
        promptTemplate: "refactor.prompt.md",
      },
    });

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();
    const repoRoot = repoRootMock();

    const stageCalls: string[] = [];
    const multiExecutionProvider = {
      async execute(opts: any) {
        stageCalls.push(opts.stage);
        if (opts.stage === "builder") {
          return builderResult;
        }
        if (opts.stage === "reviewer") {
          const reviewerArtifactPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
          );
          mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
          writeFileSync(
            reviewerArtifactPath,
            [
              "## Findings",
              "",
              "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
              "|----|------------|----------|-----------|-------|----------------|",
              "| R1.F1 | - | high | src/test.ts:10 | Something wrong | Fix it |",
              "",
              "## Human Handoff Summary",
              "",
              "Human decision required.",
              "",
              "## Human Handoff Reason",
              "",
              "Details about what needs human input.",
              "",
              "<verdict>NEEDS_HUMAN</verdict>",
            ].join("\n"),
            "utf-8"
          );
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: builderResult.worktreePath,
          commits: [],
          logPath: null,
        };
      },
    };

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider: multiExecutionProvider as any,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow("NEEDS_HUMAN");

    expect(stageCalls).not.toContain("finalizer");
    expect(prProvider.createPr).toHaveBeenCalledTimes(0);
    expect(execCaptureMock).not.toHaveBeenCalledWith(
      "git",
      ["commit", "-m", expect.any(String), "-m", expect.any(String)],
      expect.anything()
    );
    expect(execCaptureMock).not.toHaveBeenCalledWith(
      "git",
      ["push", "-u", "origin", expect.any(String)],
      expect.anything()
    );
  });

  it("does not push or create PR on review protocol failure", async () => {
    const testDir = "/tmp/pourkit-issue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${testDir}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const artifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/reviewers/iteration-1.md`;

    const reviewResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: [],
      logPath: null,
    };

    const config = makeConfig({ reviewerEnabled: true });
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    let callCount = 0;
    const multiExecutionProvider = {
      async execute(opts: any) {
        callCount++;
        if (callCount === 1) {
          return builderResult;
        }
        if (opts.stage === "finalizer") {
          writeSyntheticStageArtifact(opts, builderResult.worktreePath, "PASS");
          return reviewResult;
        }
        const reviewerArtifactPath = join(
          opts.worktreePath ?? builderResult.worktreePath,
          opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
        );
        mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
        writeFileSync(reviewerArtifactPath, "no verdict here", "utf-8");
        return reviewResult;
      },
    };

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider: multiExecutionProvider as any,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow("Review protocol error");

    expect(
      execCaptureMock.mock.calls.some(
        ([command, args]) => command === "git" && args[0] === "push"
      )
    ).toBe(false);
    expect(prProvider.createPr).not.toHaveBeenCalled();

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
    expect(updatedIssue.labels).not.toContain("pr-open-awaiting-merge");
  });

  it("creates PR when NEEDS_REFACTOR leads to PASS after refactor", async () => {
    const testDir = "/tmp/pourkit-issue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${testDir}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const artifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/reviewers/iteration-1.md`;

    const config = makeConfig({
      reviewerEnabled: true,
      refactor: {
        agent: "refactor",
        model: "test-refactor",
        promptTemplate: "refactor.prompt.md",
      },
    });

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    let callCount = 0;
    let refactorHasRun = false;
    const multiExecutionProvider = {
      async execute(opts: any) {
        callCount++;
        if (callCount === 1) {
          return builderResult;
        }
        if (opts.stage === "finalizer") {
          writeSyntheticStageArtifact(opts, builderResult.worktreePath, "PASS");
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath: builderResult.worktreePath,
            commits: [],
            logPath: null,
          };
        }
        if (callCount === 2) {
          const reviewerArtifactPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
          );
          mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
          writeReviewerArtifact(reviewerArtifactPath, "NEEDS_REFACTOR");
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath: builderResult.worktreePath,
            commits: [],
            logPath: null,
          };
        }
        if (callCount === 3) {
          refactorHasRun = true;
          const refactorArtifactPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/refactors/iteration-1.md"
          );
          mkdirSync(join(refactorArtifactPath, ".."), { recursive: true });
          writeFileSync(
            refactorArtifactPath,
            [
              "## Finding Responses",
              "",
              "| Finding ID | Classification | Rationale | Files Changed |",
              "|------------|----------------|-----------|---------------|",
              "| R1.F1 | accepted | Fixed the issue | src/test.ts |",
              "",
              "## Verification",
              "",
              "| Command | Result | Notes |",
              "|---------|--------|-------|",
              "| npm test | passed | All tests green |",
              "",
              "## Open Blockers",
              "",
              "| Blocker | Needed From |",
              "|---------|-------------|",
              "| none | n/a |",
              "",
            ].join("\n"),
            "utf-8"
          );
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath: builderResult.worktreePath,
            commits: [],
            logPath: null,
          };
        }
        const reviewerArtifactPath = join(
          opts.worktreePath ?? builderResult.worktreePath,
          opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
        );
        mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
        writeReviewerArtifact(reviewerArtifactPath, "PASS", refactorHasRun);
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: builderResult.worktreePath,
          commits: [],
          logPath: null,
        };
      },
    };

    const result = await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider: multiExecutionProvider as any,
      force: false,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(result.prNumber).toBe(7);
    expect(prProvider.createPr).toHaveBeenCalled();
    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).not.toContain("pr-open-awaiting-merge");
  });

  it("invalid refactor artifact stops locally without second reviewer iteration", async () => {
    const testDir = "/tmp/pourkit-issue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${testDir}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const config = makeConfig({
      reviewerEnabled: true,
      refactor: {
        agent: "refactor",
        model: "test-refactor",
        promptTemplate: "refactor.prompt.md",
      },
    });

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    const stageCalls: string[] = [];
    const multiExecutionProvider = {
      async execute(opts: any) {
        stageCalls.push(opts.stage);
        if (opts.stage === "builder") {
          return builderResult;
        }
        if (opts.stage === "reviewer") {
          const reviewerArtifactPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
          );
          mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
          writeReviewerArtifact(reviewerArtifactPath, "NEEDS_REFACTOR");
        }
        // Refactor execution succeeds but writes no artifact
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: builderResult.worktreePath,
          commits: [],
          logPath: null,
        };
      },
    };

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider: multiExecutionProvider as any,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow("Review failed with FAIL verdict");

    const reviewerCalls = stageCalls.filter((stage) => stage === "reviewer");
    expect(reviewerCalls).toHaveLength(1);
    expect(prProvider.createPr).not.toHaveBeenCalled();

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
  });

  it("rejects issue when refactor fails after NEEDS_REFACTOR verdict", async () => {
    const testDir = "/tmp/pourkit-issue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${testDir}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const artifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/reviewers/iteration-1.md`;

    const config = makeConfig({
      reviewerEnabled: true,
      refactor: {
        agent: "refactor",
        model: "test-refactor",
        promptTemplate: "refactor.prompt.md",
      },
    });

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    let callCount = 0;
    const multiExecutionProvider = {
      async execute(opts: any) {
        callCount++;
        if (callCount === 1) {
          return builderResult;
        }
        if (callCount === 2) {
          const reviewerArtifactPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
          );
          mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
          writeReviewerArtifact(reviewerArtifactPath, "NEEDS_REFACTOR");
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath: builderResult.worktreePath,
            commits: [],
            logPath: null,
          };
        }
        return {
          success: false,
          branch: "pourkit/42/test-issue",
          worktreePath: builderResult.worktreePath,
          commits: [],
          logPath: null,
          error: "refactor agent crashed",
        };
      },
    };

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider: multiExecutionProvider as any,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow("Review failed with FAIL verdict");

    expect(prProvider.createPr).not.toHaveBeenCalled();

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
    expect(updatedIssue.labels).not.toContain("pr-open-awaiting-merge");
  });

  it("moves issue to ready-for-human when max iterations exhausted", async () => {
    const testDir = "/tmp/pourkit-issue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${testDir}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const artifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/reviewers/iteration-1.md`;

    const config = makeConfig({
      reviewerEnabled: true,
      refactor: {
        agent: "refactor",
        model: "test-refactor",
        promptTemplate: "refactor.prompt.md",
      },
      maxIterations: 2,
    });

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    let callCount = 0;
    let refactorHasRun = false;
    const multiExecutionProvider = {
      async execute(opts: any) {
        callCount++;
        if (callCount === 1) {
          return builderResult;
        }
        if (opts.stage === "reviewer") {
          const reviewerArtifactPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
          );
          mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
          writeReviewerArtifact(
            reviewerArtifactPath,
            "NEEDS_REFACTOR",
            refactorHasRun
          );
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath: builderResult.worktreePath,
            commits: [],
            logPath: null,
          };
        }
        if (opts.stage === "refactor") {
          refactorHasRun = true;
          const refactorArtifactPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/refactors/iteration-1.md"
          );
          mkdirSync(join(refactorArtifactPath, ".."), { recursive: true });
          writeFileSync(
            refactorArtifactPath,
            [
              "## Finding Responses",
              "",
              "| Finding ID | Classification | Rationale | Files Changed |",
              "|------------|----------------|-----------|---------------|",
              "| R1.F1 | accepted | Fixed the issue | src/test.ts |",
              "",
              "## Verification",
              "",
              "| Command | Result | Notes |",
              "|---------|--------|-------|",
              "| npm test | passed | All good |",
              "",
              "## Open Blockers",
              "",
              "| Blocker | Needed From |",
              "|---------|-------------|",
              "| none | n/a |",
              "",
            ].join("\n"),
            "utf-8"
          );
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: builderResult.worktreePath,
          commits: [],
          logPath: null,
        };
      },
    };

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider: multiExecutionProvider as any,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow("Max review iterations (2) exhausted");

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
  });

  it("creates PR after reviewer NEEDS_REFACTOR, refactor runs, reviewer PASSes, and finalizer succeeds", async () => {
    const testDir = "/tmp/pourkit-issue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${testDir}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const reviewArtifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/reviewers/iteration-1.md`;
    const prDescArtifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/finalizer/agent-output.md`;
    const generatedArtifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/finalizer/generated.md`;

    const repoRoot = repoRootMock();
    const promptFileDir = join(repoRoot, ".pourkit", "prompts");
    const promptFilePath = join(promptFileDir, "finalizer.prompt.md");
    mkdirSync(promptFileDir, { recursive: true });
    writeFileSync(promptFilePath, "Write a finalizer for this issue.", "utf-8");

    const config = makeConfig({
      reviewerEnabled: true,
      refactor: {
        agent: "refactor",
        model: "test-refactor",
        promptTemplate: "refactor.prompt.md",
      },
      finalizer: {
        agent: "pr-desc",
        model: "test-pr-desc",
        promptTemplate: "finalizer.prompt.md",
      },
    });

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    const stageCalls: string[] = [];
    const reviewIterations: number[] = [];
    let refactorHasRun = false;
    const multiExecutionProvider = {
      async execute(opts: any) {
        stageCalls.push(opts.stage);

        if (opts.stage === "builder") {
          return builderResult;
        }

        if (opts.stage === "reviewer") {
          reviewIterations.push(opts.iteration);
          const reviewerArtifactPath = opts.artifactPath
            ? join(
                opts.worktreePath ?? builderResult.worktreePath,
                opts.artifactPath
              )
            : reviewArtifactPath;
          mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
          writeReviewerArtifact(
            reviewerArtifactPath,
            opts.iteration === 1 ? "NEEDS_REFACTOR" : "PASS",
            opts.iteration !== 1 && refactorHasRun
          );
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath: builderResult.worktreePath,
            commits: [],
            logPath: null,
          };
        }

        if (opts.stage === "refactor") {
          refactorHasRun = true;
          const refactorArtifactPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/refactors/iteration-1.md"
          );
          mkdirSync(join(refactorArtifactPath, ".."), { recursive: true });
          writeFileSync(
            refactorArtifactPath,
            [
              "## Finding Responses",
              "",
              "| Finding ID | Classification | Rationale | Files Changed |",
              "|------------|----------------|-----------|---------------|",
              "| R1.F1 | accepted | Fixed the issue | src/test.ts |",
              "",
              "## Verification",
              "",
              "| Command | Result | Notes |",
              "|---------|--------|-------|",
              "| npm test | passed | All good |",
              "",
              "## Open Blockers",
              "",
              "| Blocker | Needed From |",
              "|---------|-------------|",
              "| none | n/a |",
              "",
            ].join("\n"),
            "utf-8"
          );
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath: builderResult.worktreePath,
            commits: ["def456"],
            logPath: null,
          };
        }

        mkdirSync(join(prDescArtifactPath, ".."), { recursive: true });
        writeFileSync(
          prDescArtifactPath,
          "## PR Title\n\nRefactor Loop Generated Title\n\n## PR Body\n\n## Summary\n\n- Why this branch exists.\n\n## Changes\n\n- Refactored change.\n\nCloses #42",
          "utf-8"
        );
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: builderResult.worktreePath,
          commits: [],
          logPath: null,
        };
      },
    };

    const result = await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider: multiExecutionProvider as any,
      force: false,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(stageCalls).toEqual([
      "builder",
      "reviewer",
      "refactor",
      "reviewer",
      "finalizer",
    ]);
    expect(reviewIterations).toEqual([1, 2]);
    expect(prProvider.createPr).toHaveBeenCalledWith({
      title: "chore: Refactor Loop Generated Title",
      body: "## Summary\n\n- Why this branch exists.\n\n## Changes\n\n- Refactored change.\n\nCloses #42",
      head: "pourkit/42/test-issue",
      base: "main",
    });
    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["reset", "--soft", "origin/main"],
      expect.objectContaining({
        cwd: builderResult.worktreePath,
      })
    );
    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["add", "-A"],
      expect.objectContaining({
        cwd: builderResult.worktreePath,
      })
    );
    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      [
        "commit",
        "--no-verify",
        "-m",
        "chore: Refactor Loop Generated Title",
        "-m",
        "## Summary\n\n- Why this branch exists.\n\n## Changes\n\n- Refactored change.\n\nCloses #42",
      ],
      expect.objectContaining({
        cwd: builderResult.worktreePath,
      })
    );
    expect(result.prTitle).toBe("chore: Refactor Loop Generated Title");
    expect(result.prBody).toBe(
      "## Summary\n\n- Why this branch exists.\n\n## Changes\n\n- Refactored change.\n\nCloses #42"
    );
    expect(existsSync(generatedArtifactPath)).toBe(true);

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).not.toContain("pr-open-awaiting-merge");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
  });

  it("moves issue to ready-for-human when refactor execution fails", async () => {
    const testDir = "/tmp/pourkit-issue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${testDir}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const artifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/reviewers/iteration-1.md`;

    const config = makeConfig({
      reviewerEnabled: true,
      refactor: {
        agent: "refactor",
        model: "test-refactor",
        promptTemplate: "refactor.prompt.md",
      },
    });

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    let callCount = 0;
    const multiExecutionProvider = {
      async execute(opts: any) {
        callCount++;
        if (callCount === 1) {
          return builderResult;
        }
        if (callCount === 2) {
          const reviewerArtifactPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
          );
          mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
          writeReviewerArtifact(reviewerArtifactPath, "NEEDS_REFACTOR");
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath: builderResult.worktreePath,
            commits: [],
            logPath: null,
          };
        }
        return {
          success: false,
          branch: "pourkit/42/test-issue",
          worktreePath: builderResult.worktreePath,
          commits: [],
          logPath: null,
          error: "refactor agent crashed",
        };
      },
    };

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider: multiExecutionProvider as any,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow("Review failed with FAIL verdict");

    expect(prProvider.createPr).not.toHaveBeenCalled();

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
  });

  it("creates PR with generated title and body when finalizer stage succeeds", async () => {
    const testDir = "/tmp/pourkit-issue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${testDir}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const reviewArtifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/reviewers/iteration-1.md`;
    const prDescArtifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/finalizer/agent-output.md`;
    const generatedArtifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/finalizer/generated.md`;

    const repoRoot = repoRootMock();
    const promptFileDir = join(repoRoot, ".pourkit", "prompts");
    const promptFilePath = join(promptFileDir, "finalizer.prompt.md");
    mkdirSync(promptFileDir, { recursive: true });
    writeFileSync(promptFilePath, "Write a finalizer for this issue.", "utf-8");

    const config = makeConfig({
      reviewerEnabled: true,
      finalizer: {
        agent: "pr-desc",
        model: "test-pr-desc",
        promptTemplate: "finalizer.prompt.md",
      },
    });

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    let callCount = 0;
    let prDescPrompt: string | undefined;
    const multiExecutionProvider = {
      async execute(opts: any) {
        callCount++;
        if (callCount === 1) {
          return builderResult;
        }
        if (callCount === 2) {
          const reviewerArtifactPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
          );
          mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
          writeReviewerArtifact(reviewerArtifactPath, "PASS");
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath: builderResult.worktreePath,
            commits: [],
            logPath: null,
          };
        }
        prDescPrompt = opts.prompt;
        mkdirSync(join(prDescArtifactPath, ".."), { recursive: true });
        writeFileSync(
          prDescArtifactPath,
          "## PR Title\n\nGenerated PR Title\n\n## PR Body\n\n## Summary\n\n- What this branch does.\n\n## Changes\n\n- Generated change.\n\nCloses #42",
          "utf-8"
        );
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: builderResult.worktreePath,
          commits: [],
          logPath: null,
        };
      },
    };

    const result = await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider: multiExecutionProvider as any,
      force: false,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(result.prNumber).toBe(7);
    expect(prProvider.createPr).toHaveBeenCalledWith({
      title: "chore: Generated PR Title",
      body: "## Summary\n\n- What this branch does.\n\n## Changes\n\n- Generated change.\n\nCloses #42",
      head: "pourkit/42/test-issue",
      base: "main",
    });
    expect(result.prTitle).toBe("chore: Generated PR Title");
    expect(result.prBody).toBe(
      "## Summary\n\n- What this branch does.\n\n## Changes\n\n- Generated change.\n\nCloses #42"
    );
    expect(prDescPrompt).toContain("Write a finalizer for this issue.");
    expect(prDescPrompt).toContain(".pourkit/.tmp/run-context.md");
    expect(existsSync(generatedArtifactPath)).toBe(true);
    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).not.toContain("pr-open-awaiting-merge");
  });

  it("moves issue to ready-for-human when finalizer execution fails", async () => {
    const testDir = "/tmp/pourkit-issue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${testDir}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const reviewArtifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/reviewers/iteration-1.md`;

    const config = makeConfig({
      reviewerEnabled: true,
      finalizer: {
        agent: "pr-desc",
        model: "test-pr-desc",
        promptTemplate: "finalizer.prompt.md",
      },
    });

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    let callCount = 0;
    const multiExecutionProvider = {
      async execute(opts: any) {
        callCount++;
        if (callCount === 1) {
          return builderResult;
        }
        if (callCount === 2) {
          const reviewerArtifactPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
          );
          mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
          writeReviewerArtifact(reviewerArtifactPath, "PASS");
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath: builderResult.worktreePath,
            commits: [],
            logPath: null,
          };
        }
        return {
          success: false,
          branch: "pourkit/42/test-issue",
          worktreePath: builderResult.worktreePath,
          commits: [],
          logPath: null,
          error: "finalizer agent crashed",
        };
      },
    };

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider: multiExecutionProvider as any,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow(
      "Finalizer agent execution failed: finalizer agent crashed"
    );

    expect(execCaptureMock).not.toHaveBeenCalledWith(
      "git",
      ["push", "-u", "origin", "pourkit/42/test-issue"],
      expect.any(Object)
    );
    expect(prProvider.createPr).not.toHaveBeenCalled();

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
  });

  it("moves issue to ready-for-human on finalizer protocol failure", async () => {
    const testDir = "/tmp/pourkit-issue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${testDir}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const reviewArtifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/reviewers/iteration-1.md`;
    const prDescArtifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/finalizer/agent-output.md`;

    const config = makeConfig({
      reviewerEnabled: true,
      finalizer: {
        agent: "pr-desc",
        model: "test-pr-desc",
        promptTemplate: "finalizer.prompt.md",
      },
    });

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    let callCount = 0;
    const multiExecutionProvider = {
      async execute(opts: any) {
        callCount++;
        if (callCount === 1) {
          return builderResult;
        }
        if (callCount === 2) {
          const reviewerArtifactPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
          );
          mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
          writeReviewerArtifact(reviewerArtifactPath, "PASS");
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath: builderResult.worktreePath,
            commits: [],
            logPath: null,
          };
        }
        mkdirSync(join(prDescArtifactPath, ".."), { recursive: true });
        writeFileSync(
          prDescArtifactPath,
          "## Wrong Heading\n\nContent\n\n## PR Body\n\nBody",
          "utf-8"
        );
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: builderResult.worktreePath,
          commits: [],
          logPath: null,
        };
      },
    };

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider: multiExecutionProvider as any,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow("Finalizer protocol error");

    expect(execCaptureMock).not.toHaveBeenCalledWith(
      "git",
      ["push", "-u", "origin", "pourkit/42/test-issue"],
      expect.any(Object)
    );
    expect(prProvider.createPr).not.toHaveBeenCalled();

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
  });

  it("falls back to template rendering when finalizer is set without reviewer", async () => {
    const config = makeConfig({
      reviewerEnabled: false,
      finalizer: {
        agent: "pr-desc",
        model: "test-pr-desc",
        promptTemplate: "finalizer.prompt.md",
      },
    });
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    const result = await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: false,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(result.prNumber).toBe(7);
    expect(prProvider.createPr).toHaveBeenCalledWith({
      title: "fix: Test issue",
      body: "Closes #42",
      head: "pourkit/42/test-issue",
      base: "main",
    });
    expect(result.prTitle).toBe("fix: Test issue");
    expect(result.prBody).toBe("Closes #42");
    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).not.toContain("pr-open-awaiting-merge");
  });

  it("normalizes closing footer: strips parent, sibling, and unrelated refs leaving exactly one current-Issue footer", async () => {
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${TEST_DIR}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${TEST_DIR}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const artifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/finalizer/agent-output.md`;

    const repoRoot = repoRootMock();
    const promptFileDir = join(repoRoot, ".pourkit", "prompts");
    mkdirSync(promptFileDir, { recursive: true });
    writeFileSync(
      join(promptFileDir, "finalizer.prompt.md"),
      "Write a finalizer.",
      "utf-8"
    );

    const config = makeConfig({
      reviewerEnabled: true,
      finalizer: {
        agent: "pr-desc",
        model: "test-pr-desc",
        promptTemplate: "finalizer.prompt.md",
      },
    });

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    let callCount = 0;
    const multiExecutionProvider = {
      async execute(opts: any) {
        callCount++;
        if (callCount === 1) {
          return builderResult;
        }
        if (callCount === 2) {
          const reviewerArtifactPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
          );
          mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
          writeReviewerArtifact(reviewerArtifactPath, "PASS");
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath: builderResult.worktreePath,
            commits: [],
            logPath: null,
          };
        }
        mkdirSync(join(artifactPath, ".."), { recursive: true });
        writeFileSync(
          artifactPath,
          [
            "## PR Title",
            "",
            "fix: Test issue",
            "",
            "## PR Body",
            "",
            "## Summary",
            "",
            "- Why this branch exists.",
            "",
            "## Changes",
            "",
            "- Final net change 1.",
            "",
            "Closes #42",
            "Fixes #77",
            "Closes #1202",
          ].join("\n"),
          "utf-8"
        );
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: builderResult.worktreePath,
          commits: [],
          logPath: null,
        };
      },
    };

    const result = await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider: multiExecutionProvider as any,
      force: false,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(result.prBody!).toContain("## Summary");
    expect(result.prBody!).toContain("## Changes");
    expect(result.prBody!.match(/Closes #42/g)).toHaveLength(1);
    expect(result.prBody!).not.toContain("Closes #1202");
    expect(result.prBody!).not.toContain("Fixes #77");
  });

  it("normalizes closing footer on resume: strips stale closing refs from saved finalizer state", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    const stateDir = join(worktreePath, ".pourkit");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "state.json"),
      JSON.stringify({
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true, initialVerification: true },
        review: {
          lifetimeIterations: 1,
          lastVerdict: "PASS",
          lastArtifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/reviewers/iteration-1.md",
          refactorCompletedForLastReview: true,
        },
        finalizer: {
          completed: true,
          artifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/finalizer/agent-output.md",
          title: "fix: Test issue",
          body: "## Summary\n\n- Summary here.\n\n## Changes\n\n- Change here.\n\nCloses #42\nFixes #77\nCloses #1202",
        },
      }),
      "utf-8"
    );

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();

    await runIssueCommand({
      issueNumber: 42,
      config: makeConfig(),
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger: makeLogger(),
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(
      executionProvider.calls.some((call) => call.stage === "finalizer")
    ).toBe(false);

    expect(prProvider.createPr).toHaveBeenCalled();
    const createPrCall = vi.mocked(prProvider.createPr).mock.calls[0][0];
    expect(createPrCall.body).toContain("## Summary");
    expect(createPrCall.body).toContain("## Changes");
    expect(createPrCall.body.match(/Closes #42/g)).toHaveLength(1);
    expect(createPrCall.body).not.toContain("Closes #1202");
    expect(createPrCall.body).not.toContain("Fixes #77");
  });

  describe("merged-and-green flow", () => {
    it("completes full success path: merge + target-green", async () => {
      const config = makeConfig({
        builder: {
          agent: "build",
          model: "test",
          promptTemplate: "builder.prompt.md",
        },
      });
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();
      const repoRoot = repoRootMock();
      const promptFileDir = join(repoRoot, ".pourkit", "prompts");
      const promptFilePath = join(promptFileDir, "builder.prompt.md");
      mkdirSync(promptFileDir, { recursive: true });
      writeFileSync(promptFilePath, "Implement the issue.", "utf-8");

      vi.mocked(prProvider.getBranchStatus).mockResolvedValue({
        headSha: "def456",
        state: "green",
        checks: [
          {
            name: "ci",
            conclusion: "SUCCESS" as const,
            status: "COMPLETED" as const,
          },
        ],
      });

      const result = await runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      });

      expect(prProvider.mergePr).toHaveBeenCalledWith(7, {
        method: "squash",
        matchHeadCommit: "abc123",
      });
      expect(prProvider.enableAutoMerge).not.toHaveBeenCalled();
      expect(prProvider.getBranchStatus).toHaveBeenCalled();
      expect(result.prNumber).toBe(7);
      const updatedIssue = await issueProvider.fetchIssue(42);
      expect(updatedIssue.labels).not.toContain("pr-open-awaiting-merge");
      expect(updatedIssue.state).toBe("closed");
    });

    it("closes the Issue after direct auto merge", async () => {
      const config = makeConfig({
        builder: {
          agent: "build",
          model: "test",
          promptTemplate: "builder.prompt.md",
        },
      });
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();
      const repoRoot = repoRootMock();
      const promptFileDir = join(repoRoot, ".pourkit", "prompts");
      const promptFilePath = join(promptFileDir, "builder.prompt.md");
      mkdirSync(promptFileDir, { recursive: true });
      writeFileSync(promptFilePath, "Implement the issue.", "utf-8");

      vi.mocked(prProvider.getBranchStatus).mockResolvedValue({
        headSha: "def456",
        state: "green",
        checks: [
          {
            name: "ci",
            conclusion: "SUCCESS" as const,
            status: "COMPLETED" as const,
          },
        ],
      });

      vi.spyOn(issueProvider, "closeIssue");

      const result = await runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      });

      expect(issueProvider.closeIssue).toHaveBeenCalledWith(42);
      expect(result.noOp).toBe(false);
    });

    it("closes the parent PRD when the current child is the last open child", async () => {
      const config = makeConfig({
        builder: {
          agent: "build",
          model: "test",
          promptTemplate: "builder.prompt.md",
        },
      });
      const issueProvider = new FakeIssueProvider([
        {
          number: 42,
          title: "PRD-002 / I-02: Second child",
          body: "## Parent\n\nPRD-002 (#20)",
          state: "open",
          labels: ["ready-for-agent"],
          comments: [],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
        {
          number: 1,
          title: "PRD-002 / I-01: First child",
          body: "## Parent\n\nPRD-002 (#20)",
          state: "closed",
          labels: [],
          comments: [],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
        {
          number: 20,
          title: "PRD-002: Some parent PRD",
          body: "## Description\n\nParent body.",
          state: "open",
          labels: [],
          comments: [],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();
      const repoRoot = repoRootMock();
      const promptFileDir = join(repoRoot, ".pourkit", "prompts");
      const promptFilePath = join(promptFileDir, "builder.prompt.md");
      mkdirSync(promptFileDir, { recursive: true });
      writeFileSync(promptFilePath, "Implement the issue.", "utf-8");

      vi.mocked(prProvider.getBranchStatus).mockResolvedValue({
        headSha: "def456",
        state: "green",
        checks: [
          {
            name: "ci",
            conclusion: "SUCCESS" as const,
            status: "COMPLETED" as const,
          },
        ],
      });

      vi.spyOn(issueProvider, "closeIssue");

      await runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      });

      expect(issueProvider.closeIssue).toHaveBeenCalledWith(42);
      expect(issueProvider.closeIssue).toHaveBeenCalledWith(20);
    });

    it("does not close the parent PRD when a sibling child remains open", async () => {
      const config = makeConfig({
        builder: {
          agent: "build",
          model: "test",
          promptTemplate: "builder.prompt.md",
        },
      });
      const issueProvider = new FakeIssueProvider([
        {
          number: 42,
          title: "PRD-002 / I-02: Second child",
          body: "## Parent\n\nPRD-002 (#20)",
          state: "open",
          labels: ["ready-for-agent"],
          comments: [],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
        {
          number: 1,
          title: "PRD-002 / I-01: First child",
          body: "## Parent\n\nPRD-002 (#20)",
          state: "open",
          labels: [],
          comments: [],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
        {
          number: 20,
          title: "PRD-002: Some parent PRD",
          body: "## Description\n\nParent body.",
          state: "open",
          labels: [],
          comments: [],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();
      const repoRoot = repoRootMock();
      const promptFileDir = join(repoRoot, ".pourkit", "prompts");
      const promptFilePath = join(promptFileDir, "builder.prompt.md");
      mkdirSync(promptFileDir, { recursive: true });
      writeFileSync(promptFilePath, "Implement the issue.", "utf-8");

      vi.mocked(prProvider.getBranchStatus).mockResolvedValue({
        headSha: "def456",
        state: "green",
        checks: [
          {
            name: "ci",
            conclusion: "SUCCESS" as const,
            status: "COMPLETED" as const,
          },
        ],
      });

      vi.spyOn(issueProvider, "closeIssue");

      await runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      });

      expect(issueProvider.closeIssue).toHaveBeenCalledTimes(1);
      expect(issueProvider.closeIssue).toHaveBeenCalledWith(42);
    });

    it("does not trigger parent lookup for a standalone Issue", async () => {
      const config = makeConfig({
        builder: {
          agent: "build",
          model: "test",
          promptTemplate: "builder.prompt.md",
        },
      });
      const issueProvider = new FakeIssueProvider([
        {
          number: 42,
          title: "Standalone issue",
          body: "No parent reference.",
          state: "open",
          labels: ["ready-for-agent"],
          comments: [],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();
      const repoRoot = repoRootMock();
      const promptFileDir = join(repoRoot, ".pourkit", "prompts");
      const promptFilePath = join(promptFileDir, "builder.prompt.md");
      mkdirSync(promptFileDir, { recursive: true });
      writeFileSync(promptFilePath, "Implement the issue.", "utf-8");

      vi.mocked(prProvider.getBranchStatus).mockResolvedValue({
        headSha: "def456",
        state: "green",
        checks: [
          {
            name: "ci",
            conclusion: "SUCCESS" as const,
            status: "COMPLETED" as const,
          },
        ],
      });

      vi.spyOn(issueProvider, "closeIssue");

      await runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      });

      expect(issueProvider.closeIssue).toHaveBeenCalledTimes(1);
      expect(issueProvider.closeIssue).toHaveBeenCalledWith(42);
    });

    it("does not close parent when parent metadata is malformed", async () => {
      const config = makeConfig({
        builder: {
          agent: "build",
          model: "test",
          promptTemplate: "builder.prompt.md",
        },
      });
      const issueProvider = new FakeIssueProvider([
        {
          number: 42,
          title: "PRD-002 / I-01: Child with no actual parent",
          body: "",
          state: "open",
          labels: ["ready-for-agent"],
          comments: [],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();
      const repoRoot = repoRootMock();
      const promptFileDir = join(repoRoot, ".pourkit", "prompts");
      const promptFilePath = join(promptFileDir, "builder.prompt.md");
      mkdirSync(promptFileDir, { recursive: true });
      writeFileSync(promptFilePath, "Implement the issue.", "utf-8");

      vi.mocked(prProvider.getBranchStatus).mockResolvedValue({
        headSha: "def456",
        state: "green",
        checks: [
          {
            name: "ci",
            conclusion: "SUCCESS" as const,
            status: "COMPLETED" as const,
          },
        ],
      });

      vi.spyOn(issueProvider, "closeIssue");

      await runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      });

      expect(issueProvider.closeIssue).toHaveBeenCalledTimes(1);
      expect(issueProvider.closeIssue).toHaveBeenCalledWith(42);
    });

    it("does not close parent when body and title parent refs disagree", async () => {
      const config = makeConfig({
        builder: {
          agent: "build",
          model: "test",
          promptTemplate: "builder.prompt.md",
        },
      });
      const issueProvider = new FakeIssueProvider([
        {
          number: 42,
          title: "PRD-002 / I-01: Child with body mismatch",
          body: "## Parent\n\nPRD-999 (#99)",
          state: "open",
          labels: ["ready-for-agent"],
          comments: [],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
        {
          number: 99,
          title: "PRD-999: Wrong parent PRD",
          body: "## Description\n\nWrong parent.",
          state: "open",
          labels: [],
          comments: [],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
        {
          number: 20,
          title: "PRD-002: Real parent PRD",
          body: "## Description\n\nReal parent.",
          state: "open",
          labels: [],
          comments: [],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();
      const repoRoot = repoRootMock();
      const promptFileDir = join(repoRoot, ".pourkit", "prompts");
      const promptFilePath = join(promptFileDir, "builder.prompt.md");
      mkdirSync(promptFileDir, { recursive: true });
      writeFileSync(promptFilePath, "Implement the issue.", "utf-8");

      vi.mocked(prProvider.getBranchStatus).mockResolvedValue({
        headSha: "def456",
        state: "green",
        checks: [
          {
            name: "ci",
            conclusion: "SUCCESS" as const,
            status: "COMPLETED" as const,
          },
        ],
      });

      vi.spyOn(issueProvider, "closeIssue");

      await runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      });

      expect(issueProvider.closeIssue).toHaveBeenCalledTimes(1);
      expect(issueProvider.closeIssue).toHaveBeenCalledWith(42);
    });

    it("does not close parent when parent PRD is already closed", async () => {
      const config = makeConfig({
        builder: {
          agent: "build",
          model: "test",
          promptTemplate: "builder.prompt.md",
        },
      });
      const issueProvider = new FakeIssueProvider([
        {
          number: 42,
          title: "PRD-002 / I-02: Second child",
          body: "## Parent\n\nPRD-002 (#20)",
          state: "open",
          labels: ["ready-for-agent"],
          comments: [],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
        {
          number: 1,
          title: "PRD-002 / I-01: First child",
          body: "## Parent\n\nPRD-002 (#20)",
          state: "closed",
          labels: [],
          comments: [],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
        {
          number: 20,
          title: "PRD-002: Some parent PRD",
          body: "## Description\n\nParent body.",
          state: "closed",
          labels: [],
          comments: [],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();
      const repoRoot = repoRootMock();
      const promptFileDir = join(repoRoot, ".pourkit", "prompts");
      const promptFilePath = join(promptFileDir, "builder.prompt.md");
      mkdirSync(promptFileDir, { recursive: true });
      writeFileSync(promptFilePath, "Implement the issue.", "utf-8");

      vi.mocked(prProvider.getBranchStatus).mockResolvedValue({
        headSha: "def456",
        state: "green",
        checks: [
          {
            name: "ci",
            conclusion: "SUCCESS" as const,
            status: "COMPLETED" as const,
          },
        ],
      });

      vi.spyOn(issueProvider, "closeIssue");

      await runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      });

      expect(issueProvider.closeIssue).toHaveBeenCalledTimes(1);
      expect(issueProvider.closeIssue).toHaveBeenCalledWith(42);
    });

    it("resolves when closeIssue fails after successful merge and target-green", async () => {
      const config = makeConfig({
        builder: {
          agent: "build",
          model: "test",
          promptTemplate: "builder.prompt.md",
        },
      });
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();
      const repoRoot = repoRootMock();
      const promptFileDir = join(repoRoot, ".pourkit", "prompts");
      const promptFilePath = join(promptFileDir, "builder.prompt.md");
      mkdirSync(promptFileDir, { recursive: true });
      writeFileSync(promptFilePath, "Implement the issue.", "utf-8");

      vi.mocked(prProvider.getBranchStatus).mockResolvedValue({
        headSha: "def456",
        state: "green",
        checks: [
          {
            name: "ci",
            conclusion: "SUCCESS" as const,
            status: "COMPLETED" as const,
          },
        ],
      });

      vi.spyOn(issueProvider, "closeIssue");

      await expect(
        runIssueCommand({
          issueNumber: 42,
          config,
          issueProvider,
          prProvider,
          executionProvider,
          force: false,
          logger,
          repoRoot: "/tmp/pourkit-issue-test",
        })
      ).resolves.toMatchObject({ prNumber: 7 });

      expect(issueProvider.closeIssue).toHaveBeenCalledWith(42);
      const updatedIssue = await issueProvider.fetchIssue(42);
      expect(updatedIssue.labels).not.toContain("ready-for-human");
    });

    it("does not close parent when child close fails", async () => {
      const config = makeConfig({
        builder: {
          agent: "build",
          model: "test",
          promptTemplate: "builder.prompt.md",
        },
      });
      const issueProvider = new FakeIssueProvider([
        {
          number: 42,
          title: "PRD-002 / I-02: Second child",
          body: "## Parent\n\nPRD-002 (#20)",
          state: "open",
          labels: ["ready-for-agent"],
          comments: [],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
        {
          number: 1,
          title: "PRD-002 / I-01: First child",
          body: "## Parent\n\nPRD-002 (#20)",
          state: "closed",
          labels: [],
          comments: [],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
        {
          number: 20,
          title: "PRD-002: Some parent PRD",
          body: "## Description\n\nParent body.",
          state: "open",
          labels: [],
          comments: [],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();
      const repoRoot = repoRootMock();
      const promptFileDir = join(repoRoot, ".pourkit", "prompts");
      const promptFilePath = join(promptFileDir, "builder.prompt.md");
      mkdirSync(promptFileDir, { recursive: true });
      writeFileSync(promptFilePath, "Implement the issue.", "utf-8");

      vi.mocked(prProvider.getBranchStatus).mockResolvedValue({
        headSha: "def456",
        state: "green",
        checks: [
          {
            name: "ci",
            conclusion: "SUCCESS" as const,
            status: "COMPLETED" as const,
          },
        ],
      });

      vi.spyOn(issueProvider, "closeIssue");

      await runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      });

      expect(issueProvider.closeIssue).toHaveBeenCalledWith(42);
      expect(issueProvider.closeIssue).toHaveBeenCalledWith(20);
    });

    it("fails when merge fails", async () => {
      const config = makeConfig({
        builder: {
          agent: "build",
          model: "test",
          promptTemplate: "builder.prompt.md",
        },
      });
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();
      const repoRoot = repoRootMock();
      const promptFileDir = join(repoRoot, ".pourkit", "prompts");
      const promptFilePath = join(promptFileDir, "builder.prompt.md");
      mkdirSync(promptFileDir, { recursive: true });
      writeFileSync(promptFilePath, "Implement the issue.", "utf-8");

      vi.mocked(prProvider.mergePr).mockRejectedValue(
        new Error("merge blocked")
      );

      await expect(
        runIssueCommand({
          issueNumber: 42,
          config,
          issueProvider,
          prProvider,
          executionProvider,
          force: false,
          logger,
          repoRoot: "/tmp/pourkit-issue-test",
        })
      ).rejects.toThrow("merge blocked");

      const updatedIssue = await issueProvider.fetchIssue(42);
      expect(updatedIssue.labels).toContain("ready-for-human");
      expect(updatedIssue.labels).not.toContain("agent-in-progress");
    });

    it("fails when direct auto merge fails", async () => {
      const config = makeConfig({
        builder: {
          agent: "build",
          model: "test",
          promptTemplate: "builder.prompt.md",
        },
      });
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();
      const repoRoot = repoRootMock();
      const promptFileDir = join(repoRoot, ".pourkit", "prompts");
      const promptFilePath = join(promptFileDir, "builder.prompt.md");
      mkdirSync(promptFileDir, { recursive: true });
      writeFileSync(promptFilePath, "Implement the issue.", "utf-8");

      vi.mocked(prProvider.mergePr).mockRejectedValue(
        new Error("auto-merge rejected")
      );

      await expect(
        runIssueCommand({
          issueNumber: 42,
          config,
          issueProvider,
          prProvider,
          executionProvider,
          force: false,
          logger,
          repoRoot: "/tmp/pourkit-issue-test",
        })
      ).rejects.toThrow("auto-merge rejected");

      const updatedIssue = await issueProvider.fetchIssue(42);
      expect(updatedIssue.labels).toContain("ready-for-human");
      expect(updatedIssue.labels).not.toContain("agent-in-progress");
    });

    it("fails when waitForPrChecks fails before auto-merge", async () => {
      const config = makeConfig({
        builder: {
          agent: "build",
          model: "test",
          promptTemplate: "builder.prompt.md",
        },
      });
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();
      const repoRoot = repoRootMock();
      const promptFileDir = join(repoRoot, ".pourkit", "prompts");
      const promptFilePath = join(promptFileDir, "builder.prompt.md");
      mkdirSync(promptFileDir, { recursive: true });
      writeFileSync(promptFilePath, "Implement the issue.", "utf-8");

      vi.mocked(prProvider.waitForPrChecks).mockRejectedValue(
        new Error("checks failed")
      );

      await expect(
        runIssueCommand({
          issueNumber: 42,
          config,
          issueProvider,
          prProvider,
          executionProvider,
          force: false,
          logger,
          repoRoot: "/tmp/pourkit-issue-test",
        })
      ).rejects.toThrow("checks failed");

      const updatedIssue = await issueProvider.fetchIssue(42);
      expect(updatedIssue.labels).toContain("ready-for-human");
      expect(updatedIssue.labels).not.toContain("agent-in-progress");
    });

    it("does not close the selected Issue when auto-merge is blocked", async () => {
      const config = makeConfig({
        builder: {
          agent: "build",
          model: "test",
          promptTemplate: "builder.prompt.md",
        },
      });
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();
      const repoRoot = repoRootMock();
      const promptFileDir = join(repoRoot, ".pourkit", "prompts");
      const promptFilePath = join(promptFileDir, "builder.prompt.md");
      mkdirSync(promptFileDir, { recursive: true });
      writeFileSync(promptFilePath, "Implement the issue.", "utf-8");

      vi.mocked(prProvider.mergePr).mockRejectedValue(
        new Error("merge blocked")
      );

      vi.spyOn(issueProvider, "closeIssue");

      await expect(
        runIssueCommand({
          issueNumber: 42,
          config,
          issueProvider,
          prProvider,
          executionProvider,
          force: false,
          logger,
          repoRoot: "/tmp/pourkit-issue-test",
        })
      ).rejects.toThrow("merge blocked");

      expect(issueProvider.closeIssue).not.toHaveBeenCalled();
    });
  });

  it("resumes finalizer after finalizer failure", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    const stateDir = join(worktreePath, ".pourkit");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "state.json"),
      JSON.stringify({
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true, initialVerification: true },
        review: {
          lifetimeIterations: 1,
          lastVerdict: "PASS",
          lastArtifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/reviewers/iteration-1.md",
          refactorCompletedForLastReview: true,
        },
      }),
      "utf-8"
    );

    const repoRoot = repoRootMock();
    const promptFileDir = join(repoRoot, ".pourkit", "prompts");
    mkdirSync(promptFileDir, { recursive: true });
    writeFileSync(
      join(promptFileDir, "finalizer.prompt.md"),
      "Write finalizer.",
      "utf-8"
    );

    const reviewArtifactDir = join(
      worktreePath,
      ".pourkit",
      ".tmp",
      "reviewers"
    );
    mkdirSync(reviewArtifactDir, { recursive: true });
    writeReviewerArtifact(join(reviewArtifactDir, "iteration-1.md"), "PASS");

    const finalizerArtifactPath = join(
      worktreePath,
      ".pourkit",
      ".tmp",
      "finalizer",
      "agent-output.md"
    );

    const stageCalls: string[] = [];
    const resumeExecutionProvider = {
      async execute(opts: any) {
        stageCalls.push(opts.stage);
        mkdirSync(join(finalizerArtifactPath, ".."), { recursive: true });
        writeFileSync(
          finalizerArtifactPath,
          "## PR Title\n\nfix: Resume test\n\n## PR Body\n\n## Summary\n\n- Why resumed.\n\n## Changes\n\n- Resumed change.\n\nCloses #42",
          "utf-8"
        );
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath,
          commits: ["fix: implement feature"],
          logPath: null,
        };
      },
    };

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);

    await runIssueCommand({
      issueNumber: 42,
      config: makeConfig({
        finalizer: {
          agent: "pr-desc",
          model: "test",
          promptTemplate: "finalizer.prompt.md",
        },
      }),
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider: resumeExecutionProvider as any,
      force: true,
      logger: makeLogger(),
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(stageCalls).toEqual(expect.arrayContaining(["finalizer"]));
    expect(stageCalls.some((s) => s === "builder")).toBe(false);
  });

  it("uses finalizer artifact to create final commit", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    const stateDir = join(worktreePath, ".pourkit");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "state.json"),
      JSON.stringify({
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true, initialVerification: true },
        review: {
          lifetimeIterations: 1,
          lastVerdict: "PASS",
          lastArtifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/reviewers/iteration-1.md",
          refactorCompletedForLastReview: true,
        },
        finalizer: {
          completed: true,
          artifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/finalizer/agent-output.md",
          title: "fix: Test issue",
          body: "## Summary\n\n- Summary here.\n\n## Changes\n\n- Change here.\n\nCloses #42",
        },
      }),
      "utf-8"
    );

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);

    await runIssueCommand({
      issueNumber: 42,
      config: makeConfig(),
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: true,
      logger: makeLogger(),
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(
      executionProvider.calls.some((call) => call.stage === "finalizer")
    ).toBe(false);
    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["commit"]),
      expect.anything()
    );
  });

  it("refuses final commit when target base advances after review", async () => {
    let mergeBaseCalls = 0;
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "merge-base" &&
        args[1] === "--is-ancestor"
      ) {
        mergeBaseCalls++;
        if (mergeBaseCalls === 2) {
          throw new Error("not ancestor");
        }
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    const stateDir = join(worktreePath, ".pourkit");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "state.json"),
      JSON.stringify({
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true, initialVerification: true },
        review: {
          lifetimeIterations: 1,
          lastVerdict: "PASS",
          lastArtifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/reviewers/iteration-1.md",
          refactorCompletedForLastReview: true,
        },
        finalizer: {
          completed: true,
          artifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/finalizer/agent-output.md",
          title: "fix: Test issue",
          body: "## Summary\n\n- Summary here.\n\n## Changes\n\n- Change here.\n\nCloses #42",
        },
      }),
      "utf-8"
    );

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config: makeConfig(),
        issueProvider: new FakeIssueProvider([
          makeIssue({ labels: ["ready-for-agent"] }),
        ]),
        prProvider: makePrProvider(),
        executionProvider,
        force: true,
        logger: makeLogger(),
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).rejects.toThrow("Cannot finalize stale worktree");

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["fetch", "origin", "main"],
      expect.objectContaining({ cwd: worktreePath })
    );
    expect(execCaptureMock).not.toHaveBeenCalledWith(
      "git",
      ["reset", "--soft", "origin/main"],
      expect.anything()
    );
  });

  describe("base refresh refuses published PR branches", () => {
    it("refuses base refresh for stale existing worktree with open PR", async () => {
      execCaptureMock.mockImplementation(async (command, args) => {
        if (command === "git" && args[0] === "worktree" && args[1] === "list") {
          return {
            code: 0,
            stdout: [
              "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
              "HEAD abc123",
              "branch refs/heads/pourkit/42/test-issue",
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[1] === "--is-ancestor"
        ) {
          throw new Error("not ancestor");
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      const worktreePath =
        "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
      mkdirSync(worktreePath, { recursive: true });
      writeWorktreeRunState(worktreePath, {
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true },
        review: { lifetimeIterations: 0 },
      });

      const config = makeConfig();
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();

      vi.mocked(prProvider.getPr).mockResolvedValue(
        makePullRequest({ state: "OPEN" })
      );

      await expect(
        runIssueCommand({
          issueNumber: 42,
          config,
          issueProvider,
          prProvider,
          executionProvider,
          force: true,
          logger,
          repoRoot: "/tmp/pourkit-issue-test",
        })
      ).rejects.toThrow("Cannot auto-refresh published history");

      expect(execCaptureMock).not.toHaveBeenCalledWith(
        "git",
        ["rebase", "--autostash", "main"],
        expect.anything()
      );
    });

    it("refuses base refresh for stale branch with merged PR", async () => {
      execCaptureMock.mockImplementation(async (command, args) => {
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[1] === "--is-ancestor"
        ) {
          throw new Error("not ancestor");
        }
        if (
          command === "git" &&
          args[0] === "diff" &&
          args[1] === "--name-only"
        ) {
          return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      const worktreePath =
        "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
      mkdirSync(worktreePath, { recursive: true });
      writeWorktreeRunState(worktreePath, {
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true },
        review: { lifetimeIterations: 0 },
      });

      const config = makeConfig();
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();

      vi.mocked(prProvider.getPr).mockResolvedValue(
        makePullRequest({ state: "MERGED" })
      );

      await expect(
        runIssueCommand({
          issueNumber: 42,
          config,
          issueProvider,
          prProvider,
          executionProvider,
          force: true,
          logger,
          repoRoot: "/tmp/pourkit-issue-test",
        })
      ).rejects.toThrow("Cannot auto-refresh published history");

      expect(prProvider.getPr).toHaveBeenCalledWith("pourkit/42/test-issue");
    });

    it("refuses base refresh for stale existing worktree with closed PR", async () => {
      execCaptureMock.mockImplementation(async (command, args) => {
        if (command === "git" && args[0] === "worktree" && args[1] === "list") {
          return {
            code: 0,
            stdout: [
              "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
              "HEAD abc123",
              "branch refs/heads/pourkit/42/test-issue",
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[1] === "--is-ancestor"
        ) {
          throw new Error("not ancestor");
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      const worktreePath =
        "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
      mkdirSync(worktreePath, { recursive: true });
      writeWorktreeRunState(worktreePath, {
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true },
        review: { lifetimeIterations: 0 },
      });

      const config = makeConfig();
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();

      vi.mocked(prProvider.getPr).mockResolvedValue(
        makePullRequest({ state: "CLOSED" })
      );

      await expect(
        runIssueCommand({
          issueNumber: 42,
          config,
          issueProvider,
          prProvider,
          executionProvider,
          force: true,
          logger,
          repoRoot: "/tmp/pourkit-issue-test",
        })
      ).rejects.toThrow("Cannot auto-refresh published history");

      expect(execCaptureMock).not.toHaveBeenCalledWith(
        "git",
        ["rebase", "--autostash", "main"],
        expect.anything()
      );
    });

    it("malformed worktree state does not mask provider PR when refusing refresh", async () => {
      execCaptureMock.mockImplementation(async (command, args) => {
        if (command === "git" && args[0] === "worktree" && args[1] === "list") {
          return {
            code: 0,
            stdout: [
              "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
              "HEAD abc123",
              "branch refs/heads/pourkit/42/test-issue",
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[1] === "--is-ancestor"
        ) {
          throw new Error("not ancestor");
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      const worktreePath =
        "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
      const stateDir = join(worktreePath, ".pourkit");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "state.json"), "{invalid json}", "utf-8");

      expect(readWorktreeRunState(worktreePath)).toBeNull();

      const config = makeConfig();
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();

      vi.mocked(prProvider.getPr).mockResolvedValue(
        makePullRequest({ state: "OPEN" })
      );

      await expect(
        runIssueCommand({
          issueNumber: 42,
          config,
          issueProvider,
          prProvider,
          executionProvider,
          force: true,
          logger,
          repoRoot: "/tmp/pourkit-issue-test",
        })
      ).rejects.toThrow("Cannot auto-refresh published history");
    });
  });

  it("reset worktree after human handoff starts clean without boundary context", async () => {
    let worktreeListCallCount = 0;
    let showRefCallCount = 0;

    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        worktreeListCallCount++;
        if (worktreeListCallCount === 1) {
          return {
            code: 0,
            stdout: [
              "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
              "HEAD abc123",
              "branch refs/heads/pourkit/42/test-issue",
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }

      if (command === "git" && args[0] === "show-ref") {
        showRefCallCount++;
        if (showRefCallCount === 1) {
          return { code: 0, stdout: "", stderr: "" };
        }
        throw new Error("branch not found");
      }

      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    mkdirSync(worktreePath, { recursive: true });
    writeWorktreeRunState(worktreePath, {
      issueNumber: 42,
      targetName: "test",
      branchName: "pourkit/42/test-issue",
      baseBranch: "main",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      completedStages: { builder: true },
      review: {
        lifetimeIterations: 2,
        lastVerdict: "NEEDS_HUMAN",
        lastArtifactPath:
          "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/reviewers/iteration-2.md",
        refactorArtifactPaths: [
          "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/refactors/iteration-1.md",
        ],
      },
    });
    // Create prior reviewer artifacts so the resumed run has historical context
    const reviewersDir = join(worktreePath, ".pourkit", ".tmp", "reviewers");
    mkdirSync(reviewersDir, { recursive: true });
    writeFileSync(
      join(reviewersDir, "iteration-1.md"),
      [
        "## Findings",
        "",
        "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
        "|----|------------|----------|-----------|-------|----------------|",
        "| R1.F1 | - | high | src/foo.ts:10 | Missing null check | Add null guard |",
        "",
        "<verdict>NEEDS_REFACTOR</verdict>",
      ].join("\n"),
      "utf-8"
    );
    writeFileSync(
      join(reviewersDir, "iteration-2.md"),
      [
        "## Findings",
        "",
        "## Human Handoff Summary",
        "",
        "The refactor introduced a regression that requires human judgment.",
        "",
        "## Human Handoff Reason",
        "",
        "The proposed fix changes the public API surface and needs a maintainer decision.",
        "",
        "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
        "|----|------------|----------|-----------|-------|----------------|",
        "| R2.F1 | R1.F1 | high | src/foo.ts:10 | Null check added but breaks callers | Revert and discuss API contract |",
        "",
        "<verdict>NEEDS_HUMAN</verdict>",
      ].join("\n"),
      "utf-8"
    );

    const config = makeConfig({
      reviewerEnabled: true,
      refactor: {
        agent: "refactor",
        model: "test-refactor",
        promptTemplate: "refactor.prompt.md",
      },
    });

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    vi.mocked(prProvider.getPr).mockResolvedValue(null);

    const reviewerPrompts: string[] = [];
    const multiExecutionProvider = {
      async execute(opts: any) {
        if (opts.stage === "reviewer") {
          reviewerPrompts.push(opts.prompt);
          const reviewerArtifactPath = join(
            opts.worktreePath ?? worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
          );
          mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
          writeReviewerArtifact(reviewerArtifactPath, "PASS");
        }
        if (opts.stage === "finalizer") {
          writeSyntheticStageArtifact(opts, worktreePath, "PASS");
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath,
          commits: ["fix: implement feature"],
          logPath: null,
        };
      },
    };

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider: multiExecutionProvider as any,
      force: false,
      resetWorktree: true,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(reviewerPrompts.length).toBeGreaterThanOrEqual(1);
    for (const prompt of reviewerPrompts) {
      expect(prompt).not.toContain("## Human-Resolved Handoff Boundary");
    }
  });

  it("human resolved issue resumes preserved worktree at next iteration with handoff boundary", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    mkdirSync(worktreePath, { recursive: true });
    writeWorktreeRunState(worktreePath, {
      issueNumber: 42,
      targetName: "test",
      branchName: "pourkit/42/test-issue",
      baseBranch: "main",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      completedStages: { builder: true },
      review: {
        lifetimeIterations: 2,
        lastVerdict: "NEEDS_HUMAN",
        lastArtifactPath:
          "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/reviewers/iteration-2.md",
        refactorArtifactPaths: [
          "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/refactors/iteration-1.md",
        ],
      },
    });

    // Create prior reviewer artifacts to verify historical context is carried forward
    const reviewersDir = join(worktreePath, ".pourkit", ".tmp", "reviewers");
    mkdirSync(reviewersDir, { recursive: true });
    writeFileSync(
      join(reviewersDir, "iteration-1.md"),
      [
        "## Findings",
        "",
        "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
        "|----|------------|----------|-----------|-------|----------------|",
        "| R1.F1 | - | high | src/foo.ts:10 | Missing null check | Add null guard |",
        "",
        "<verdict>NEEDS_REFACTOR</verdict>",
      ].join("\n"),
      "utf-8"
    );
    writeFileSync(
      join(reviewersDir, "iteration-2.md"),
      [
        "## Findings",
        "",
        "## Human Handoff Summary",
        "",
        "The refactor introduced a regression that requires human judgment.",
        "",
        "## Human Handoff Reason",
        "",
        "The proposed fix changes the public API surface and needs a maintainer decision.",
        "",
        "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
        "|----|------------|----------|-----------|-------|----------------|",
        "| R2.F1 | R1.F1 | high | src/foo.ts:10 | Null check added but breaks callers | Revert and discuss API contract |",
        "",
        "<verdict>NEEDS_HUMAN</verdict>",
      ].join("\n"),
      "utf-8"
    );

    const config = makeConfig({
      reviewerEnabled: true,
      refactor: {
        agent: "refactor",
        model: "test-refactor",
        promptTemplate: "refactor.prompt.md",
      },
    });

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    const reviewerCalls: any[] = [];
    const multiExecutionProvider = {
      async execute(opts: any) {
        if (opts.stage === "builder") {
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath,
            commits: [],
            logPath: null,
          };
        }
        if (opts.stage === "reviewer") {
          reviewerCalls.push(opts);
          const iteration = opts.iteration ?? 1;
          const reviewerArtifactPath = join(
            opts.worktreePath ?? worktreePath,
            opts.artifactPath ??
              `.pourkit/.tmp/reviewers/iteration-${iteration}.md`
          );
          mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
          writeFileSync(
            reviewerArtifactPath,
            [
              "## Findings",
              "",
              "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
              "|----|------------|----------|-----------|-------|----------------|",
              `| R${iteration}.F1 | - | low | n/a | No issues found. | n/a |`,
              "",
              "<verdict>PASS</verdict>",
            ].join("\n"),
            "utf-8"
          );
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath,
            commits: [],
            logPath: null,
          };
        }
        if (opts.stage === "finalizer") {
          writeSyntheticStageArtifact(opts, worktreePath, "PASS");
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath,
            commits: [],
            logPath: null,
          };
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath,
          commits: [],
          logPath: null,
        };
      },
    };

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider: multiExecutionProvider as any,
      force: true,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(reviewerCalls).toHaveLength(1);
    expect(reviewerCalls[0].iteration).toBe(3);
    expect(reviewerCalls[0].prompt).toContain(
      "## Human-Resolved Handoff Boundary"
    );
    expect(reviewerCalls[0].prompt).toContain("## Prior Reviewer Artifacts");
    expect(reviewerCalls[0].prompt).toContain("### Reviewer Iteration 1");
    expect(reviewerCalls[0].prompt).toContain("### Reviewer Iteration 2");
    expect(reviewerCalls[0].prompt).toContain("Missing null check");
    expect(reviewerCalls[0].prompt).toContain(
      "The proposed fix changes the public API surface"
    );
    expect(reviewerCalls[0].prompt).toContain(
      "Treat them as background, not active findings"
    );
  });

  it("malformed prior refactor artifact does not override worktree state as source of truth for resume iteration", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    mkdirSync(worktreePath, { recursive: true });

    // Write worktree state with NEEDS_HUMAN
    writeWorktreeRunState(worktreePath, {
      issueNumber: 42,
      targetName: "test",
      branchName: "pourkit/42/test-issue",
      baseBranch: "main",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      completedStages: { builder: true },
      review: {
        lifetimeIterations: 2,
        lastVerdict: "NEEDS_HUMAN",
        lastArtifactPath:
          "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/reviewers/iteration-2.md",
      },
    });

    // Write a malformed prior refactor artifact
    const refactorsDir = join(worktreePath, ".pourkit", ".tmp", "refactors");
    mkdirSync(refactorsDir, { recursive: true });
    writeFileSync(
      join(refactorsDir, "iteration-1.md"),
      "garbage content that is not a valid refactor artifact",
      "utf-8"
    );

    const config = makeConfig({
      reviewerEnabled: true,
      refactor: {
        agent: "refactor",
        model: "test-refactor",
        promptTemplate: "refactor.prompt.md",
      },
    });

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    const reviewerCalls: any[] = [];
    const multiExecutionProvider = {
      async execute(opts: any) {
        if (opts.stage === "builder") {
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath,
            commits: [],
            logPath: null,
          };
        }
        if (opts.stage === "reviewer") {
          reviewerCalls.push(opts);
          const iteration = opts.iteration ?? 1;
          const reviewerArtifactPath = join(
            opts.worktreePath ?? worktreePath,
            opts.artifactPath ??
              `.pourkit/.tmp/reviewers/iteration-${iteration}.md`
          );
          mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
          const hasPriorRefactors = opts.prompt?.includes(
            "## Prior Refactor Artifacts"
          );
          writeFileSync(
            reviewerArtifactPath,
            [
              "## Findings",
              "",
              "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
              "|----|------------|----------|-----------|-------|----------------|",
              `| R${iteration}.F1 | - | low | n/a | No issues found. | n/a |`,
              "",
              hasPriorRefactors
                ? "## Prior Refactor Response Assessment\n\n| Prior Finding ID | Refactor Classification | Reviewer Assessment | Next Action |\n|------------------|-------------------------|---------------------|-------------|\n| R2.F1 | accepted | accepted-refactor-response | No further action needed. |"
                : "",
              "",
              "<verdict>PASS</verdict>",
            ].join("\n"),
            "utf-8"
          );
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath,
            commits: [],
            logPath: null,
          };
        }
        if (opts.stage === "finalizer") {
          writeSyntheticStageArtifact(opts, worktreePath, "PASS");
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath,
            commits: [],
            logPath: null,
          };
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath,
          commits: [],
          logPath: null,
        };
      },
    };

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider: multiExecutionProvider as any,
      force: true,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(reviewerCalls).toHaveLength(1);
    expect(reviewerCalls[0].iteration).toBe(3);
  });

  describe("base refresh conflict without conflictResolution", () => {
    let tmpRepoRoot: string;
    let worktreePath: string;

    beforeEach(() => {
      tmpRepoRoot = mkdtempSync(join(tmpdir(), "pourkit-conflict-test-"));
      worktreePath = join(
        tmpRepoRoot,
        ".sandcastle",
        "worktrees",
        "pourkit-42-test-issue"
      );
      mkdirSync(join(tmpRepoRoot, ".sandcastle", "worktrees"), {
        recursive: true,
      });

      execFileSync("git", ["-c", "init.defaultBranch=main", "init"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["config", "user.email", "test@test.com"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });

      writeFileSync(join(tmpRepoRoot, "test-file.ts"), "initial content\n");
      writeFileSync(join(tmpRepoRoot, "another-file.ts"), "another initial\n");
      execFileSync("git", ["add", "-A"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "init"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });

      execFileSync("git", ["checkout", "-b", "pourkit/42/test-issue"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });
      writeFileSync(join(tmpRepoRoot, "test-file.ts"), "worktree change\n");
      writeFileSync(
        join(tmpRepoRoot, "another-file.ts"),
        "another worktree change\n"
      );
      execFileSync("git", ["add", "-A"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "branch change"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });

      execFileSync("git", ["checkout", "main"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });
      writeFileSync(join(tmpRepoRoot, "test-file.ts"), "main change\n");
      writeFileSync(
        join(tmpRepoRoot, "another-file.ts"),
        "main change to another\n"
      );
      execFileSync("git", ["add", "-A"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "main change"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });

      execFileSync(
        "git",
        ["worktree", "add", worktreePath, "pourkit/42/test-issue"],
        { cwd: tmpRepoRoot, encoding: "utf8" }
      );

      repoRootMock.mockReturnValue(tmpRepoRoot);

      let mergeBaseCalls = 0;
      execCaptureMock.mockImplementation(async (command, args, options) => {
        const opts = options as { cwd?: string } | undefined;
        const isWorktreeOp = opts?.cwd === worktreePath;

        if (command === "git" && args[0] === "worktree" && args[1] === "list") {
          return {
            code: 0,
            stdout: [
              `worktree ${worktreePath}`,
              "HEAD abc123",
              "branch refs/heads/pourkit/42/test-issue",
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        if (command === "git" && args[0] === "fetch") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (
          command === "git" &&
          args[0] === "branch" &&
          args[1] === "--force"
        ) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "diff") {
          return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
        }
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[1] === "--is-ancestor"
        ) {
          mergeBaseCalls++;
          if (mergeBaseCalls === 1) {
            throw new Error("not ancestor");
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "rebase" && isWorktreeOp) {
          try {
            execFileSync("git", args as string[], {
              cwd: opts!.cwd as string,
              encoding: "utf8",
            });
            return { code: 0, stdout: "", stderr: "" };
          } catch {
            throw new Error("rebase conflict");
          }
        }
        if (command === "git" && args[0] === "status" && isWorktreeOp) {
          const result = execFileSync("git", ["status", "--porcelain"], {
            cwd: opts!.cwd as string,
            encoding: "utf8",
          }) as string;
          return { code: 0, stdout: result, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });
    });

    afterEach(() => {
      rmSync(tmpRepoRoot, { recursive: true, force: true });
    });

    it("preserves conflicted worktree and transitions issue to ready-for-human", async () => {
      mkdirSync(join(worktreePath, ".pourkit"), { recursive: true });
      writeWorktreeRunState(worktreePath, {
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true },
        review: { lifetimeIterations: 0 },
      });

      const config = makeConfig();
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const addLabelsSpy = vi.spyOn(issueProvider, "addLabels");
      const prProvider = makePrProvider();
      const logger = makeLogger();

      await expect(
        startIssueRun({
          issueNumber: 42,
          config,
          issueProvider,
          prProvider,
          executionProvider,
          force: true,
          logger,
          repoRoot: tmpRepoRoot,
        })
      ).rejects.toThrow("Base refresh conflicted");

      expect(addLabelsSpy).toHaveBeenCalledWith(42, [
        config.labels.readyForHuman,
      ]);
      expect(existsSync(worktreePath)).toBe(true);

      const statusOut = execFileSync("git", ["status", "--porcelain"], {
        cwd: worktreePath,
        encoding: "utf8",
      }) as string;
      expect(statusOut).toContain("UU");
    });

    it("records lastFailure stage as baseRefresh and preserves builder completion", async () => {
      mkdirSync(join(worktreePath, ".pourkit"), { recursive: true });
      writeWorktreeRunState(worktreePath, {
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true },
        review: { lifetimeIterations: 0 },
      });

      const config = makeConfig();
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();

      await expect(
        startIssueRun({
          issueNumber: 42,
          config,
          issueProvider,
          prProvider,
          executionProvider,
          force: true,
          logger,
          repoRoot: tmpRepoRoot,
        })
      ).rejects.toThrow("Base refresh conflicted");

      const state = readWorktreeRunState(worktreePath);
      expect(state).not.toBeNull();
      expect(state!.lastFailure).toMatchObject({ stage: "baseRefresh" });
      expect(state!.completedStages.builder).toBe(true);
    });

    it("writes valid state from scratch when no pre-existing .pourkit/state.json exists", async () => {
      const config = makeConfig();
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const addLabelsSpy = vi.spyOn(issueProvider, "addLabels");
      const prProvider = makePrProvider();
      const logger = makeLogger();

      await expect(
        startIssueRun({
          issueNumber: 42,
          config,
          issueProvider,
          prProvider,
          executionProvider,
          force: true,
          logger,
          repoRoot: tmpRepoRoot,
        })
      ).rejects.toThrow("Base refresh conflicted");

      expect(addLabelsSpy).toHaveBeenCalledWith(42, [
        config.labels.readyForHuman,
      ]);

      const state = readWorktreeRunState(worktreePath);
      expect(state).not.toBeNull();
      expect(state!.lastFailure).toMatchObject({ stage: "baseRefresh" });
      expect(state!.issueNumber).toBe(42);
      expect(state!.targetName).toBe("test");
      expect(state!.branchName).toBe("pourkit/42/test-issue");
      expect(state!.baseBranch).toBe("main");
      expect(state!.review.lifetimeIterations).toBe(0);
      expect(state!.completedStages.builder).toBeUndefined();
    });
  });

  it("resumes with normalized title when stored finalizer title is non-conventional", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    const stateDir = join(worktreePath, ".pourkit");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "state.json"),
      JSON.stringify({
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true, initialVerification: true },
        review: {
          lifetimeIterations: 1,
          lastVerdict: "PASS",
          lastArtifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/reviewers/iteration-1.md",
          refactorCompletedForLastReview: true,
        },
        finalizer: {
          completed: true,
          artifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/finalizer/agent-output.md",
          title: "Test issue",
          body: "## Summary\n\n- Summary here.\n\n## Changes\n\n- Change here.\n\nCloses #42",
        },
      }),
      "utf-8"
    );

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);

    await runIssueCommand({
      issueNumber: 42,
      config: makeConfig(),
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: true,
      logger: makeLogger(),
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(
      executionProvider.calls.some((call) => call.stage === "finalizer")
    ).toBe(false);
    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      [
        "commit",
        "--no-verify",
        "-m",
        "chore: Test issue",
        "-m",
        "## Summary\n\n- Summary here.\n\n## Changes\n\n- Change here.\n\nCloses #42",
      ],
      expect.anything()
    );
  });

  it("parses finalizer artifact when state has artifactPath but no title/body", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    const stateDir = join(worktreePath, ".pourkit");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "state.json"),
      JSON.stringify({
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true, initialVerification: true },
        review: {
          lifetimeIterations: 1,
          lastVerdict: "PASS",
          lastArtifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/reviewers/iteration-1.md",
          refactorCompletedForLastReview: true,
        },
        finalizer: {
          completed: true,
          artifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/finalizer/agent-output.md",
        },
      }),
      "utf-8"
    );

    const reviewDir = join(worktreePath, ".pourkit", ".tmp", "reviewers");
    mkdirSync(reviewDir, { recursive: true });
    writeReviewerArtifact(join(reviewDir, "iteration-1.md"), "PASS");

    const artifactPath = join(
      worktreePath,
      ".pourkit",
      ".tmp",
      "finalizer",
      "agent-output.md"
    );
    mkdirSync(join(artifactPath, ".."), { recursive: true });
    writeFileSync(
      artifactPath,
      "## PR Title\n\nfix: Recovered from artifact\n\n## PR Body\n\n## Summary\n\n- Artifact recovery summary.\n\n## Changes\n\n- Artifact recovered change.",
      "utf-8"
    );

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();

    await runIssueCommand({
      issueNumber: 42,
      config: makeConfig(),
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger: makeLogger(),
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(
      executionProvider.calls.some((call) => call.stage === "finalizer")
    ).toBe(false);
    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["commit", "-m", "fix: Recovered from artifact"]),
      expect.anything()
    );
    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["reset", "--soft", "origin/main"],
      expect.anything()
    );
    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["commit", "-m", "fix: Recovered from artifact"]),
      expect.anything()
    );
    expect(prProvider.createPr).toHaveBeenCalledWith({
      title: "fix: Recovered from artifact",
      body: "## Summary\n\n- Artifact recovery summary.\n\n## Changes\n\n- Artifact recovered change.\n\nCloses #42",
      head: "pourkit/42/test-issue",
      base: "main",
    });
  });

  it("resumes PR creation after final commit", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    const stateDir = join(worktreePath, ".pourkit");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "state.json"),
      JSON.stringify({
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true, initialVerification: true },
        review: {
          lifetimeIterations: 1,
          lastVerdict: "PASS",
          lastArtifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/reviewers/iteration-1.md",
          refactorCompletedForLastReview: true,
        },
        finalizer: {
          completed: true,
          artifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/finalizer/agent-output.md",
          title: "fix: Test issue",
          body: "## Summary\n\n- Summary here.\n\n## Changes\n\n- Change here.\n\nCloses #42",
        },
        finalCommit: {
          completed: true,
          sha: "abc123def456",
        },
      }),
      "utf-8"
    );

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();

    await runIssueCommand({
      issueNumber: 42,
      config: makeConfig(),
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger: makeLogger(),
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(prProvider.createPr).toHaveBeenCalledWith({
      title: "fix: Test issue",
      body: "## Summary\n\n- Summary here.\n\n## Changes\n\n- Change here.\n\nCloses #42",
      head: "pourkit/42/test-issue",
      base: "main",
    });
  });

  it("reuses existing PR during PR-stage recovery", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    const stateDir = join(worktreePath, ".pourkit");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "state.json"),
      JSON.stringify({
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true, initialVerification: true },
        review: {
          lifetimeIterations: 1,
          lastVerdict: "PASS",
          lastArtifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/reviewers/iteration-1.md",
          refactorCompletedForLastReview: true,
        },
        finalizer: {
          completed: true,
          artifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/finalizer/agent-output.md",
          title: "fix: Test issue",
          body: "## Summary\n\n- Summary here.\n\n## Changes\n\n- Change here.\n\nCloses #42",
        },
        finalCommit: {
          completed: true,
          sha: "abc123def456",
        },
        pr: {
          created: true,
          number: 7,
          url: "https://github.com/test/repo/pull/7",
        },
      }),
      "utf-8"
    );

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    vi.mocked(prProvider.getPr).mockResolvedValue(
      makePullRequest({ state: "OPEN" })
    );

    await runIssueCommand({
      issueNumber: 42,
      config: makeConfig(),
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger: makeLogger(),
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(prProvider.createPr).not.toHaveBeenCalled();
    expect(prProvider.waitForPrChecks).toHaveBeenCalledWith(
      7,
      expect.anything()
    );
  });

  it("reuses existing PR during PR-stage recovery even when pr state is absent", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    const stateDir = join(worktreePath, ".pourkit");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "state.json"),
      JSON.stringify({
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true, initialVerification: true },
        review: {
          lifetimeIterations: 1,
          lastVerdict: "PASS",
          lastArtifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/reviewers/iteration-1.md",
          refactorCompletedForLastReview: true,
        },
        finalizer: {
          completed: true,
          artifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/finalizer/agent-output.md",
          title: "fix: Test issue",
          body: "## Summary\n\n- Summary here.\n\n## Changes\n\n- Change here.\n\nCloses #42",
        },
        finalCommit: {
          completed: true,
          sha: "abc123def456",
        },
      }),
      "utf-8"
    );

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    vi.mocked(prProvider.getPr).mockResolvedValue(
      makePullRequest({ state: "OPEN" })
    );

    await runIssueCommand({
      issueNumber: 42,
      config: makeConfig(),
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger: makeLogger(),
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(prProvider.createPr).not.toHaveBeenCalled();
    expect(prProvider.waitForPrChecks).toHaveBeenCalledWith(
      7,
      expect.anything()
    );
  });

  it("resumes at target-green after merge when pr.merged is set", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    const stateDir = join(worktreePath, ".pourkit");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "state.json"),
      JSON.stringify({
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true, initialVerification: true },
        review: {
          lifetimeIterations: 1,
          lastVerdict: "PASS",
          lastArtifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/reviewers/iteration-1.md",
          refactorCompletedForLastReview: true,
        },
        finalizer: {
          completed: true,
          artifactPath:
            "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/finalizer/agent-output.md",
          title: "fix: Test issue",
          body: "Closes #42",
        },
        finalCommit: {
          completed: true,
          sha: "abc123def456",
        },
        pr: {
          created: true,
          number: 7,
          url: "https://github.com/test/repo/pull/7",
          merged: true,
        },
      }),
      "utf-8"
    );

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();

    await runIssueCommand({
      issueNumber: 42,
      config: makeConfig(),
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger: makeLogger(),
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(
      executionProvider.calls.some((call) => call.stage === "builder")
    ).toBe(false);
    expect(prProvider.createPr).not.toHaveBeenCalled();
    expect(prProvider.mergePr).not.toHaveBeenCalled();
    expect(prProvider.getBranchStatus).toHaveBeenCalledWith("main");

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).not.toContain("pr-open-awaiting-merge");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
  });

  it("closes issue and skips PR when no worktree changes exist", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args[0] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    const stateDir = join(worktreePath, ".pourkit");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "state.json"),
      JSON.stringify({
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: {},
        review: {
          lifetimeIterations: 0,
        },
      }),
      "utf-8"
    );

    const stageCalls: string[] = [];
    const noOpExecutionProvider = {
      async execute(opts: any) {
        stageCalls.push(opts.stage);
        if (opts.stage === "reviewer") {
          writeSyntheticStageArtifact(opts, worktreePath, "PASS");
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath,
          commits: [],
          logPath: null,
        };
      },
    };

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent", "pr-open-awaiting-merge"] }),
    ]);
    const prProvider = makePrProvider();

    const result = await runIssueCommand({
      issueNumber: 42,
      config: makeConfig(),
      issueProvider,
      prProvider,
      executionProvider: noOpExecutionProvider as any,
      force: true,
      logger: makeLogger(),
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(result.noOp).toBe(true);
    expect(result.prNumber).toBeUndefined();
    expect(result.prUrl).toBeUndefined();
    expect(stageCalls).toEqual(["builder", "reviewer"]);
    expect(prProvider.createPr).not.toHaveBeenCalled();
    expect(prProvider.mergePr).not.toHaveBeenCalled();
    expect(
      execCaptureMock.mock.calls.some(
        ([command, args]) => command === "git" && args[0] === "push"
      )
    ).toBe(false);

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.state).toBe("closed");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
    expect(updatedIssue.labels).not.toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("pr-open-awaiting-merge");
  });

  it("resolves when closeIssue fails during no-op completion", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args[0] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    const stateDir = join(worktreePath, ".pourkit");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "state.json"),
      JSON.stringify({
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: {},
        review: {
          lifetimeIterations: 0,
        },
      }),
      "utf-8"
    );

    const noOpExecutionProvider = {
      async execute(opts: any) {
        if (opts.stage === "reviewer") {
          writeSyntheticStageArtifact(opts, worktreePath, "PASS");
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath,
          commits: [],
          logPath: null,
        };
      },
    };

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();

    vi.spyOn(issueProvider, "closeIssue").mockRejectedValue(
      new Error("GraphQL: Could not close the issue. (closeIssue)")
    );

    const logger = makeLogger();

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config: makeConfig(),
        issueProvider,
        prProvider,
        executionProvider: noOpExecutionProvider as any,
        force: true,
        logger,
        repoRoot: "/tmp/pourkit-issue-test",
      })
    ).resolves.toMatchObject({ noOp: true });

    expect(logger.step).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("could not be closed")
    );

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).not.toContain("ready-for-human");
  });

  it("proceeds with PR when worktree has tracked changes", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    const stateDir = join(worktreePath, ".pourkit");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "state.json"),
      JSON.stringify({
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true, initialVerification: true },
        review: {
          lifetimeIterations: 0,
        },
      }),
      "utf-8"
    );

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();

    const result = await runIssueCommand({
      issueNumber: 42,
      config: makeConfig(),
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger: makeLogger(),
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(result.noOp).toBe(false);
    expect(result.prNumber).toBe(7);
    expect(prProvider.createPr).toHaveBeenCalled();
  });

  it("proceeds with PR when worktree has untracked files", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args[0] === "status") {
        return { code: 0, stdout: "?? new-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    const stateDir = join(worktreePath, ".pourkit");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "state.json"),
      JSON.stringify({
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true, initialVerification: true },
        review: {
          lifetimeIterations: 0,
        },
      }),
      "utf-8"
    );

    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();

    const result = await runIssueCommand({
      issueNumber: 42,
      config: makeConfig(),
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger: makeLogger(),
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(result.noOp).toBe(false);
    expect(result.prNumber).toBe(7);
    expect(prProvider.createPr).toHaveBeenCalled();
  });

  it("change detection diffs against remote-backed base", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    const stateDir = join(worktreePath, ".pourkit");
    mkdirSync(stateDir, { recursive: true });
    writeWorktreeRunState(worktreePath, {
      issueNumber: 42,
      targetName: "test",
      branchName: "pourkit/42/test-issue",
      baseBranch: "main",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      completedStages: { builder: true },
      review: { lifetimeIterations: 1, lastVerdict: "PASS" },
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    const result = await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["diff", "--name-only", "origin/main", "--"],
      expect.anything()
    );
    expect(result.prNumber).toBe(7);
  });

  it("no-op Issue close still works with remote-backed diff base", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args[0] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    const stateDir = join(worktreePath, ".pourkit");
    mkdirSync(stateDir, { recursive: true });
    writeWorktreeRunState(worktreePath, {
      issueNumber: 42,
      targetName: "test",
      branchName: "pourkit/42/test-issue",
      baseBranch: "main",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      completedStages: { builder: true },
      review: { lifetimeIterations: 1, lastVerdict: "PASS" },
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    const result = await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(result.noOp).toBe(true);
    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.state).toBe("closed");
  });

  it("final commit soft-resets against remote-backed base", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            "worktree /tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue",
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const worktreePath =
      "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue";
    const stateDir = join(worktreePath, ".pourkit");
    mkdirSync(stateDir, { recursive: true });
    writeWorktreeRunState(worktreePath, {
      issueNumber: 42,
      targetName: "test",
      branchName: "pourkit/42/test-issue",
      baseBranch: "main",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      completedStages: { builder: true },
      review: {
        lifetimeIterations: 1,
        lastVerdict: "PASS",
        lastArtifactPath:
          "/tmp/pourkit-issue-test/.sandcastle/worktrees/pourkit-42-test-issue/.pourkit/.tmp/reviewers/iteration-1.md",
      },
      finalizer: {
        completed: true,
        title: "fix: Test issue",
        body: "Closes #42",
      },
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      logger,
      repoRoot: "/tmp/pourkit-issue-test",
    });

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["reset", "--soft", "origin/main"],
      expect.anything()
    );
    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["commit", "-m"]),
      expect.anything()
    );
    expect(prProvider.createPr).toHaveBeenCalledWith(
      expect.objectContaining({ base: "main" })
    );
  });

  it("persists review state after refactor so resumed Issue runs continue with correct lifetime iteration", async () => {
    const testDir = "/tmp/pourkit-issue-test";
    const worktreePath = `${testDir}/.sandcastle/worktrees/pourkit-42-test-issue`;

    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            `worktree ${worktreePath}`,
            "HEAD abc123",
            "branch refs/heads/pourkit/42/test-issue",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    mkdirSync(join(worktreePath, ".pourkit"), { recursive: true });
    writeWorktreeRunState(worktreePath, {
      issueNumber: 42,
      targetName: "test",
      branchName: "pourkit/42/test-issue",
      baseBranch: "main",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      completedStages: { builder: true },
      review: { lifetimeIterations: 0 },
    });

    const config = makeConfig({
      reviewerEnabled: true,
      refactor: {
        agent: "refactor",
        model: "test-refactor",
        promptTemplate: "refactor.prompt.md",
      },
    });

    let callCount = 0;
    const interruptingProvider = {
      async execute(opts: any) {
        callCount++;
        if (callCount === 1) {
          const reviewerArtifactPath = join(
            opts.worktreePath ?? worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
          );
          mkdirSync(join(reviewerArtifactPath, ".."), {
            recursive: true,
          });
          writeReviewerArtifact(reviewerArtifactPath, "NEEDS_REFACTOR");
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath,
            commits: [],
            logPath: null,
          };
        }
        if (callCount === 2) {
          const refactorArtifactPath = join(
            opts.worktreePath ?? worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/refactors/iteration-1.md"
          );
          mkdirSync(join(refactorArtifactPath, ".."), {
            recursive: true,
          });
          writeFileSync(
            refactorArtifactPath,
            [
              "## Finding Responses",
              "",
              "| Finding ID | Classification | Rationale | Files Changed |",
              "|------------|----------------|-----------|---------------|",
              "| R1.F1 | accepted | Fixed the issue | src/test.ts |",
              "",
              "## Verification",
              "",
              "| Command | Result | Notes |",
              "|---------|--------|-------|",
              "| npm test | passed | All good |",
              "",
              "## Open Blockers",
              "",
              "| Blocker | Needed From |",
              "|---------|-------------|",
              "| none | n/a |",
              "",
            ].join("\n"),
            "utf-8"
          );
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath,
            commits: ["def456"],
            logPath: null,
          };
        }
        throw new Error("Reviewer execution failed: crash");
      },
    };

    const interruptingIssueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);

    await expect(
      runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider: interruptingIssueProvider,
        prProvider: makePrProvider(),
        executionProvider: interruptingProvider as any,
        force: true,
        logger: makeLogger(),
        repoRoot: testDir,
      })
    ).rejects.toThrow();

    const state = readWorktreeRunState(worktreePath);
    expect(state).not.toBeNull();
    expect(state!.review.lifetimeIterations).toBe(1);
    expect(state!.review.lastVerdict).toBe("NEEDS_REFACTOR");
    expect(state!.review.refactorCompletedForLastReview).toBe(true);

    const reviewDir = join(worktreePath, ".pourkit", ".tmp", "reviewers");
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(
      join(reviewDir, "iteration-1.md"),
      "<verdict>NEEDS_REFACTOR</verdict>",
      "utf-8"
    );

    let resumeCallCount = 0;
    const resumeProvider = {
      async execute(opts: any) {
        resumeCallCount++;
        if (resumeCallCount === 1) {
          expect(opts.iteration).toBe(2);
          const reviewerArtifactPath = join(
            opts.worktreePath ?? worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-2.md"
          );
          mkdirSync(join(reviewerArtifactPath, ".."), {
            recursive: true,
          });
          writeReviewerArtifact(reviewerArtifactPath, "PASS", true);
          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath,
            commits: [],
            logPath: null,
          };
        }
        const finalizerArtifactPath = join(
          opts.worktreePath ?? worktreePath,
          ".pourkit/.tmp/finalizer/agent-output.md"
        );
        mkdirSync(join(finalizerArtifactPath, ".."), {
          recursive: true,
        });
        writeFileSync(
          finalizerArtifactPath,
          "## PR Title\n\nfix: Resume test\n\n## PR Body\n\nCloses #42",
          "utf-8"
        );
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath,
          commits: [],
          logPath: null,
        };
      },
    };

    const resumeIssueProvider = new FakeIssueProvider([
      makeIssue({ labels: ["ready-for-agent"] }),
    ]);

    const result = await runIssueCommand({
      issueNumber: 42,
      config,
      issueProvider: resumeIssueProvider,
      prProvider: makePrProvider(),
      executionProvider: resumeProvider as any,
      force: true,
      logger: makeLogger(),
      repoRoot: testDir,
    });

    expect(result.prNumber).toBe(7);
    expect(resumeCallCount).toBe(2);
  });

  describe("base refresh conflict with conflictResolution", () => {
    let tmpRepoRoot: string;
    let worktreePath: string;

    function validResolvedArtifact(): string {
      return [
        "## Status",
        "",
        "resolved",
        "",
        "## Summary",
        "",
        "- Preserved latest baseBranch behavior.",
        "- Reapplied compatible issue work.",
        "",
        "## Files",
        "",
        "- `test-file.ts`",
        "- `another-file.ts`",
        "",
        "<conflict-resolution>resolved</conflict-resolution>",
      ].join("\n");
    }

    function validAmbiguousArtifact(): string {
      return [
        "## Status",
        "",
        "ambiguous",
        "",
        "## Summary",
        "",
        "- Changes conflict with base branch changes.",
        "",
        "## Files",
        "",
        "- `test-file.ts`",
        "",
        "<conflict-resolution>ambiguous</conflict-resolution>",
      ].join("\n");
    }

    function setupDefaultRepo(): void {
      execFileSync("git", ["-c", "init.defaultBranch=main", "init"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["config", "user.email", "test@test.com"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });

      writeFileSync(join(tmpRepoRoot, "test-file.ts"), "initial content\n");
      writeFileSync(join(tmpRepoRoot, "another-file.ts"), "another initial\n");
      execFileSync("git", ["add", "-A"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "init"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });

      execFileSync("git", ["checkout", "-b", "pourkit/42/test-issue"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });
      writeFileSync(join(tmpRepoRoot, "test-file.ts"), "worktree change\n");
      writeFileSync(
        join(tmpRepoRoot, "another-file.ts"),
        "another worktree change\n"
      );
      execFileSync("git", ["add", "-A"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "branch change"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });

      execFileSync("git", ["checkout", "main"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });
      writeFileSync(join(tmpRepoRoot, "test-file.ts"), "main change\n");
      writeFileSync(
        join(tmpRepoRoot, "another-file.ts"),
        "main change to another\n"
      );
      execFileSync("git", ["add", "-A"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "main change"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });

      execFileSync(
        "git",
        ["worktree", "add", worktreePath, "pourkit/42/test-issue"],
        { cwd: tmpRepoRoot, encoding: "utf8" }
      );
    }

    function mockGitCommands(additionalHandlers?: {
      addPaths?: string[];
      onAdd?: (args: string[]) => void;
    }): void {
      let mergeBaseCalls = 0;
      execCaptureMock.mockImplementation(async (command, args, options) => {
        const opts = options as { cwd?: string } | undefined;
        const isWorktreeOp = opts?.cwd === worktreePath;

        if (command === "git" && args[0] === "worktree" && args[1] === "list") {
          return {
            code: 0,
            stdout: [
              `worktree ${worktreePath}`,
              "HEAD abc123",
              "branch refs/heads/pourkit/42/test-issue",
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        if (command === "git" && args[0] === "fetch") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (
          command === "git" &&
          args[0] === "branch" &&
          args[1] === "--force"
        ) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "diff") {
          return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
        }
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[1] === "--is-ancestor"
        ) {
          mergeBaseCalls++;
          if (mergeBaseCalls === 1) {
            throw new Error("not ancestor");
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "rebase" && isWorktreeOp) {
          try {
            execFileSync("git", args as string[], {
              cwd: opts!.cwd as string,
              encoding: "utf8",
              env: { ...process.env, GIT_EDITOR: "true" },
            });
            return { code: 0, stdout: "", stderr: "" };
          } catch {
            throw new Error("rebase conflict");
          }
        }
        if (command === "git" && args[0] === "add" && isWorktreeOp) {
          if (additionalHandlers?.onAdd) {
            additionalHandlers.onAdd(args.slice(1));
          }
          execFileSync("git", args as string[], {
            cwd: opts!.cwd as string,
            encoding: "utf8",
          });
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "status" && isWorktreeOp) {
          const result = execFileSync("git", ["status", "--porcelain"], {
            cwd: opts!.cwd as string,
            encoding: "utf8",
          }) as string;
          return { code: 0, stdout: result, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });
    }

    beforeEach(() => {
      tmpRepoRoot = mkdtempSync(join(tmpdir(), "pourkit-conflict-cr-test-"));
      worktreePath = join(
        tmpRepoRoot,
        ".sandcastle",
        "worktrees",
        "pourkit-42-test-issue"
      );
      mkdirSync(join(tmpRepoRoot, ".sandcastle", "worktrees"), {
        recursive: true,
      });
      setupDefaultRepo();
      repoRootMock.mockReturnValue(tmpRepoRoot);
      mockGitCommands();
    });

    afterEach(() => {
      rmSync(tmpRepoRoot, { recursive: true, force: true });
    });

    it("resolves one rebase conflict via conflictResolution agent, continues rebase, and does not rerun builder", async () => {
      mkdirSync(join(worktreePath, ".pourkit"), { recursive: true });
      writeWorktreeRunState(worktreePath, {
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true },
        review: { lifetimeIterations: 0 },
      });

      executionProvider = new FakeExecutionProvider({
        success: true,
        branch: "pourkit/42/test-issue",
        worktreePath,
        commits: ["fix: implement feature"],
        logPath: null,
      });

      const artifactContent = validResolvedArtifact();
      const providerCalls: any[] = [];
      const crExecutionProvider = {
        calls: providerCalls,
        async execute(opts: any) {
          providerCalls.push(opts);
          if (opts.stage === "conflictResolution") {
            if (opts.artifactPath && opts.worktreePath) {
              const fullPath = join(opts.worktreePath, opts.artifactPath);
              mkdirSync(join(fullPath, ".."), { recursive: true });
              writeFileSync(fullPath, artifactContent, "utf-8");
            }

            writeFileSync(
              join(worktreePath, "test-file.ts"),
              "resolved content\n"
            );
            writeFileSync(
              join(worktreePath, "another-file.ts"),
              "resolved another\n"
            );

            return {
              success: true,
              branch: "pourkit/42/test-issue",
              worktreePath,
              commits: [],
              logPath: null,
            };
          }
          return executionProvider.execute(opts);
        },
      };

      const config = makeConfig({
        target: {
          strategy: {
            type: "review-refactor-loop" as const,
            implement: {
              builder: {
                agent: "build",
                model: "test",
                promptTemplate: "test.md",
              },
            },
            conflictResolution: {
              agent: "resolve",
              model: "test-resolve",
              promptTemplate: "resolve.md",
              maxAttempts: 1,
            },
            review: {
              reviewer: {
                agent: "review",
                model: "test",
                promptTemplate: "test.md",
                criteria: [],
              },
              refactor: {
                agent: "refactor",
                model: "test",
                promptTemplate: "test.md",
              },
              maxIterations: 3,
              passWithNotesRefactorAttempts: 2,
            },
            verify: {
              commands: [{ command: "npm run typecheck", label: "typecheck" }],
            },
            finalize: {
              prDescriptionAgent: {
                agent: "finalizer",
                model: "test",
                promptTemplate: "test.md",
              },
              maxAttempts: 2,
            },
          },
        },
      });

      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();

      const result = await startIssueRun({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider: crExecutionProvider as any,
        force: true,
        logger,
        repoRoot: tmpRepoRoot,
      });

      expect(
        providerCalls.some((call) => call.stage === "conflictResolution")
      ).toBe(true);

      expect(
        executionProvider.calls.some((call) => call.stage === "builder")
      ).toBe(false);

      expect(result.branchName).toBe("pourkit/42/test-issue");
      const rebaseCheck = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: worktreePath,
        encoding: "utf8",
      }) as string;
      expect(rebaseCheck.trim()).toBeTruthy();

      const state = readWorktreeRunState(worktreePath);
      expect(state).not.toBeNull();
      expect(state!.lastFailure).toBeUndefined();
    });

    it("stages only originally conflicted paths before rebase continue when agent also edits supporting files", async () => {
      const singleConflictRoot = mkdtempSync(
        join(tmpdir(), "pourkit-single-conflict-")
      );
      const singleWorktree = join(
        singleConflictRoot,
        ".sandcastle",
        "worktrees",
        "pourkit-42-test-issue"
      );
      mkdirSync(join(singleConflictRoot, ".sandcastle", "worktrees"), {
        recursive: true,
      });

      execFileSync("git", ["-c", "init.defaultBranch=main", "init"], {
        cwd: singleConflictRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["config", "user.email", "test@test.com"], {
        cwd: singleConflictRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: singleConflictRoot,
        encoding: "utf8",
      });

      writeFileSync(join(singleConflictRoot, "test-file.ts"), "initial\n");
      writeFileSync(
        join(singleConflictRoot, "support-file.ts"),
        "support initial\n"
      );
      execFileSync("git", ["add", "-A"], {
        cwd: singleConflictRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "init"], {
        cwd: singleConflictRoot,
        encoding: "utf8",
      });

      execFileSync("git", ["checkout", "-b", "pourkit/42/test-issue"], {
        cwd: singleConflictRoot,
        encoding: "utf8",
      });
      writeFileSync(
        join(singleConflictRoot, "test-file.ts"),
        "branch change\n"
      );
      execFileSync("git", ["add", "-A"], {
        cwd: singleConflictRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "branch change"], {
        cwd: singleConflictRoot,
        encoding: "utf8",
      });

      execFileSync("git", ["checkout", "main"], {
        cwd: singleConflictRoot,
        encoding: "utf8",
      });
      writeFileSync(join(singleConflictRoot, "test-file.ts"), "main change\n");
      execFileSync("git", ["add", "-A"], {
        cwd: singleConflictRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "main change"], {
        cwd: singleConflictRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
        cwd: singleConflictRoot,
        encoding: "utf8",
      });

      execFileSync(
        "git",
        ["worktree", "add", singleWorktree, "pourkit/42/test-issue"],
        { cwd: singleConflictRoot, encoding: "utf8" }
      );

      repoRootMock.mockReturnValue(singleConflictRoot);

      const stagedPaths: string[] = [];
      let mergeBaseCalls = 0;
      execCaptureMock.mockImplementation(async (command, args, options) => {
        const opts = options as { cwd?: string } | undefined;
        const isWorktreeOp = opts?.cwd === singleWorktree;

        if (command === "git" && args[0] === "worktree" && args[1] === "list") {
          return {
            code: 0,
            stdout: [
              `worktree ${singleWorktree}`,
              "HEAD abc123",
              "branch refs/heads/pourkit/42/test-issue",
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        if (command === "git" && args[0] === "fetch") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (
          command === "git" &&
          args[0] === "branch" &&
          args[1] === "--force"
        ) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "diff") {
          return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
        }
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[1] === "--is-ancestor"
        ) {
          mergeBaseCalls++;
          if (mergeBaseCalls === 1) {
            throw new Error("not ancestor");
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "rebase" && isWorktreeOp) {
          try {
            execFileSync("git", args as string[], {
              cwd: opts!.cwd as string,
              encoding: "utf8",
              env: { ...process.env, GIT_EDITOR: "true" },
            });
            return { code: 0, stdout: "", stderr: "" };
          } catch {
            throw new Error("rebase conflict");
          }
        }
        if (command === "git" && args[0] === "add" && isWorktreeOp) {
          stagedPaths.push(...args.slice(1));
          execFileSync("git", args as string[], {
            cwd: opts!.cwd as string,
            encoding: "utf8",
          });
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "status" && isWorktreeOp) {
          const result = execFileSync("git", ["status", "--porcelain"], {
            cwd: opts!.cwd as string,
            encoding: "utf8",
          }) as string;
          return { code: 0, stdout: result, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      mkdirSync(join(singleWorktree, ".pourkit"), { recursive: true });
      writeWorktreeRunState(singleWorktree, {
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true },
        review: { lifetimeIterations: 0 },
      });

      const artifactContent = [
        "## Status",
        "",
        "resolved",
        "",
        "## Summary",
        "",
        "- Resolved conflict.",
        "",
        "## Files",
        "",
        "- `test-file.ts`",
        "",
        "<conflict-resolution>resolved</conflict-resolution>",
      ].join("\n");

      const fakeExecution = new FakeExecutionProvider({
        success: true,
        branch: "pourkit/42/test-issue",
        worktreePath: singleWorktree,
        commits: [],
        logPath: null,
      });

      const crProvider = {
        async execute(opts: any) {
          if (opts.stage === "conflictResolution") {
            if (opts.artifactPath && opts.worktreePath) {
              const fullPath = join(opts.worktreePath, opts.artifactPath);
              mkdirSync(join(fullPath, ".."), { recursive: true });
              writeFileSync(fullPath, artifactContent, "utf-8");
            }

            writeFileSync(
              join(singleWorktree, "test-file.ts"),
              "resolved by agent\n"
            );
            writeFileSync(
              join(singleWorktree, "agent-notes.md"),
              "# Agent notes\n\nSupporting file created during conflict resolution.\n"
            );

            return {
              success: true,
              branch: "pourkit/42/test-issue",
              worktreePath: singleWorktree,
              commits: [],
              logPath: null,
            };
          }
          return fakeExecution.execute(opts);
        },
      };

      const config = makeConfig({
        target: {
          strategy: {
            type: "review-refactor-loop" as const,
            implement: {
              builder: {
                agent: "build",
                model: "test",
                promptTemplate: "test.md",
              },
            },
            conflictResolution: {
              agent: "resolve",
              model: "test-resolve",
              promptTemplate: "resolve.md",
              maxAttempts: 1,
            },
            review: {
              reviewer: {
                agent: "review",
                model: "test",
                promptTemplate: "test.md",
                criteria: [],
              },
              refactor: {
                agent: "refactor",
                model: "test",
                promptTemplate: "test.md",
              },
              maxIterations: 3,
              passWithNotesRefactorAttempts: 2,
            },
            verify: {
              commands: [{ command: "npm run typecheck", label: "typecheck" }],
            },
            finalize: {
              prDescriptionAgent: {
                agent: "finalizer",
                model: "test",
                promptTemplate: "test.md",
              },
              maxAttempts: 2,
            },
          },
        },
      });

      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();

      await startIssueRun({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider: crProvider as any,
        force: true,
        logger,
        repoRoot: singleConflictRoot,
      });

      expect(stagedPaths).toEqual(["test-file.ts"]);

      rmSync(singleConflictRoot, { recursive: true, force: true });
    });

    it("rejects resolved artifact with remaining conflict markers in conflicted files", async () => {
      mkdirSync(join(worktreePath, ".pourkit"), { recursive: true });
      writeWorktreeRunState(worktreePath, {
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true },
        review: { lifetimeIterations: 0 },
      });

      executionProvider = new FakeExecutionProvider({
        success: true,
        branch: "pourkit/42/test-issue",
        worktreePath,
        commits: [],
        logPath: null,
      });

      const artifactContent = validResolvedArtifact();
      const crProvider = {
        async execute(opts: any) {
          if (opts.stage === "conflictResolution") {
            if (opts.artifactPath && opts.worktreePath) {
              const fullPath = join(opts.worktreePath, opts.artifactPath);
              mkdirSync(join(fullPath, ".."), { recursive: true });
              writeFileSync(fullPath, artifactContent, "utf-8");
            }

            return {
              success: true,
              branch: "pourkit/42/test-issue",
              worktreePath,
              commits: [],
              logPath: null,
            };
          }
          return executionProvider.execute(opts);
        },
      };

      const config = makeConfig({
        target: {
          strategy: {
            type: "review-refactor-loop" as const,
            implement: {
              builder: {
                agent: "build",
                model: "test",
                promptTemplate: "test.md",
              },
            },
            conflictResolution: {
              agent: "resolve",
              model: "test-resolve",
              promptTemplate: "resolve.md",
              maxAttempts: 1,
            },
            review: {
              reviewer: {
                agent: "review",
                model: "test",
                promptTemplate: "test.md",
                criteria: [],
              },
              refactor: {
                agent: "refactor",
                model: "test",
                promptTemplate: "test.md",
              },
              maxIterations: 3,
              passWithNotesRefactorAttempts: 2,
            },
            verify: {
              commands: [{ command: "npm run typecheck", label: "typecheck" }],
            },
            finalize: {
              prDescriptionAgent: {
                agent: "finalizer",
                model: "test",
                promptTemplate: "test.md",
              },
              maxAttempts: 2,
            },
          },
        },
      });

      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const addLabelsSpy = vi.spyOn(issueProvider, "addLabels");
      const prProvider = makePrProvider();
      const logger = makeLogger();

      await expect(
        startIssueRun({
          issueNumber: 42,
          config,
          issueProvider,
          prProvider,
          executionProvider: crProvider as any,
          force: true,
          logger,
          repoRoot: tmpRepoRoot,
        })
      ).rejects.toThrow("Conflict resolution ambiguous");

      expect(addLabelsSpy).toHaveBeenCalledWith(42, [
        config.labels.readyForHuman,
      ]);
      expect(existsSync(worktreePath)).toBe(true);

      const state = readWorktreeRunState(worktreePath);
      expect(state).not.toBeNull();
      expect(state!.lastFailure?.stage).toBe("conflictResolution");
    });

    it("transitions to ready-for-human on ambiguous conflict resolution artifact", async () => {
      mkdirSync(join(worktreePath, ".pourkit"), { recursive: true });
      writeWorktreeRunState(worktreePath, {
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true },
        review: { lifetimeIterations: 0 },
      });

      executionProvider = new FakeExecutionProvider({
        success: true,
        branch: "pourkit/42/test-issue",
        worktreePath,
        commits: [],
        logPath: null,
      });

      const artifactContent = validAmbiguousArtifact();
      const crProvider = {
        async execute(opts: any) {
          if (opts.stage === "conflictResolution") {
            if (opts.artifactPath && opts.worktreePath) {
              const fullPath = join(opts.worktreePath, opts.artifactPath);
              mkdirSync(join(fullPath, ".."), { recursive: true });
              writeFileSync(fullPath, artifactContent, "utf-8");
            }

            writeFileSync(
              join(worktreePath, "test-file.ts"),
              "resolved content\n"
            );
            writeFileSync(
              join(worktreePath, "another-file.ts"),
              "resolved another\n"
            );

            return {
              success: true,
              branch: "pourkit/42/test-issue",
              worktreePath,
              commits: [],
              logPath: null,
            };
          }
          return executionProvider.execute(opts);
        },
      };

      const config = makeConfig({
        target: {
          strategy: {
            type: "review-refactor-loop" as const,
            implement: {
              builder: {
                agent: "build",
                model: "test",
                promptTemplate: "test.md",
              },
            },
            conflictResolution: {
              agent: "resolve",
              model: "test-resolve",
              promptTemplate: "resolve.md",
              maxAttempts: 1,
            },
            review: {
              reviewer: {
                agent: "review",
                model: "test",
                promptTemplate: "test.md",
                criteria: [],
              },
              refactor: {
                agent: "refactor",
                model: "test",
                promptTemplate: "test.md",
              },
              maxIterations: 3,
              passWithNotesRefactorAttempts: 2,
            },
            verify: {
              commands: [{ command: "npm run typecheck", label: "typecheck" }],
            },
            finalize: {
              prDescriptionAgent: {
                agent: "finalizer",
                model: "test",
                promptTemplate: "test.md",
              },
              maxAttempts: 2,
            },
          },
        },
      });

      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const addLabelsSpy = vi.spyOn(issueProvider, "addLabels");
      const prProvider = makePrProvider();
      const logger = makeLogger();

      await expect(
        startIssueRun({
          issueNumber: 42,
          config,
          issueProvider,
          prProvider,
          executionProvider: crProvider as any,
          force: true,
          logger,
          repoRoot: tmpRepoRoot,
        })
      ).rejects.toThrow("Conflict resolution ambiguous");

      expect(addLabelsSpy).toHaveBeenCalledWith(42, [
        config.labels.readyForHuman,
      ]);
      expect(existsSync(worktreePath)).toBe(true);

      const state = readWorktreeRunState(worktreePath);
      expect(state).not.toBeNull();
      expect(state!.lastFailure?.stage).toBe("conflictResolution");
    });

    it("resolves two separate rebase conflicts across full rebase within maxAttempts", async () => {
      const multiRoot = mkdtempSync(join(tmpdir(), "pourkit-multi-conflict-"));
      const multiWorktree = join(
        multiRoot,
        ".sandcastle",
        "worktrees",
        "pourkit-42-test-issue"
      );
      mkdirSync(join(multiRoot, ".sandcastle", "worktrees"), {
        recursive: true,
      });

      execFileSync("git", ["-c", "init.defaultBranch=main", "init"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["config", "user.email", "test@test.com"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: multiRoot,
        encoding: "utf8",
      });

      writeFileSync(join(multiRoot, "file-a.ts"), "initial a\n");
      writeFileSync(join(multiRoot, "file-b.ts"), "initial b\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "init"], {
        cwd: multiRoot,
        encoding: "utf8",
      });

      execFileSync("git", ["checkout", "-b", "pourkit/42/test-issue"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      writeFileSync(join(multiRoot, "file-a.ts"), "branch a change\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "branch commit 1"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      writeFileSync(join(multiRoot, "file-b.ts"), "branch b change\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "branch commit 2"], {
        cwd: multiRoot,
        encoding: "utf8",
      });

      execFileSync("git", ["checkout", "main"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      writeFileSync(join(multiRoot, "file-a.ts"), "main a change\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "main change 1"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      writeFileSync(join(multiRoot, "file-b.ts"), "main b change\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "main change 2"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
        cwd: multiRoot,
        encoding: "utf8",
      });

      execFileSync(
        "git",
        ["worktree", "add", multiWorktree, "pourkit/42/test-issue"],
        { cwd: multiRoot, encoding: "utf8" }
      );

      repoRootMock.mockReturnValue(multiRoot);

      const crAttemptCalls: any[] = [];
      let resolveCallCount = 0;

      execCaptureMock.mockImplementation(async (command, args, options) => {
        const opts = options as { cwd?: string } | undefined;
        const isWorktreeOp = opts?.cwd === multiWorktree;

        if (command === "git" && args[0] === "worktree" && args[1] === "list") {
          return {
            code: 0,
            stdout: [
              `worktree ${multiWorktree}`,
              "HEAD abc123",
              "branch refs/heads/pourkit/42/test-issue",
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        if (command === "git" && args[0] === "fetch") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (
          command === "git" &&
          args[0] === "branch" &&
          args[1] === "--force"
        ) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "diff") {
          return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
        }
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[1] === "--is-ancestor"
        ) {
          throw new Error("not ancestor");
        }
        if (command === "git" && args[0] === "rebase" && isWorktreeOp) {
          try {
            execFileSync("git", args as string[], {
              cwd: opts!.cwd as string,
              encoding: "utf8",
              env: { ...process.env, GIT_EDITOR: "true" },
            });
            return { code: 0, stdout: "", stderr: "" };
          } catch {
            throw new Error("rebase conflict");
          }
        }
        if (command === "git" && args[0] === "add" && isWorktreeOp) {
          execFileSync("git", args as string[], {
            cwd: opts!.cwd as string,
            encoding: "utf8",
          });
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "status" && isWorktreeOp) {
          const result = execFileSync("git", ["status", "--porcelain"], {
            cwd: opts!.cwd as string,
            encoding: "utf8",
          }) as string;
          return { code: 0, stdout: result, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      mkdirSync(join(multiWorktree, ".pourkit"), { recursive: true });
      writeWorktreeRunState(multiWorktree, {
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true },
        review: { lifetimeIterations: 0 },
      });

      const fakeExec = new FakeExecutionProvider({
        success: true,
        branch: "pourkit/42/test-issue",
        worktreePath: multiWorktree,
        commits: [],
        logPath: null,
      });

      const crExecutionProvider = {
        calls: crAttemptCalls,
        async execute(opts: any) {
          if (opts.stage === "conflictResolution") {
            crAttemptCalls.push(opts);
            resolveCallCount++;

            if (opts.artifactPath && opts.worktreePath) {
              const fullPath = join(opts.worktreePath, opts.artifactPath);
              mkdirSync(join(fullPath, ".."), { recursive: true });
              writeFileSync(
                fullPath,
                [
                  "## Status",
                  "",
                  "resolved",
                  "",
                  "## Summary",
                  "",
                  "- Resolved conflict.",
                  "",
                  "## Files",
                  "",
                  "- `file-a.ts`",
                  "- `file-b.ts`",
                  "",
                  "<conflict-resolution>resolved</conflict-resolution>",
                ].join("\n"),
                "utf-8"
              );
            }

            const statusResult = execFileSync(
              "git",
              ["status", "--porcelain"],
              {
                cwd: multiWorktree,
                encoding: "utf8",
              }
            ) as string;
            const uuMatches = statusResult
              .split("\n")
              .filter((l) => /^UU\s/.test(l))
              .map((l) => l.slice(3).trim());
            for (const uuFile of uuMatches) {
              const fullFile = join(multiWorktree, uuFile);
              writeFileSync(fullFile, `resolved ${uuFile}\n`);
            }

            return {
              success: true,
              branch: "pourkit/42/test-issue",
              worktreePath: multiWorktree,
              commits: [],
              logPath: null,
            };
          }
          return fakeExec.execute(opts);
        },
      };

      const config = makeConfig({
        target: {
          strategy: {
            type: "review-refactor-loop" as const,
            implement: {
              builder: {
                agent: "build",
                model: "test",
                promptTemplate: "test.md",
              },
            },
            conflictResolution: {
              agent: "resolve",
              model: "test-resolve",
              promptTemplate: "resolve.md",
              maxAttempts: 2,
            },
            review: {
              reviewer: {
                agent: "review",
                model: "test",
                promptTemplate: "test.md",
                criteria: [],
              },
              refactor: {
                agent: "refactor",
                model: "test",
                promptTemplate: "test.md",
              },
              maxIterations: 3,
              passWithNotesRefactorAttempts: 2,
            },
            verify: {
              commands: [{ command: "npm run typecheck", label: "typecheck" }],
            },
            finalize: {
              prDescriptionAgent: {
                agent: "finalizer",
                model: "test",
                promptTemplate: "test.md",
              },
              maxAttempts: 2,
            },
          },
        },
      });

      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();

      const result = await startIssueRun({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider: crExecutionProvider as any,
        force: true,
        logger,
        repoRoot: multiRoot,
      });

      const conflictCalls = crAttemptCalls.filter(
        (call: any) => call.stage === "conflictResolution"
      );
      expect(conflictCalls).toHaveLength(2);
      expect(result.branchName).toBe("pourkit/42/test-issue");

      const rebaseCheck = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: multiWorktree,
        encoding: "utf8",
      }) as string;
      expect(rebaseCheck.trim()).toBeTruthy();
      const state = readWorktreeRunState(multiWorktree);
      expect(state).not.toBeNull();
      expect(state!.lastFailure).toBeUndefined();

      rmSync(multiRoot, { recursive: true, force: true });
    });

    it("exhausts maxAttempts when rebase has more conflicts than maxAttempts", async () => {
      const multiRoot = mkdtempSync(join(tmpdir(), "pourkit-maxexhaust-"));
      const multiWorktree = join(
        multiRoot,
        ".sandcastle",
        "worktrees",
        "pourkit-42-test-issue"
      );
      mkdirSync(join(multiRoot, ".sandcastle", "worktrees"), {
        recursive: true,
      });

      execFileSync("git", ["-c", "init.defaultBranch=main", "init"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["config", "user.email", "test@test.com"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: multiRoot,
        encoding: "utf8",
      });

      writeFileSync(join(multiRoot, "file-a.ts"), "initial a\n");
      writeFileSync(join(multiRoot, "file-b.ts"), "initial b\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "init"], {
        cwd: multiRoot,
        encoding: "utf8",
      });

      execFileSync("git", ["checkout", "-b", "pourkit/42/test-issue"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      writeFileSync(join(multiRoot, "file-a.ts"), "branch a change\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "branch commit 1"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      writeFileSync(join(multiRoot, "file-b.ts"), "branch b change\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "branch commit 2"], {
        cwd: multiRoot,
        encoding: "utf8",
      });

      execFileSync("git", ["checkout", "main"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      writeFileSync(join(multiRoot, "file-a.ts"), "main a change\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "main change 1"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      writeFileSync(join(multiRoot, "file-b.ts"), "main b change\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "main change 2"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
        cwd: multiRoot,
        encoding: "utf8",
      });

      execFileSync(
        "git",
        ["worktree", "add", multiWorktree, "pourkit/42/test-issue"],
        { cwd: multiRoot, encoding: "utf8" }
      );

      repoRootMock.mockReturnValue(multiRoot);

      let resolveCallCount = 0;

      execCaptureMock.mockImplementation(async (command, args, options) => {
        const opts = options as { cwd?: string } | undefined;
        const isWorktreeOp = opts?.cwd === multiWorktree;

        if (command === "git" && args[0] === "worktree" && args[1] === "list") {
          return {
            code: 0,
            stdout: [
              `worktree ${multiWorktree}`,
              "HEAD abc123",
              "branch refs/heads/pourkit/42/test-issue",
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        if (command === "git" && args[0] === "fetch") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (
          command === "git" &&
          args[0] === "branch" &&
          args[1] === "--force"
        ) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "diff") {
          return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
        }
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[1] === "--is-ancestor"
        ) {
          throw new Error("not ancestor");
        }
        if (command === "git" && args[0] === "rebase" && isWorktreeOp) {
          try {
            execFileSync("git", args as string[], {
              cwd: opts!.cwd as string,
              encoding: "utf8",
              env: { ...process.env, GIT_EDITOR: "true" },
            });
            return { code: 0, stdout: "", stderr: "" };
          } catch {
            throw new Error("rebase conflict");
          }
        }
        if (command === "git" && args[0] === "add" && isWorktreeOp) {
          execFileSync("git", args as string[], {
            cwd: opts!.cwd as string,
            encoding: "utf8",
          });
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "status" && isWorktreeOp) {
          const result = execFileSync("git", ["status", "--porcelain"], {
            cwd: opts!.cwd as string,
            encoding: "utf8",
          }) as string;
          return { code: 0, stdout: result, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      mkdirSync(join(multiWorktree, ".pourkit"), { recursive: true });
      writeWorktreeRunState(multiWorktree, {
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true },
        review: { lifetimeIterations: 0 },
      });

      const fakeExec = new FakeExecutionProvider({
        success: true,
        branch: "pourkit/42/test-issue",
        worktreePath: multiWorktree,
        commits: [],
        logPath: null,
      });

      const crAttemptCalls: any[] = [];
      const crExecutionProvider = {
        calls: crAttemptCalls,
        async execute(opts: any) {
          if (opts.stage === "conflictResolution") {
            crAttemptCalls.push(opts);
            resolveCallCount++;

            if (opts.artifactPath && opts.worktreePath) {
              const fullPath = join(opts.worktreePath, opts.artifactPath);
              mkdirSync(join(fullPath, ".."), { recursive: true });
              writeFileSync(
                fullPath,
                [
                  "## Status",
                  "",
                  "resolved",
                  "",
                  "## Summary",
                  "",
                  "- Resolved conflict.",
                  "",
                  "## Files",
                  "",
                  "- `file-a.ts`",
                  "- `file-b.ts`",
                  "",
                  "<conflict-resolution>resolved</conflict-resolution>",
                ].join("\n"),
                "utf-8"
              );
            }

            const statusResult = execFileSync(
              "git",
              ["status", "--porcelain"],
              {
                cwd: multiWorktree,
                encoding: "utf8",
              }
            ) as string;
            const uuMatches = statusResult
              .split("\n")
              .filter((l) => /^UU\s/.test(l))
              .map((l) => l.slice(3).trim());
            for (const uuFile of uuMatches) {
              const fullFile = join(multiWorktree, uuFile);
              writeFileSync(fullFile, `resolved ${uuFile}\n`);
            }

            return {
              success: true,
              branch: "pourkit/42/test-issue",
              worktreePath: multiWorktree,
              commits: [],
              logPath: null,
            };
          }
          return fakeExec.execute(opts);
        },
      };

      const config = makeConfig({
        target: {
          strategy: {
            type: "review-refactor-loop" as const,
            implement: {
              builder: {
                agent: "build",
                model: "test",
                promptTemplate: "test.md",
              },
            },
            conflictResolution: {
              agent: "resolve",
              model: "test-resolve",
              promptTemplate: "resolve.md",
              maxAttempts: 1,
            },
            review: {
              reviewer: {
                agent: "review",
                model: "test",
                promptTemplate: "test.md",
                criteria: [],
              },
              refactor: {
                agent: "refactor",
                model: "test",
                promptTemplate: "test.md",
              },
              maxIterations: 3,
              passWithNotesRefactorAttempts: 2,
            },
            verify: {
              commands: [{ command: "npm run typecheck", label: "typecheck" }],
            },
            finalize: {
              prDescriptionAgent: {
                agent: "finalizer",
                model: "test",
                promptTemplate: "test.md",
              },
              maxAttempts: 2,
            },
          },
        },
      });

      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const addLabelsSpy = vi.spyOn(issueProvider, "addLabels");
      const prProvider = makePrProvider();
      const logger = makeLogger();

      await expect(
        startIssueRun({
          issueNumber: 42,
          config,
          issueProvider,
          prProvider,
          executionProvider: crExecutionProvider as any,
          force: true,
          logger,
          repoRoot: multiRoot,
        })
      ).rejects.toThrow("Conflict resolution maxAttempts");

      const conflictCalls = crAttemptCalls.filter(
        (call: any) => call.stage === "conflictResolution"
      );
      expect(conflictCalls).toHaveLength(1);

      expect(addLabelsSpy).toHaveBeenCalledWith(42, [
        config.labels.readyForHuman,
      ]);
      expect(existsSync(multiWorktree)).toBe(true);

      const state = readWorktreeRunState(multiWorktree);
      expect(state).not.toBeNull();
      expect(state!.lastFailure?.stage).toBe("conflictResolution");

      rmSync(multiRoot, { recursive: true, force: true });
    });

    it("runs verification commands once after full rebase, not between conflict-resolution attempts", async () => {
      const multiRoot = mkdtempSync(join(tmpdir(), "pourkit-verify-after-"));
      const multiWorktree = join(
        multiRoot,
        ".sandcastle",
        "worktrees",
        "pourkit-42-test-issue"
      );
      mkdirSync(join(multiRoot, ".sandcastle", "worktrees"), {
        recursive: true,
      });

      execFileSync("git", ["-c", "init.defaultBranch=main", "init"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["config", "user.email", "test@test.com"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: multiRoot,
        encoding: "utf8",
      });

      writeFileSync(join(multiRoot, "file-a.ts"), "initial a\n");
      writeFileSync(join(multiRoot, "file-b.ts"), "initial b\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "init"], {
        cwd: multiRoot,
        encoding: "utf8",
      });

      execFileSync("git", ["checkout", "-b", "pourkit/42/test-issue"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      writeFileSync(join(multiRoot, "file-a.ts"), "branch a change\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "branch commit 1"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      writeFileSync(join(multiRoot, "file-b.ts"), "branch b change\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "branch commit 2"], {
        cwd: multiRoot,
        encoding: "utf8",
      });

      execFileSync("git", ["checkout", "main"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      writeFileSync(join(multiRoot, "file-a.ts"), "main a change\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "main change 1"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      writeFileSync(join(multiRoot, "file-b.ts"), "main b change\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "main change 2"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
        cwd: multiRoot,
        encoding: "utf8",
      });

      execFileSync(
        "git",
        ["worktree", "add", multiWorktree, "pourkit/42/test-issue"],
        { cwd: multiRoot, encoding: "utf8" }
      );

      repoRootMock.mockReturnValue(multiRoot);

      const execCallLog: { command: string; args: string[]; idx: number }[] =
        [];
      let execCallIdx = 0;

      execCaptureMock.mockImplementation(async (command, args, options) => {
        const opts = options as { cwd?: string } | undefined;
        const isWorktreeOp = opts?.cwd === multiWorktree;
        const idx = execCallIdx++;

        execCallLog.push({ command, args, idx });

        if (command === "git" && args[0] === "worktree" && args[1] === "list") {
          return {
            code: 0,
            stdout: [
              `worktree ${multiWorktree}`,
              "HEAD abc123",
              "branch refs/heads/pourkit/42/test-issue",
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        if (command === "git" && args[0] === "fetch") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (
          command === "git" &&
          args[0] === "branch" &&
          args[1] === "--force"
        ) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "diff") {
          return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
        }
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[1] === "--is-ancestor"
        ) {
          throw new Error("not ancestor");
        }
        if (command === "git" && args[0] === "rebase" && isWorktreeOp) {
          try {
            execFileSync("git", args as string[], {
              cwd: opts!.cwd as string,
              encoding: "utf8",
              env: { ...process.env, GIT_EDITOR: "true" },
            });
            return { code: 0, stdout: "", stderr: "" };
          } catch {
            throw new Error("rebase conflict");
          }
        }
        if (command === "git" && args[0] === "add" && isWorktreeOp) {
          execFileSync("git", args as string[], {
            cwd: opts!.cwd as string,
            encoding: "utf8",
          });
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "status" && isWorktreeOp) {
          const result = execFileSync("git", ["status", "--porcelain"], {
            cwd: opts!.cwd as string,
            encoding: "utf8",
          }) as string;
          return { code: 0, stdout: result, stderr: "" };
        }
        if (command === "bash") {
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      mkdirSync(join(multiWorktree, ".pourkit"), { recursive: true });
      writeWorktreeRunState(multiWorktree, {
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true },
        review: { lifetimeIterations: 0 },
      });

      const fakeExec = new FakeExecutionProvider({
        success: true,
        branch: "pourkit/42/test-issue",
        worktreePath: multiWorktree,
        commits: [],
        logPath: null,
      });

      const crExecutionProvider = {
        async execute(opts: any) {
          if (opts.stage === "conflictResolution") {
            if (opts.artifactPath && opts.worktreePath) {
              const fullPath = join(opts.worktreePath, opts.artifactPath);
              mkdirSync(join(fullPath, ".."), { recursive: true });
              writeFileSync(
                fullPath,
                [
                  "## Status",
                  "",
                  "resolved",
                  "",
                  "## Summary",
                  "",
                  "- Resolved conflict.",
                  "",
                  "## Files",
                  "",
                  "- `file-a.ts`",
                  "- `file-b.ts`",
                  "",
                  "<conflict-resolution>resolved</conflict-resolution>",
                ].join("\n"),
                "utf-8"
              );
            }

            const statusResult = execFileSync(
              "git",
              ["status", "--porcelain"],
              {
                cwd: multiWorktree,
                encoding: "utf8",
              }
            ) as string;
            const uuMatches = statusResult
              .split("\n")
              .filter((l) => /^UU\s/.test(l))
              .map((l) => l.slice(3).trim());
            for (const uuFile of uuMatches) {
              const fullFile = join(multiWorktree, uuFile);
              writeFileSync(fullFile, `resolved ${uuFile}\n`);
            }

            return {
              success: true,
              branch: "pourkit/42/test-issue",
              worktreePath: multiWorktree,
              commits: [],
              logPath: null,
            };
          }
          return fakeExec.execute(opts);
        },
      };

      const config = makeConfig({
        target: {
          strategy: {
            type: "review-refactor-loop" as const,
            implement: {
              builder: {
                agent: "build",
                model: "test",
                promptTemplate: "test.md",
              },
            },
            conflictResolution: {
              agent: "resolve",
              model: "test-resolve",
              promptTemplate: "resolve.md",
              maxAttempts: 2,
            },
            review: {
              reviewer: {
                agent: "review",
                model: "test",
                promptTemplate: "test.md",
                criteria: [],
              },
              refactor: {
                agent: "refactor",
                model: "test",
                promptTemplate: "test.md",
              },
              maxIterations: 3,
              passWithNotesRefactorAttempts: 2,
            },
            verify: {
              commands: [{ command: "npm run typecheck", label: "typecheck" }],
            },
            finalize: {
              prDescriptionAgent: {
                agent: "finalizer",
                model: "test",
                promptTemplate: "test.md",
              },
              maxAttempts: 2,
            },
          },
        },
      });

      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();

      await startIssueRun({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider: crExecutionProvider as any,
        force: true,
        logger,
        repoRoot: multiRoot,
      });

      const verifyCalls = execCallLog.filter(
        (entry) => entry.command === "bash"
      );
      expect(verifyCalls).toHaveLength(1);

      const rebaseContinueIndices = execCallLog
        .filter(
          (entry) =>
            entry.command === "git" &&
            entry.args[0] === "rebase" &&
            entry.args[1] === "--continue"
        )
        .map((entry) => entry.idx);
      const firstVerifyIdx = verifyCalls[0].idx;

      if (rebaseContinueIndices.length > 0) {
        const lastRebaseContinueIdx = Math.max(...rebaseContinueIndices);
        expect(firstVerifyIdx).toBeGreaterThan(lastRebaseContinueIdx);
      }

      rmSync(multiRoot, { recursive: true, force: true });
    });

    it("runs reviewer after full rebase and before finalizer when base refresh succeeds after multiple conflicts", async () => {
      const multiRoot = mkdtempSync(join(tmpdir(), "pourkit-review-after-"));
      const multiWorktree = join(
        multiRoot,
        ".sandcastle",
        "worktrees",
        "pourkit-42-test-issue"
      );
      mkdirSync(join(multiRoot, ".sandcastle", "worktrees"), {
        recursive: true,
      });

      execFileSync("git", ["-c", "init.defaultBranch=main", "init"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["config", "user.email", "test@test.com"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: multiRoot,
        encoding: "utf8",
      });

      writeFileSync(join(multiRoot, "file-a.ts"), "initial a\n");
      writeFileSync(join(multiRoot, "file-b.ts"), "initial b\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "init"], {
        cwd: multiRoot,
        encoding: "utf8",
      });

      execFileSync("git", ["checkout", "-b", "pourkit/42/test-issue"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      writeFileSync(join(multiRoot, "file-a.ts"), "branch a change\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "branch commit 1"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      writeFileSync(join(multiRoot, "file-b.ts"), "branch b change\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "branch commit 2"], {
        cwd: multiRoot,
        encoding: "utf8",
      });

      execFileSync("git", ["checkout", "main"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      writeFileSync(join(multiRoot, "file-a.ts"), "main a change\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "main change 1"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      writeFileSync(join(multiRoot, "file-b.ts"), "main b change\n");
      execFileSync("git", ["add", "-A"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "main change 2"], {
        cwd: multiRoot,
        encoding: "utf8",
      });
      execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
        cwd: multiRoot,
        encoding: "utf8",
      });

      execFileSync(
        "git",
        ["worktree", "add", multiWorktree, "pourkit/42/test-issue"],
        { cwd: multiRoot, encoding: "utf8" }
      );

      repoRootMock.mockReturnValue(multiRoot);

      let mergeBaseCalls = 0;
      execCaptureMock.mockImplementation(async (command, args, options) => {
        const opts = options as { cwd?: string } | undefined;
        const isWorktreeOp = opts?.cwd === multiWorktree;

        if (command === "git" && args[0] === "worktree" && args[1] === "list") {
          return {
            code: 0,
            stdout: [
              `worktree ${multiWorktree}`,
              "HEAD abc123",
              "branch refs/heads/pourkit/42/test-issue",
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        if (command === "git" && args[0] === "fetch") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (
          command === "git" &&
          args[0] === "branch" &&
          args[1] === "--force"
        ) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "diff") {
          return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
        }
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[1] === "--is-ancestor"
        ) {
          mergeBaseCalls++;
          if (mergeBaseCalls === 1) {
            throw new Error("not ancestor");
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "rebase" && isWorktreeOp) {
          try {
            execFileSync("git", args as string[], {
              cwd: opts!.cwd as string,
              encoding: "utf8",
              env: { ...process.env, GIT_EDITOR: "true" },
            });
            return { code: 0, stdout: "", stderr: "" };
          } catch {
            throw new Error("rebase conflict");
          }
        }
        if (command === "git" && args[0] === "add" && isWorktreeOp) {
          execFileSync("git", args as string[], {
            cwd: opts!.cwd as string,
            encoding: "utf8",
          });
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "status" && isWorktreeOp) {
          const result = execFileSync("git", ["status", "--porcelain"], {
            cwd: opts!.cwd as string,
            encoding: "utf8",
          }) as string;
          return { code: 0, stdout: result, stderr: "" };
        }
        if (command === "bash") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "rev-parse") {
          return { code: 0, stdout: "abc123def456\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      mkdirSync(join(multiWorktree, ".pourkit"), { recursive: true });
      writeWorktreeRunState(multiWorktree, {
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true },
        review: { lifetimeIterations: 0 },
      });

      const stageCalls: string[] = [];
      const multiExecutionProvider = {
        async execute(opts: any) {
          stageCalls.push(opts.stage);

          if (opts.stage === "conflictResolution") {
            if (opts.artifactPath && opts.worktreePath) {
              const fullPath = join(opts.worktreePath, opts.artifactPath);
              mkdirSync(join(fullPath, ".."), { recursive: true });
              writeFileSync(
                fullPath,
                [
                  "## Status",
                  "",
                  "resolved",
                  "",
                  "## Summary",
                  "",
                  "- Resolved conflict.",
                  "",
                  "## Files",
                  "",
                  "- `file-a.ts`",
                  "- `file-b.ts`",
                  "",
                  "<conflict-resolution>resolved</conflict-resolution>",
                ].join("\n"),
                "utf-8"
              );
            }

            const statusResult = execFileSync(
              "git",
              ["status", "--porcelain"],
              {
                cwd: multiWorktree,
                encoding: "utf8",
              }
            ) as string;
            const uuMatches = statusResult
              .split("\n")
              .filter((l) => /^UU\s/.test(l))
              .map((l) => l.slice(3).trim());
            for (const uuFile of uuMatches) {
              const fullFile = join(multiWorktree, uuFile);
              writeFileSync(fullFile, `resolved ${uuFile}\n`);
            }

            return {
              success: true,
              branch: "pourkit/42/test-issue",
              worktreePath: multiWorktree,
              commits: [],
              logPath: null,
            };
          }

          if (opts.stage === "reviewer") {
            const reviewerArtifactPath = join(
              opts.worktreePath ?? multiWorktree,
              opts.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md"
            );
            mkdirSync(join(reviewerArtifactPath, ".."), { recursive: true });
            writeReviewerArtifact(reviewerArtifactPath, "PASS");
            return {
              success: true,
              branch: "pourkit/42/test-issue",
              worktreePath: multiWorktree,
              commits: [],
              logPath: null,
            };
          }

          if (opts.stage === "finalizer") {
            const finalizerArtifactPath = join(
              opts.worktreePath ?? multiWorktree,
              opts.artifactPath ?? ".pourkit/.tmp/finalizer/agent-output.md"
            );
            mkdirSync(join(finalizerArtifactPath, ".."), { recursive: true });
            writeFileSync(
              finalizerArtifactPath,
              [
                "## PR Title",
                "",
                "fix: Test issue",
                "",
                "## PR Body",
                "",
                "## Summary",
                "",
                "- Resolved something.",
                "",
                "## Changes",
                "",
                "- Change description.",
                "",
                "Closes #42",
              ].join("\n"),
              "utf-8"
            );
            return {
              success: true,
              branch: "pourkit/42/test-issue",
              worktreePath: multiWorktree,
              commits: [],
              logPath: null,
            };
          }

          return {
            success: true,
            branch: "pourkit/42/test-issue",
            worktreePath: multiWorktree,
            commits: [],
            logPath: null,
          };
        },
      };

      const config = makeConfig({
        target: {
          strategy: {
            type: "review-refactor-loop" as const,
            implement: {
              builder: {
                agent: "build",
                model: "test",
                promptTemplate: "test.md",
              },
            },
            conflictResolution: {
              agent: "resolve",
              model: "test-resolve",
              promptTemplate: "resolve.md",
              maxAttempts: 2,
            },
            review: {
              reviewer: {
                agent: "review",
                model: "test",
                promptTemplate: "test.md",
                criteria: [],
              },
              refactor: {
                agent: "refactor",
                model: "test",
                promptTemplate: "test.md",
              },
              maxIterations: 3,
              passWithNotesRefactorAttempts: 2,
            },
            verify: {
              commands: [{ command: "npm run typecheck", label: "typecheck" }],
            },
            finalize: {
              prDescriptionAgent: {
                agent: "finalizer",
                model: "test",
                promptTemplate: "test.md",
              },
              maxAttempts: 2,
            },
          },
        },
      });

      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();

      const result = await runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider: multiExecutionProvider as any,
        force: true,
        logger,
        repoRoot: multiRoot,
      });

      const conflictResolutionIndices = stageCalls
        .map((s, i) => (s === "conflictResolution" ? i : -1))
        .filter((i) => i >= 0);
      const reviewerIdx = stageCalls.indexOf("reviewer");
      const finalizerIdx = stageCalls.indexOf("finalizer");

      const lastConflictResolutionIdx = Math.max(...conflictResolutionIndices);
      expect(reviewerIdx).toBeGreaterThan(lastConflictResolutionIdx);
      expect(finalizerIdx).toBeGreaterThan(reviewerIdx);
      expect(result.prNumber).toBe(7);

      rmSync(multiRoot, { recursive: true, force: true });
    });
  });

  describe("checked-out local Target base branch regression", () => {
    let tmpRepoRoot: string;

    function setupBaseBranchRepo(): string {
      const root = mkdtempSync(join(tmpdir(), "pourkit-checked-out-base-"));

      execFileSync("git", ["-c", "init.defaultBranch=main", "init"], {
        cwd: root,
        encoding: "utf8",
      });
      execFileSync("git", ["config", "user.email", "test@test.com"], {
        cwd: root,
        encoding: "utf8",
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: root,
        encoding: "utf8",
      });

      writeFileSync(join(root, "initial.txt"), "initial\n");
      execFileSync("git", ["add", "-A"], {
        cwd: root,
        encoding: "utf8",
      });
      execFileSync("git", ["commit", "-m", "initial"], {
        cwd: root,
        encoding: "utf8",
      });

      execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      });

      return root;
    }

    beforeEach(() => {
      vi.clearAllMocks();
      tmpRepoRoot = setupBaseBranchRepo();
      repoRootMock.mockReturnValue(tmpRepoRoot);
    });

    afterEach(() => {
      rmSync(tmpRepoRoot, { recursive: true, force: true });
    });

    it("runs while local Target base branch is checked out", async () => {
      const config = makeConfig();
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const executionProvider = new FakeExecutionProvider({
        success: true,
        branch: "pourkit/42/test-issue",
        worktreePath: `${tmpRepoRoot}/.sandcastle/worktrees/pourkit-42-test-issue`,
        commits: ["fix: implement feature"],
        logPath: null,
      });

      await runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger: makeLogger(),
        repoRoot: tmpRepoRoot,
      });

      expect(execCaptureMock).not.toHaveBeenCalledWith(
        "git",
        ["branch", "--force", "main", "origin/main"],
        expect.anything()
      );
    });

    it("checked-out local Target base branch remains unchanged", async () => {
      const beforeMainSha = execFileSync("git", ["rev-parse", "main"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });

      const config = makeConfig();
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const executionProvider = new FakeExecutionProvider({
        success: true,
        branch: "pourkit/42/test-issue",
        worktreePath: `${tmpRepoRoot}/.sandcastle/worktrees/pourkit-42-test-issue`,
        commits: ["fix: implement feature"],
        logPath: null,
      });

      await startIssueRun({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger: makeLogger(),
        repoRoot: tmpRepoRoot,
      });

      const afterMainSha = execFileSync("git", ["rev-parse", "main"], {
        cwd: tmpRepoRoot,
        encoding: "utf8",
      });

      expect(afterMainSha.toString().trim()).toBe(
        beforeMainSha.toString().trim()
      );
    });

    it("remote-backed refs are used across local Git operations", async () => {
      const config = makeConfig();
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const executionProvider = new FakeExecutionProvider({
        success: true,
        branch: "pourkit/42/test-issue",
        worktreePath: `${tmpRepoRoot}/.sandcastle/worktrees/pourkit-42-test-issue`,
        commits: ["fix: implement feature"],
        logPath: null,
      });

      await runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger: makeLogger(),
        repoRoot: tmpRepoRoot,
      });

      expect(execCaptureMock).toHaveBeenCalledWith(
        "git",
        ["fetch", "origin", "main"],
        expect.anything()
      );
      expect(execCaptureMock).toHaveBeenCalledWith(
        "git",
        ["diff", "--name-only", "origin/main", "--"],
        expect.anything()
      );
      expect(execCaptureMock).toHaveBeenCalledWith(
        "git",
        ["reset", "--soft", "origin/main"],
        expect.anything()
      );
    });

    it("PR base remains plain branch in checked-out base regression", async () => {
      const config = makeConfig();
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const executionProvider = new FakeExecutionProvider({
        success: true,
        branch: "pourkit/42/test-issue",
        worktreePath: `${tmpRepoRoot}/.sandcastle/worktrees/pourkit-42-test-issue`,
        commits: ["fix: implement feature"],
        logPath: null,
      });

      await runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger: makeLogger(),
        repoRoot: tmpRepoRoot,
      });

      expect(prProvider.createPr).toHaveBeenCalledWith(
        expect.objectContaining({ base: "main" })
      );
      expect(prProvider.createPr).not.toHaveBeenCalledWith(
        expect.objectContaining({ base: "origin/main" })
      );
    });

    it("Builder runs in isolated Worktree during checked-out base regression", async () => {
      const worktreePath = `${tmpRepoRoot}/.sandcastle/worktrees/pourkit-42-test-issue`;

      execCaptureMock.mockImplementation(async (command, args) => {
        if (command === "git" && args[0] === "worktree" && args[1] === "list") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "show-ref") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "worktree" && args[1] === "add") {
          mkdirSync(worktreePath, { recursive: true });
          writeWorktreeRunState(worktreePath, {
            issueNumber: 42,
            targetName: "test",
            branchName: "pourkit/42/test-issue",
            baseBranch: "main",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedStages: { builder: false },
            review: { lifetimeIterations: 0 },
          });
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "fetch") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (
          command === "git" &&
          args[0] === "diff" &&
          args[1] === "--name-only"
        ) {
          return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
        }
        if (command === "git" && args[0] === "status") {
          return { code: 0, stdout: "?? changed-file.ts\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      const config = makeConfig();
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const executionProvider = new FakeExecutionProvider({
        success: true,
        branch: "pourkit/42/test-issue",
        worktreePath,
        commits: ["fix: implement feature"],
        logPath: null,
      });

      await runIssueCommand({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        logger: makeLogger(),
        repoRoot: tmpRepoRoot,
      });

      const builderCall = executionProvider.calls.find(
        (call) => call.stage === "builder"
      );
      expect(builderCall).toBeDefined();
      expect(builderCall!.branchName).toBe("pourkit/42/test-issue");
      expect(builderCall!.repoRoot).toBe(tmpRepoRoot);
      expect(builderCall!.worktreePath).toContain(".sandcastle/worktrees");
    });

    it("Base Refresh checked-out base branch regression", async () => {
      const worktreePath = join(
        tmpRepoRoot,
        ".sandcastle",
        "worktrees",
        "pourkit-42-test-issue"
      );
      mkdirSync(worktreePath, { recursive: true });
      writeWorktreeRunState(worktreePath, {
        issueNumber: 42,
        targetName: "test",
        branchName: "pourkit/42/test-issue",
        baseBranch: "main",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        completedStages: { builder: true },
        review: { lifetimeIterations: 0 },
      });

      execCaptureMock.mockImplementation(async (command, args, options) => {
        const opts = options as { cwd?: string } | undefined;
        const isWorktreeOp = opts?.cwd === worktreePath;

        if (command === "git" && args[0] === "worktree" && args[1] === "list") {
          return {
            code: 0,
            stdout: [
              `worktree ${worktreePath}`,
              "HEAD abc123",
              "branch refs/heads/pourkit/42/test-issue",
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        if (command === "git" && args[0] === "fetch") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[1] === "--is-ancestor"
        ) {
          throw new Error("not ancestor");
        }
        if (command === "git" && args[0] === "rebase" && isWorktreeOp) {
          return {
            code: 0,
            stdout: "Successfully rebased.\n",
            stderr: "",
          };
        }
        if (command === "git" && args[0] === "diff") {
          return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      const config = makeConfig();
      const issueProvider = new FakeIssueProvider([
        makeIssue({ labels: ["ready-for-agent"] }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();

      await startIssueRun({
        issueNumber: 42,
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: true,
        logger,
        repoRoot: tmpRepoRoot,
      });

      expect(execCaptureMock).toHaveBeenCalledWith(
        "git",
        ["merge-base", "--is-ancestor", "origin/main", "HEAD"],
        expect.anything()
      );
      expect(execCaptureMock).toHaveBeenCalledWith(
        "git",
        ["rebase", "--autostash", "origin/main"],
        expect.anything()
      );
      expect(execCaptureMock).not.toHaveBeenCalledWith(
        "git",
        ["branch", "--force", "main", "origin/main"],
        expect.anything()
      );
    });
  });
});
