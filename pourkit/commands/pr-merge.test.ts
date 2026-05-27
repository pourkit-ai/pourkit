import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parsePrMergeArgs,
  runPrMergeCommand,
  validatePrMergeOptions,
  type PrMergeProvider,
} from "./pr-merge";
import type { PourkitConfig } from "../shared/config";

const { runMergeCoordinatorMock, createLoggerMock } = vi.hoisted(() => ({
  runMergeCoordinatorMock: vi.fn().mockResolvedValue({
    stage: "completed",
    merged: true,
  }),
  createLoggerMock: vi.fn().mockReturnValue({
    step: vi.fn(),
    line: vi.fn(),
    raw: vi.fn(),
    status: vi.fn(),
    kv: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../issues/merge-coordinator", () => ({
  runMergeCoordinator: runMergeCoordinatorMock,
}));

vi.mock("../shared/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/common")>();
  return {
    ...actual,
    createLogger: createLoggerMock,
  };
});

const config: PourkitConfig = {
  targets: [
    {
      name: "default",
      baseBranch: "main",
      branchTemplate: "pourkit/{{issue.number}}/{{issue.slug}}",
      strategy: {
        type: "review-refactor-loop",
        implement: {
          builder: { agent: "build", model: "test", promptTemplate: "test.md" },
        },
        review: {
          reviewer: {
            agent: "review",
            model: "test",
            promptTemplate: "test.md",
            criteria: ["correctness"],
          },
          refactor: {
            agent: "refactor",
            model: "test",
            promptTemplate: "test.md",
          },
          maxIterations: 3,
          passWithNotesRefactorAttempts: 2,
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
    pollIntervalSeconds: 15,
    issueListLimit: 50,
  },
  cleanup: {
    enabled: true,
    worktreeRetentionDays: 14,
    logRetentionDays: 30,
  },
};

function makeProvider(
  overrides: Partial<PrMergeProvider> = {}
): PrMergeProvider {
  return {
    createPr: vi.fn(),
    getPr: vi.fn(),
    getPrByNumber: vi.fn(async () => ({
      number: 99,
      nodeId: "PR_node99",
      url: "https://github.com/test/repo/pull/99",
      title: "feat: test",
      body: "",
      headRefName: "feature/test",
      baseRefName: "main",
      state: "OPEN" as const,
      headRefOid: "abc123",
    })),
    getCheckStatus: vi.fn(),
    mergePr: vi.fn(async () => undefined),
    enableAutoMerge: vi.fn(async () => undefined),
    waitForPrChecks: vi.fn(async () => []),
    getBranchStatus: vi.fn(async () => ({
      headSha: "abc123",
      state: "green" as const,
      checks: [],
    })),
    ...overrides,
  };
}

describe("parsePrMergeArgs", () => {
  it("parses defaults", () => {
    const { options, remaining } = parsePrMergeArgs(["99"]);

    expect(options).toEqual({
      prNumber: 99,
      target: undefined,
      method: "squash",
      wait: true,
      targetGreen: true,
    });
    expect(remaining).toEqual([]);
  });

  it("parses optional flags", () => {
    const { options } = parsePrMergeArgs([
      "99",
      "--target",
      "default",
      "--method",
      "merge",
      "--no-wait",
      "--no-target-green",
    ]);

    expect(options).toMatchObject({
      target: "default",
      method: "merge",
      wait: false,
      targetGreen: false,
    });
  });

  it("rejects invalid merge methods", () => {
    expect(() => parsePrMergeArgs(["99", "--method", "fast-forward"])).toThrow(
      "Invalid merge method: fast-forward"
    );
  });
});

describe("validatePrMergeOptions", () => {
  it("passes valid options", () => {
    expect(() =>
      validatePrMergeOptions({
        prNumber: 99,
        method: "squash",
        wait: true,
        targetGreen: true,
      })
    ).not.toThrow();
  });

  it("rejects blank target", () => {
    expect(() =>
      validatePrMergeOptions({
        prNumber: 99,
        target: " ",
        method: "squash",
        wait: true,
        targetGreen: true,
      })
    ).toThrow("--target must be a non-empty string");
  });
});

describe("runPrMergeCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runMergeCoordinatorMock.mockResolvedValue({
      stage: "completed",
      merged: true,
    });
  });

  it("waits for checks and merges through the merge coordinator", async () => {
    const provider = makeProvider();

    const result = await runPrMergeCommand(
      ["99", "--target", "default", "--method", "merge"],
      undefined,
      provider,
      config
    );

    expect(result.merged).toBe(true);
    expect(runMergeCoordinatorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prProvider: provider,
        prNumber: 99,
        targetBranch: "main",
        matchHeadCommit: "abc123",
        method: "merge",
        waitForTargetGreen: true,
      })
    );
  });

  it("merges immediately when --no-wait is used", async () => {
    const provider = makeProvider();

    await runPrMergeCommand(
      ["99", "--no-wait", "--method", "rebase"],
      undefined,
      provider,
      config
    );

    expect(provider.mergePr).toHaveBeenCalledWith(99, {
      method: "rebase",
      matchHeadCommit: "abc123",
    });
    expect(runMergeCoordinatorMock).not.toHaveBeenCalled();
  });

  it("rejects target mismatch", async () => {
    const provider = makeProvider({
      getPrByNumber: vi.fn(async () => ({
        number: 99,
        nodeId: "PR_node99",
        url: "https://github.com/test/repo/pull/99",
        title: "feat: test",
        body: "",
        headRefName: "feature/test",
        baseRefName: "next",
        state: "OPEN" as const,
        headRefOid: "abc123",
      })),
    });

    await expect(
      runPrMergeCommand(
        ["99", "--target", "default"],
        undefined,
        provider,
        config
      )
    ).rejects.toThrow("targets next, not main");
  });

  it("rejects missing provider", async () => {
    await expect(
      runPrMergeCommand(["99"], undefined, undefined, config)
    ).rejects.toThrow("PR provider is required to merge a pull request");
  });
});
