import { beforeEach, describe, expect, it, vi } from "vitest";
import { runQueueCommand } from "../commands/queue-run";
import type { PourkitConfig, IssueData } from "../shared/config";
import { FakeIssueProvider } from "../providers/issue-provider";
import type { PRProvider, PullRequest } from "../providers/pr-provider";
import {
  FakeExecutionProvider,
  type ExecutionResult,
} from "../execution/execution-provider";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

const { execCaptureMock, repoRootMock, selectIssueMock } = vi.hoisted(() => ({
  execCaptureMock: vi.fn(),
  repoRootMock: vi.fn(() => "/repo"),
  selectIssueMock: vi.fn(),
}));

vi.mock("../shared/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/common")>();
  return {
    ...actual,
    execCapture: execCaptureMock,
    repoRoot: repoRootMock,
  };
});

vi.mock("../issues/select-issue", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../issues/select-issue")>();
  return {
    ...actual,
    selectIssue: selectIssueMock,
  };
});

const makeConfig = (): PourkitConfig => ({
  targets: [
    {
      name: "test",
      baseBranch: "main",
      branchTemplate: "pourkit/{{issue.number}}/{{issue.slug}}",
      strategy: {
        type: "review-refactor-loop",
        implement: {
          builder: {
            agent: "build",
            model: "test",
            promptTemplate: "test.md",
          },
        },
        review: {
          reviewer: {
            agent: "review",
            model: "test-review",
            promptTemplate: "review.md",
            criteria: ["correctness", "quality"],
          },
          refactor: {
            agent: "refactor",
            model: "test-refactor",
            promptTemplate: "refactor.md",
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
            model: "test-finalizer",
            promptTemplate: "finalizer.md",
          },
          maxAttempts: 2,
        },
      },
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
});

const makeIssue = (
  overrides: Partial<{
    number: number;
    title: string;
    body: string;
    state: "open" | "closed";
    labels: string[];
    createdAt: Date | undefined;
  }> = {}
): IssueData => ({
  number: 42,
  title: "Test issue",
  body: "Test body",
  state: "open" as const,
  labels: [] as string[],
  comments: [],
  createdAt: new Date("2025-01-01T00:00:00Z"),
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

describe("runQueueCommand", () => {
  let executionProvider: FakeExecutionProvider;

  beforeEach(async () => {
    rmSync("/tmp/pourkit-queue-test", { recursive: true, force: true });
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
    const { selectIssue: realSelectIssue } = await vi.importActual<
      typeof import("../issues/select-issue")
    >("../issues/select-issue");
    selectIssueMock.mockImplementation(realSelectIssue);
    executionProvider = new FakeExecutionProvider({
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath:
        "/tmp/pourkit-queue-test/.sandcastle/worktrees/pourkit-42-test-issue",
      commits: ["fix: implement feature"],
      logPath:
        "/tmp/pourkit-queue-test/.pourkit/logs/pourkit-42-test-issue-123.log",
    });
  });

  it("returns empty result when no candidates exist", async () => {
    const config = makeConfig();
    expect(config.targets[0]).not.toHaveProperty("verificationCommands");
    expect(config.targets[0].strategy.verify?.commands[0].label).toBe(
      "typecheck"
    );
    const issueProvider = new FakeIssueProvider([]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome.selected).toBeNull();
    if (outcome.selected === null) {
      expect(outcome.reason).toContain("No candidate issues");
      expect(outcome.code).toBe("no-candidates");
    }
  });

  it("returns empty result when all candidates are blocked", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ number: 1, labels: ["ready-for-agent", "blocked"] }),
      makeIssue({ number: 2, labels: ["ready-for-agent", "blocked"] }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome.selected).toBeNull();
    if (outcome.selected === null) {
      expect(outcome.reason).toContain("blocked");
      expect(outcome.code).toBe("no-runnable");
    }
  });

  it("returns empty result when all candidates have invalid type labels", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ number: 1, labels: ["ready-for-agent"] }),
      makeIssue({
        number: 2,
        labels: ["ready-for-agent", "type:bugfix", "type:infra"],
      }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome.selected).toBeNull();
    if (outcome.selected === null) {
      expect(outcome.reason).toMatch(/No runnable/i);
      expect(outcome.code).toBe("no-runnable");
    }
  });

  it("selects from full candidate list when prdRef is not provided (unscoped regression)", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 1,
        title: "PRD-024 / I-01: Feature under PRD-024",
        body: "## Parent\n\nPRD-024",
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-02-01T00:00:00Z"),
      }),
      makeIssue({
        number: 2,
        title: "PRD-021 / I-02: Feature under PRD-021",
        body: "## Parent\n\nPRD-021",
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2024-12-01T00:00:00Z"),
      }),
      makeIssue({
        number: 3,
        title: "PRD-021 / I-03: Newer feature under PRD-021",
        body: "## Parent\n\nPRD-021",
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome.selected).not.toBeNull();
    if (outcome.selected !== null) {
      expect(outcome.selected.number).toBe(2);
    }
  });

  it("selects only from child issues matching prdRef", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 10,
        title: "PRD-024 / I-01: High priority under PRD-024",
        body: "## Parent\n\nPRD-024",
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2024-01-01T00:00:00Z"),
      }),
      makeIssue({
        number: 21,
        title: "PRD-021 / I-02: Feature under PRD-021",
        body: "## Parent\n\nPRD-021",
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
      makeIssue({
        number: 22,
        title: "PRD-021 / I-03: Newer feature under PRD-021",
        body: "## Parent\n\nPRD-021",
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-03-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
      prdRef: "PRD-021",
    });

    expect(outcome.selected).not.toBeNull();
    if (outcome.selected !== null) {
      expect(outcome.selected.number).toBe(21);
    }
  });

  it("honors title fallback when body has no ## Parent section", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 3,
        title: "PRD-021 / I-03: Title-only parent reference",
        body: "Just a regular body with no parent section",
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
      prdRef: "PRD-021",
    });

    expect(outcome.selected).not.toBeNull();
    if (outcome.selected !== null) {
      expect(outcome.selected.number).toBe(3);
    }
  });

  it("excludes candidate when body parent conflicts with title parent", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 24,
        title: "PRD-021 / I-01: Title says PRD-021",
        body: "## Parent\n\nPRD-024",
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
      makeIssue({
        number: 5,
        title: "PRD-021 / I-02: Valid PRD-021 child",
        body: "## Parent\n\nPRD-021",
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-02-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
      prdRef: "PRD-021",
    });

    expect(outcome.selected).not.toBeNull();
    if (outcome.selected !== null) {
      expect(outcome.selected.number).not.toBe(24);
      expect(outcome.selected.number).toBe(5);
    }
  });

  it("returns empty result when no candidates match the scoped PRD", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 1,
        title: "PRD-024 / I-01: Under different PRD",
        body: "## Parent\n\nPRD-024",
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
      makeIssue({
        number: 2,
        title: "PRD-024 / I-02: Also under different PRD",
        body: "## Parent\n\nPRD-024",
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-02-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
      prdRef: "PRD-021",
    });

    expect(outcome).toMatchObject({
      selected: null,
      code: "no-candidates",
      reason: "No candidate issues found for PRD-021.",
    });
  });

  it("selects highest priority oldest issue and runs it", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 10,
        title: "Feature issue",
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
      makeIssue({
        number: 20,
        title: "Infra issue (older)",
        labels: ["ready-for-agent", "type:infra"],
        createdAt: new Date("2024-06-01T00:00:00Z"),
      }),
      makeIssue({
        number: 30,
        title: "Infra issue (newer)",
        labels: ["ready-for-agent", "type:infra"],
        createdAt: new Date("2025-03-01T00:00:00Z"),
      }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome.selected).not.toBeNull();
    if (outcome.selected !== null) {
      expect(outcome.selected.number).toBe(20);
      expect(outcome.runResult.prNumber).toBe(7);
    }
  });

  it("delegates to single-issue runner preserving PR and label behavior", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 55,
        labels: ["ready-for-agent", "type:bugfix"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome.selected).not.toBeNull();
    if (outcome.selected !== null) {
      expect(outcome.selected.number).toBe(55);
      expect(outcome.runResult.prNumber).toBe(7);
      expect(outcome.runResult.prUrl).toBe(
        "https://github.com/test/repo/pull/7"
      );
    }

    const builderCall = executionProvider.calls.find(
      (c) => c.stage === "builder"
    );
    expect(builderCall?.repoRoot).toBe("/fake-root");

    const updatedIssue = await issueProvider.fetchIssue(55);
    expect(updatedIssue.labels).not.toContain("pr-open-awaiting-merge");
    expect(updatedIssue.labels).not.toContain("ready-for-agent");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
  });

  it("propagates errors from single-issue runner", async () => {
    executionProvider.result = {
      success: false,
      branch: "",
      worktreePath: "",
      commits: [],
      logPath: null,
      error: "sandcastle exploded",
    };

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 99,
        labels: ["ready-for-agent", "type:polish"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    await expect(
      runQueueCommand({
        config,
        issueProvider,
        prProvider: makePrProvider(),
        executionProvider,
        force: false,
        loop: false,
        logger,
        repoRoot: "/fake-root",
      })
    ).rejects.toThrow("Sandcastle failed: sandcastle exploded");

    const updatedIssue = await issueProvider.fetchIssue(99);
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");
  });

  it("passes force flag through to single-issue runner", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 77,
        labels: ["ready-for-agent", "type:refactor"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: true,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome.selected).not.toBeNull();
    if (outcome.selected !== null) {
      expect(outcome.selected.number).toBe(77);
      expect(outcome.runResult.prNumber).toBe(7);
    }
  });

  it("throws when selected issue number is not in candidate list", async () => {
    selectIssueMock.mockReturnValue({
      ok: true,
      issue: { number: 9999, title: "phantom", labels: [], createdAt: "" },
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 1,
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    await expect(
      runQueueCommand({
        config,
        issueProvider,
        prProvider: makePrProvider(),
        executionProvider,
        force: false,
        loop: false,
        logger,
        repoRoot: "/fake-root",
      })
    ).rejects.toThrow("Selected issue #9999 not found in candidate list");
  });

  it("handles candidates with missing createdAt by using epoch fallback", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 12,
        title: "Issue without createdAt",
        labels: ["ready-for-agent", "type:bugfix"],
        createdAt: undefined,
      }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome.selected).not.toBeNull();
    if (outcome.selected !== null) {
      expect(outcome.selected.number).toBe(12);
    }
  });

  it("logs step and raw messages during successful queue run", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 5,
        title: "Logged issue",
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(logger.step).toHaveBeenCalledWith(
      "info",
      "Loading candidate issues from provider"
    );
    expect(logger.step).toHaveBeenCalledWith(
      "info",
      "Selected issue #5: Logged issue"
    );
    expect(logger.raw).toHaveBeenCalledWith(
      expect.stringContaining("1 candidate")
    );
    expect(logger.raw).toHaveBeenCalledWith(
      expect.stringContaining("#5: Logged issue")
    );
  });

  it("logs warning when no candidates exist", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome.selected).toBeNull();
    expect("code" in outcome && outcome.code).toBe("no-candidates");
    expect(logger.step).toHaveBeenCalledWith(
      "warn",
      "No candidate issues found"
    );
  });

  it("logs warning when no runnable issue exists", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ number: 1, labels: ["ready-for-agent"] }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome.selected).toBeNull();
    expect("code" in outcome && outcome.code).toBe("no-runnable");
    expect(logger.step).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("No runnable issue")
    );
  });

  it("passes targetName through to single-issue runner", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 33,
        labels: ["ready-for-agent", "type:refactor"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      targetName: "test",
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome.selected).not.toBeNull();
    if (outcome.selected !== null) {
      expect(outcome.selected.number).toBe(33);
      expect(outcome.runResult.target.name).toBe("test");
    }
  });

  it("filters out closed issues from candidate list", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 1,
        title: "Open issue",
        state: "open",
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
      makeIssue({
        number: 2,
        title: "Closed issue",
        state: "closed",
        labels: ["ready-for-agent", "type:bugfix"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome.selected).not.toBeNull();
    if (outcome.selected !== null) {
      expect(outcome.selected.number).toBe(1);
    }
  });

  it("selects valid issue from mixed blocked and invalid candidates", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 1,
        labels: ["ready-for-agent", "blocked", "type:bugfix"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
      makeIssue({
        number: 2,
        labels: ["ready-for-agent", "type:feature", "type:infra"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
      makeIssue({
        number: 3,
        labels: ["ready-for-agent", "type:polish"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome.selected).not.toBeNull();
    if (outcome.selected !== null) {
      expect(outcome.selected.number).toBe(3);
    }
  });

  it("logs completion details after successful run", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 8,
        title: "Completion test",
        labels: ["ready-for-agent", "type:infra"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(logger.raw).toHaveBeenCalledWith("Issue completed successfully:");
    expect(logger.raw).toHaveBeenCalledWith(
      expect.stringContaining("Branch: pourkit/8/completion-test")
    );
    expect(logger.raw).toHaveBeenCalledWith(
      expect.stringContaining("PR Number: 7")
    );
    expect(logger.raw).toHaveBeenCalledWith(
      expect.stringContaining("PR URL: https://github.com/test/repo/pull/7")
    );
  });

  it("delegates through reviewer pipeline and creates PR on PASS verdict", async () => {
    vi.mocked(repoRootMock).mockReturnValue("/tmp/pourkit-queue-test");
    const TEST_DIR = "/tmp/pourkit-queue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${TEST_DIR}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${TEST_DIR}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const artifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/reviewers/iteration-1.md`;

    const reviewResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${TEST_DIR}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: [],
      logPath: null,
    };

    const config: PourkitConfig = {
      ...makeConfig(),
      targets: [
        {
          ...makeConfig().targets[0],
          strategy: {
            ...makeConfig().targets[0].strategy,
            review: {
              ...makeConfig().targets[0].strategy.review,
              reviewer: {
                agent: "review",
                model: "test-review",
                promptTemplate: "review.md",
                criteria: ["correctness", "quality"],
              },
              maxIterations: 3,
            },
          },
        },
      ],
    };

    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 42,
        title: "Review pipeline test",
        labels: ["ready-for-agent", "type:bugfix"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
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
          const finalizerPath = join(
            opts.worktreePath ?? builderResult.worktreePath,
            opts.artifactPath ?? ".pourkit/.tmp/finalizer/agent-output.md"
          );
          mkdirSync(join(finalizerPath, ".."), { recursive: true });
          writeFileSync(
            finalizerPath,
            "## PR Title\n\nfix: Test issue\n\n## PR Body\n\n## Summary\n\n- Why this PR exists.\n\n## Changes\n\n- Change made.\n\nCloses #42",
            "utf-8"
          );
          return reviewResult;
        }
        mkdirSync(join(artifactPath, ".."), { recursive: true });
        writeFileSync(
          artifactPath,
          [
            "## Findings",
            "",
            "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
            "|----|------------|----------|-----------|-------|----------------|",
            "| none | n/a | n/a | n/a | No findings. | n/a |",
            "",
            "<verdict>PASS</verdict>",
          ].join("\n"),
          "utf-8"
        );
        return reviewResult;
      },
    };

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider,
      executionProvider: multiExecutionProvider as any,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome.selected).not.toBeNull();
    if (outcome.selected !== null && "runResult" in outcome) {
      expect(outcome.selected.number).toBe(42);
      expect(outcome.runResult.prNumber).toBe(7);
    }

    expect(prProvider.createPr).toHaveBeenCalledWith({
      title: "fix: Test issue",
      body: "## Summary\n\n- Why this PR exists.\n\n## Changes\n\n- Change made.\n\nCloses #42",
      head: "pourkit/42/review-pipeline-test",
      base: "main",
    });

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).not.toContain("pr-open-awaiting-merge");
    expect(updatedIssue.labels).not.toContain("ready-for-agent");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");

    await rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("logs generated PR title when finalizer stage runs", async () => {
    vi.mocked(repoRootMock).mockReturnValue("/tmp/pourkit-queue-test");
    const TEST_DIR = "/tmp/pourkit-queue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${TEST_DIR}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${TEST_DIR}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const artifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/reviewers/iteration-1.md`;
    const prDescArtifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/finalizer/agent-output.md`;

    const config: PourkitConfig = {
      ...makeConfig(),
      targets: [
        {
          ...makeConfig().targets[0],
          strategy: {
            ...makeConfig().targets[0].strategy,
            review: {
              ...makeConfig().targets[0].strategy.review,
              reviewer: {
                agent: "review",
                model: "test-review",
                promptTemplate: "review.md",
                criteria: ["correctness", "quality"],
              },
              maxIterations: 3,
            },
            finalize: {
              ...makeConfig().targets[0].strategy.finalize,
              prDescriptionAgent: {
                agent: "pr-desc",
                model: "test-pr-desc",
                promptTemplate: "finalizer.prompt.md",
              },
            },
          },
        },
      ],
    };

    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 42,
        title: "Review pipeline test",
        labels: ["ready-for-agent", "type:bugfix"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    let callCount = 0;
    const multiExecutionProvider = {
      async execute() {
        callCount++;
        if (callCount === 1) {
          return builderResult;
        }
        if (callCount === 2) {
          mkdirSync(join(artifactPath, ".."), { recursive: true });
          writeFileSync(
            artifactPath,
            [
              "## Findings",
              "",
              "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
              "|----|------------|----------|-----------|-------|----------------|",
              "| none | n/a | n/a | n/a | No findings. | n/a |",
              "",
              "<verdict>PASS</verdict>",
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
        mkdirSync(join(prDescArtifactPath, ".."), { recursive: true });
        writeFileSync(
          prDescArtifactPath,
          "## PR Title\n\nQueue-run Generated Title\n\n## PR Body\n\n## Summary\n\n- Queue-run summary.\n\n## Changes\n\n- Queue-run change.\n\nCloses #42",
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

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider,
      executionProvider: multiExecutionProvider as any,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome.selected).not.toBeNull();
    if (outcome.selected !== null) {
      expect(outcome.selected.number).toBe(42);
      expect(outcome.runResult.prNumber).toBe(7);
    }

    expect(prProvider.createPr).toHaveBeenCalledWith({
      title: "chore: Queue-run Generated Title",
      body: "## Summary\n\n- Queue-run summary.\n\n## Changes\n\n- Queue-run change.\n\nCloses #42",
      head: "pourkit/42/review-pipeline-test",
      base: "main",
    });
    expect(logger.raw).toHaveBeenCalledWith(
      expect.stringContaining("PR Title: chore: Queue-run Generated Title")
    );
    expect("runResult" in outcome && outcome.runResult.prBody).toBe(
      "## Summary\n\n- Queue-run summary.\n\n## Changes\n\n- Queue-run change.\n\nCloses #42"
    );

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).not.toContain("pr-open-awaiting-merge");
    expect(updatedIssue.labels).not.toContain("ready-for-agent");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");

    await rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("does not create PR when queue-run finalizer execution fails", async () => {
    vi.mocked(repoRootMock).mockReturnValue("/tmp/pourkit-queue-test");
    const TEST_DIR = "/tmp/pourkit-queue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${TEST_DIR}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${TEST_DIR}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const reviewArtifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/reviewers/iteration-1.md`;

    const config: PourkitConfig = {
      ...makeConfig(),
      targets: [
        {
          ...makeConfig().targets[0],
          strategy: {
            ...makeConfig().targets[0].strategy,
            review: {
              ...makeConfig().targets[0].strategy.review,
              reviewer: {
                agent: "review",
                model: "test-review",
                promptTemplate: "review.md",
                criteria: ["correctness", "quality"],
              },
              maxIterations: 3,
            },
            finalize: {
              ...makeConfig().targets[0].strategy.finalize,
              prDescriptionAgent: {
                agent: "pr-desc",
                model: "test-pr-desc",
                promptTemplate: "finalizer.prompt.md",
              },
            },
          },
        },
      ],
    };

    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 42,
        title: "Review pipeline test",
        labels: ["ready-for-agent", "type:bugfix"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    let callCount = 0;
    const multiExecutionProvider = {
      async execute() {
        callCount++;
        if (callCount === 1) {
          return builderResult;
        }
        if (callCount === 2) {
          mkdirSync(join(reviewArtifactPath, ".."), { recursive: true });
          writeFileSync(
            reviewArtifactPath,
            [
              "## Findings",
              "",
              "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
              "|----|------------|----------|-----------|-------|----------------|",
              "| none | n/a | n/a | n/a | No findings. | n/a |",
              "",
              "<verdict>PASS</verdict>",
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
      runQueueCommand({
        config,
        issueProvider,
        prProvider,
        executionProvider: multiExecutionProvider as any,
        force: false,
        loop: false,
        logger,
        repoRoot: "/fake-root",
      })
    ).rejects.toThrow(
      "Finalizer agent execution failed: finalizer agent crashed"
    );

    expect(prProvider.createPr).not.toHaveBeenCalled();

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");

    await rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("does not create PR when queue-run finalizer hits protocol failure", async () => {
    vi.mocked(repoRootMock).mockReturnValue("/tmp/pourkit-queue-test");
    const TEST_DIR = "/tmp/pourkit-queue-test";
    const builderResult: ExecutionResult = {
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: `${TEST_DIR}/.sandcastle/worktrees/pourkit-42-test-issue`,
      commits: ["fix: implement feature"],
      logPath: `${TEST_DIR}/.pourkit/logs/pourkit-42-test-issue-123.log`,
    };

    const reviewArtifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/reviewers/iteration-1.md`;
    const prDescArtifactPath = `${builderResult.worktreePath}/.pourkit/.tmp/finalizer/agent-output.md`;

    const config: PourkitConfig = {
      ...makeConfig(),
      targets: [
        {
          ...makeConfig().targets[0],
          strategy: {
            ...makeConfig().targets[0].strategy,
            review: {
              ...makeConfig().targets[0].strategy.review,
              reviewer: {
                agent: "review",
                model: "test-review",
                promptTemplate: "review.md",
                criteria: ["correctness", "quality"],
              },
              maxIterations: 3,
            },
            finalize: {
              ...makeConfig().targets[0].strategy.finalize,
              prDescriptionAgent: {
                agent: "pr-desc",
                model: "test-pr-desc",
                promptTemplate: "finalizer.prompt.md",
              },
            },
          },
        },
      ],
    };

    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 42,
        title: "Review pipeline test",
        labels: ["ready-for-agent", "type:bugfix"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    const prProvider = makePrProvider();
    const logger = makeLogger();

    let callCount = 0;
    const multiExecutionProvider = {
      async execute() {
        callCount++;
        if (callCount === 1) {
          return builderResult;
        }
        if (callCount === 2) {
          mkdirSync(join(reviewArtifactPath, ".."), { recursive: true });
          writeFileSync(
            reviewArtifactPath,
            [
              "## Findings",
              "",
              "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
              "|----|------------|----------|-----------|-------|----------------|",
              "| none | n/a | n/a | n/a | No findings. | n/a |",
              "",
              "<verdict>PASS</verdict>",
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
      runQueueCommand({
        config,
        issueProvider,
        prProvider,
        executionProvider: multiExecutionProvider as any,
        force: false,
        loop: false,
        logger,
        repoRoot: "/fake-root",
      })
    ).rejects.toThrow("Finalizer protocol error");

    expect(prProvider.createPr).not.toHaveBeenCalled();

    const updatedIssue = await issueProvider.fetchIssue(42);
    expect(updatedIssue.labels).toContain("ready-for-human");
    expect(updatedIssue.labels).not.toContain("agent-in-progress");

    await rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("merged-and-green flow", () => {
    it("completes queue-run success after merge + target-green", async () => {
      vi.mocked(repoRootMock).mockReturnValue("/tmp/pourkit-queue-test");
      const TEST_DIR = "/tmp/pourkit-queue-test";
      const builderResult: ExecutionResult = {
        success: true,
        branch: "pourkit/42/test-issue",
        worktreePath: `${TEST_DIR}/.sandcastle/worktrees/pourkit-42-test-issue`,
        commits: ["fix: implement feature"],
        logPath: `${TEST_DIR}/.pourkit/logs/pourkit-42-test-issue-123.log`,
      };

      const config = makeConfig();
      const issueProvider = new FakeIssueProvider([
        makeIssue({
          number: 42,
          title: "Queue-run merged-and-green test",
          labels: ["ready-for-agent", "type:bugfix"],
          createdAt: new Date("2025-01-01T00:00:00Z"),
        }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();

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

      const outcome = await runQueueCommand({
        config,
        issueProvider,
        prProvider,
        executionProvider,
        force: false,
        loop: false,
        logger,
        repoRoot: "/fake-root",
      });

      expect(outcome.selected).not.toBeNull();
      if (outcome.selected !== null && "runResult" in outcome) {
        expect(outcome.selected.number).toBe(42);
        expect(outcome.runResult.prNumber).toBe(7);
      }

      expect(prProvider.mergePr).toHaveBeenCalledWith(7, {
        method: "squash",
        matchHeadCommit: "abc123",
      });
      expect(prProvider.enableAutoMerge).not.toHaveBeenCalled();
      expect(prProvider.getBranchStatus).toHaveBeenCalled();

      const updatedIssue = await issueProvider.fetchIssue(42);
      expect(updatedIssue.labels).not.toContain("pr-open-awaiting-merge");
      expect(updatedIssue.labels).not.toContain("ready-for-agent");
      expect(updatedIssue.labels).not.toContain("agent-in-progress");
      expect(updatedIssue.state).toBe("closed");
    });

    it("fails queue-run when merge fails", async () => {
      vi.mocked(repoRootMock).mockReturnValue("/tmp/pourkit-queue-test");
      const TEST_DIR = "/tmp/pourkit-queue-test";
      const builderResult: ExecutionResult = {
        success: true,
        branch: "pourkit/42/test-issue",
        worktreePath: `${TEST_DIR}/.sandcastle/worktrees/pourkit-42-test-issue`,
        commits: ["fix: implement feature"],
        logPath: `${TEST_DIR}/.pourkit/logs/pourkit-42-test-issue-123.log`,
      };

      const config = makeConfig();
      const issueProvider = new FakeIssueProvider([
        makeIssue({
          number: 42,
          title: "Queue-run merge failure test",
          labels: ["ready-for-agent", "type:bugfix"],
          createdAt: new Date("2025-01-01T00:00:00Z"),
        }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();

      vi.mocked(prProvider.mergePr).mockRejectedValue(
        new Error("merge blocked")
      );

      await expect(
        runQueueCommand({
          config,
          issueProvider,
          prProvider,
          executionProvider,
          force: false,
          loop: false,
          logger,
          repoRoot: "/fake-root",
        })
      ).rejects.toThrow("merge blocked");

      const updatedIssue = await issueProvider.fetchIssue(42);
      expect(updatedIssue.labels).toContain("ready-for-human");
      expect(updatedIssue.labels).not.toContain("agent-in-progress");
    });

    it("fails queue-run when waitForPrChecks fails before auto-merge", async () => {
      vi.mocked(repoRootMock).mockReturnValue("/tmp/pourkit-queue-test");
      const TEST_DIR = "/tmp/pourkit-queue-test";
      const builderResult: ExecutionResult = {
        success: true,
        branch: "pourkit/42/test-issue",
        worktreePath: `${TEST_DIR}/.sandcastle/worktrees/pourkit-42-test-issue`,
        commits: ["fix: implement feature"],
        logPath: `${TEST_DIR}/.pourkit/logs/pourkit-42-test-issue-123.log`,
      };

      const config = makeConfig();
      const issueProvider = new FakeIssueProvider([
        makeIssue({
          number: 42,
          title: "Queue-run checks failure test",
          labels: ["ready-for-agent", "type:bugfix"],
          createdAt: new Date("2025-01-01T00:00:00Z"),
        }),
      ]);
      const prProvider = makePrProvider();
      const logger = makeLogger();

      vi.mocked(prProvider.waitForPrChecks).mockRejectedValue(
        new Error("checks failed")
      );

      await expect(
        runQueueCommand({
          config,
          issueProvider,
          prProvider,
          executionProvider,
          force: false,
          loop: false,
          logger,
          repoRoot: "/fake-root",
        })
      ).rejects.toThrow("checks failed");

      const updatedIssue = await issueProvider.fetchIssue(42);
      expect(updatedIssue.labels).toContain("ready-for-human");
      expect(updatedIssue.labels).not.toContain("agent-in-progress");
    });
  });

  it("processes multiple runnable issues sequentially when loop is true", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 1,
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
      makeIssue({
        number: 2,
        labels: ["ready-for-agent", "type:bugfix"],
        createdAt: new Date("2025-02-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: true,
      logger,
      repoRoot: "/fake-root",
    });

    const builderCalls = executionProvider.calls.filter(
      (c) => c.stage === "builder"
    );
    expect(builderCalls).toHaveLength(2);
    expect(outcome).toMatchObject({
      drained: true,
      processedCount: 2,
    });
  });

  it("returns drained when all candidates are blocked in loop mode", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({ number: 1, labels: ["ready-for-agent", "blocked"] }),
      makeIssue({ number: 2, labels: ["ready-for-agent", "blocked"] }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: true,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome).toMatchObject({
      drained: true,
      processedCount: 0,
    });
  });

  it("returns drained with processedCount 0 when loop mode has no candidates", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: true,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome).toMatchObject({
      drained: true,
      processedCount: 0,
    });
    const builderCalls = executionProvider.calls.filter(
      (c) => c.stage === "builder"
    );
    expect(builderCalls).toHaveLength(0);
  });

  it("reconciles blocked issues after successful close and processes newly unblocked issue in same loop run", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 1,
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
      makeIssue({
        number: 2,
        body: "## Blocked by\n- #1",
        labels: ["blocked", "type:feature"],
        createdAt: new Date("2025-02-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: true,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome).toMatchObject({ drained: true, processedCount: 2 });

    const builderCalls = executionProvider.calls.filter(
      (c) => c.stage === "builder"
    );
    expect(builderCalls).toHaveLength(2);

    const updatedIssue2 = await issueProvider.fetchIssue(2);
    expect(updatedIssue2.labels).not.toContain("blocked");
  });

  it("does not reconcile blocked issues after autoMerge:false issue in loop mode", async () => {
    const config = makeConfig();
    config.targets[0].autoMerge = false;
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 1,
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
      makeIssue({
        number: 2,
        body: "## Blocked by\n- #1",
        labels: ["blocked", "type:feature"],
        createdAt: new Date("2025-02-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: true,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome).toMatchObject({ drained: true, processedCount: 1 });

    const updatedIssue2 = await issueProvider.fetchIssue(2);
    expect(updatedIssue2.labels).toContain("blocked");
  });

  it("reconciles blocked issues before selection in loop mode and processes unblocked issue", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 1,
        body: "## Blocked by\n- #100",
        labels: ["blocked", "type:feature"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
      makeIssue({
        number: 100,
        body: "",
        state: "closed",
        labels: [],
      }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: true,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome).toMatchObject({ drained: true, processedCount: 1 });

    const updatedIssue = await issueProvider.fetchIssue(1);
    expect(updatedIssue.labels).not.toContain("blocked");
  });

  it("moves blocked issue without ready-for-agent to needs-triage in loop mode without aborting", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 1,
        body: "Some body without a blocked-by section",
        labels: ["blocked"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: true,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome).toMatchObject({
      drained: true,
      processedCount: 0,
    });

    const updatedIssue = await issueProvider.fetchIssue(1);
    expect(updatedIssue.labels).not.toContain("blocked");
    expect(updatedIssue.labels).not.toContain("ready-for-agent");
    expect(updatedIssue.labels).toContain("needs-triage");
  });

  it("uses configured needs-triage label in loop-mode reconciliation", async () => {
    const config = makeConfig();
    config.labels.needsTriage = "needs-triage-custom";
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 1,
        body: "Some body without a blocked-by section",
        labels: ["blocked"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: true,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome).toMatchObject({
      drained: true,
      processedCount: 0,
    });

    const updatedIssue = await issueProvider.fetchIssue(1);
    expect(updatedIssue.labels).not.toContain("blocked");
    expect(updatedIssue.labels).not.toContain("ready-for-agent");
    expect(updatedIssue.labels).not.toContain("needs-triage");
    expect(updatedIssue.labels).toContain("needs-triage-custom");
  });

  it("unblocks issue with custom ready-for-agent label after blocker closes", async () => {
    const config = makeConfig();
    config.labels.readyForAgent = "r4a-custom";
    const issueProvider = new FakeIssueProvider(
      [
        makeIssue({
          number: 1,
          labels: ["r4a-custom", "type:feature"],
          createdAt: new Date("2025-01-01T00:00:00Z"),
        }),
        makeIssue({
          number: 2,
          body: "## Blocked by\n- #1",
          labels: ["blocked", "type:feature"],
          createdAt: new Date("2025-02-01T00:00:00Z"),
        }),
      ],
      { readyForAgentLabel: "r4a-custom" }
    );
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: true,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome).toMatchObject({ drained: true, processedCount: 2 });

    const updatedIssue2 = await issueProvider.fetchIssue(2);
    expect(updatedIssue2.labels).not.toContain("blocked");
    expect(updatedIssue2.labels).not.toContain("ready-for-agent");
  });

  it("does not reconcile blocked issues in one-pass mode", async () => {
    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 1,
        labels: ["ready-for-agent", "blocked", "type:bugfix"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
      makeIssue({
        number: 2,
        labels: ["ready-for-agent", "type:polish"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    const listBlockedIssuesSpy = vi.spyOn(issueProvider, "listBlockedIssues");
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(listBlockedIssuesSpy).not.toHaveBeenCalled();
    expect(outcome.selected).not.toBeNull();
    if (outcome.selected !== null) {
      expect(outcome.selected.number).toBe(2);
    }
  });

  it("fails fast when an issue throws in loop mode", async () => {
    executionProvider.result = {
      success: false,
      branch: "",
      worktreePath: "",
      commits: [],
      logPath: null,
      error: "merge blocked",
    };

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 1,
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
      makeIssue({
        number: 2,
        labels: ["ready-for-agent", "type:bugfix"],
        createdAt: new Date("2025-02-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    await expect(
      runQueueCommand({
        config,
        issueProvider,
        prProvider: makePrProvider(),
        executionProvider,
        force: false,
        loop: true,
        logger,
        repoRoot: "/fake-root",
      })
    ).rejects.toThrow("Sandcastle failed: merge blocked");

    const builderCalls = executionProvider.calls.filter(
      (c) => c.stage === "builder"
    );
    expect(builderCalls).toHaveLength(1);
  });

  it("continues loop after a no-op issue", async () => {
    let callIndex = 0;
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "show-ref") {
        throw new Error("branch not found");
      }
      if (
        command === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        callIndex++;
        if (callIndex <= 1) {
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "changed-file.ts\n", stderr: "" };
      }
      if (command === "git" && args[0] === "status") {
        if (callIndex <= 1) {
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "?? new-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 1,
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
      makeIssue({
        number: 2,
        labels: ["ready-for-agent", "type:bugfix"],
        createdAt: new Date("2025-02-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: true,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome.selected).toBeNull();
    expect("code" in outcome && outcome.code).toBe("drained");
    expect("processedCount" in outcome && outcome.processedCount).toBe(2);

    const issue1 = await issueProvider.fetchIssue(1);
    expect(issue1.state).toBe("closed");
    const issue2 = await issueProvider.fetchIssue(2);
    expect(issue2.state).toBe("closed");
  });

  it("returns success for a no-op issue in non-loop mode", async () => {
    execCaptureMock.mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "show-ref") {
        throw new Error("branch not found");
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

    const config = makeConfig();
    const issueProvider = new FakeIssueProvider([
      makeIssue({
        number: 1,
        labels: ["ready-for-agent", "type:feature"],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: false,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome.selected).not.toBeNull();
    if (outcome.selected !== null) {
      expect(outcome.selected.number).toBe(1);
      expect(outcome.runResult.noOp).toBe(true);
      expect(outcome.runResult.prNumber).toBeUndefined();
    }

    const issue = await issueProvider.fetchIssue(1);
    expect(issue.state).toBe("closed");
  });

  it("uses config-provided label names when reconciling blocked issues in loop mode", async () => {
    const config = makeConfig();
    config.labels.blocked = "custom-blocked";
    config.labels.readyForAgent = "custom-ready";
    config.labels.needsTriage = "custom-needs-triage";
    const issueProvider = new FakeIssueProvider(
      [
        makeIssue({
          number: 1,
          body: "## Blocked by\n- #100",
          labels: ["custom-blocked", "type:feature"],
          createdAt: new Date("2025-01-01T00:00:00Z"),
        }),
        makeIssue({
          number: 100,
          body: "",
          state: "closed",
          labels: [],
        }),
      ],
      { blockedLabel: "custom-blocked", readyForAgentLabel: "custom-ready" }
    );
    const addLabelsSpy = vi.spyOn(issueProvider, "addLabels");
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: true,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome).toMatchObject({
      drained: true,
      processedCount: 1,
    });

    expect(addLabelsSpy).toHaveBeenCalledWith(1, ["custom-ready"]);

    const updatedIssue = await issueProvider.fetchIssue(1);
    expect(updatedIssue.labels).not.toContain("custom-blocked");
  });

  it("uses config-provided label names for malformed blocked issues in loop mode", async () => {
    const config = makeConfig();
    config.labels.blocked = "custom-blocked";
    config.labels.readyForAgent = "custom-ready";
    config.labels.needsTriage = "custom-needs-triage";
    const issueProvider = new FakeIssueProvider(
      [
        makeIssue({
          number: 1,
          body: "No blocked by section here",
          labels: ["custom-blocked"],
          createdAt: new Date("2025-01-01T00:00:00Z"),
        }),
      ],
      { blockedLabel: "custom-blocked", readyForAgentLabel: "custom-ready" }
    );
    const addLabelsSpy = vi.spyOn(issueProvider, "addLabels");
    const logger = makeLogger();

    const outcome = await runQueueCommand({
      config,
      issueProvider,
      prProvider: makePrProvider(),
      executionProvider,
      force: false,
      loop: true,
      logger,
      repoRoot: "/fake-root",
    });

    expect(outcome).toMatchObject({
      drained: true,
      processedCount: 0,
    });

    expect(addLabelsSpy).toHaveBeenCalledWith(1, ["custom-needs-triage"]);

    const updatedIssue = await issueProvider.fetchIssue(1);
    expect(updatedIssue.labels).toContain("custom-needs-triage");
    expect(updatedIssue.labels).not.toContain("custom-blocked");
  });
});
