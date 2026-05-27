import { beforeEach, describe, expect, it, vi } from "vitest";
import { runMergeCoordinator } from "./merge-coordinator";
import type { BranchStatus, PRProvider } from "../providers/pr-provider";

vi.mock("../shared/common", () => ({
  sleep: vi.fn(async () => undefined),
}));

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

describe("runMergeCoordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves after calling waitForPrChecks, mergePr, and getBranchStatus in order", async () => {
    const calls: string[] = [];
    const prProvider: PRProvider = {
      createPr: vi.fn(),
      getPr: vi.fn(),
      getCheckStatus: vi.fn(),
      mergePr: vi.fn(async () => {
        calls.push("mergePr");
      }),
      enableAutoMerge: vi.fn(),
      waitForPrChecks: vi.fn(async () => {
        calls.push("waitForPrChecks");
        return [];
      }),
      getBranchStatus: vi.fn(async () => {
        calls.push("getBranchStatus");
        const result: BranchStatus = {
          headSha: "abc123",
          state: "green",
          checks: [],
        };
        return result;
      }),
    };
    const logger = makeLogger();

    const result = await runMergeCoordinator({
      prProvider,
      logger,
      prNumber: 7,
      targetBranch: "main",
      matchHeadCommit: "abc123",
      checkWaitOptions: {
        checksFoundTimeoutMs: 1000,
        checksCompletionTimeoutMs: 5000,
        pollIntervalMs: 0,
      },
    });

    expect(result).toEqual({ stage: "completed", merged: true });
    expect(calls).toEqual(["waitForPrChecks", "mergePr", "getBranchStatus"]);
  });

  it("resolves with completed stage discriminator on success", async () => {
    const prProvider: PRProvider = {
      createPr: vi.fn(),
      getPr: vi.fn(),
      getCheckStatus: vi.fn(),
      mergePr: vi.fn(async () => undefined),
      enableAutoMerge: vi.fn(),
      waitForPrChecks: vi.fn(async () => []),
      getBranchStatus: vi.fn(async () => {
        const result: BranchStatus = {
          headSha: "abc123",
          state: "green",
          checks: [],
        };
        return result;
      }),
    };

    const result = await runMergeCoordinator({
      prProvider,
      logger: makeLogger(),
      prNumber: 7,
      targetBranch: "main",
      matchHeadCommit: "abc123",
      checkWaitOptions: {
        checksFoundTimeoutMs: 1000,
        checksCompletionTimeoutMs: 5000,
        pollIntervalMs: 0,
      },
    });

    expect(result.stage).toBe("completed");
    if (result.stage === "completed") {
      expect(result.merged).toBe(true);
    }
  });

  it("returns merge-stage outcome when mergePr fails", async () => {
    const prProvider: PRProvider = {
      createPr: vi.fn(),
      getPr: vi.fn(),
      getCheckStatus: vi.fn(),
      mergePr: vi.fn(async () => {
        throw new Error("merge blocked");
      }),
      enableAutoMerge: vi.fn(),
      waitForPrChecks: vi.fn(async () => []),
      getBranchStatus: vi.fn(
        async (): Promise<BranchStatus> => ({
          headSha: "abc123",
          state: "green",
          checks: [],
        })
      ),
    };

    const result = await runMergeCoordinator({
      prProvider,
      logger: makeLogger(),
      prNumber: 7,
      targetBranch: "main",
      matchHeadCommit: "abc123",
      checkWaitOptions: {
        checksFoundTimeoutMs: 1000,
        checksCompletionTimeoutMs: 5000,
        pollIntervalMs: 0,
      },
    });

    expect(result).toMatchObject({
      stage: "merge",
      merged: false,
    });
  });

  it("returns merge-stage outcome when waitForPrChecks fails before merge", async () => {
    const prProvider: PRProvider = {
      createPr: vi.fn(),
      getPr: vi.fn(),
      getCheckStatus: vi.fn(),
      mergePr: vi.fn(async () => undefined),
      enableAutoMerge: vi.fn(),
      waitForPrChecks: vi.fn(async () => {
        throw new Error("checks failed");
      }),
      getBranchStatus: vi.fn(
        async (): Promise<BranchStatus> => ({
          headSha: "abc123",
          state: "green",
          checks: [],
        })
      ),
    };

    const result = await runMergeCoordinator({
      prProvider,
      logger: makeLogger(),
      prNumber: 7,
      targetBranch: "main",
      matchHeadCommit: "abc123",
      checkWaitOptions: {
        checksFoundTimeoutMs: 1000,
        checksCompletionTimeoutMs: 5000,
        pollIntervalMs: 0,
      },
    });

    expect(result).toMatchObject({
      stage: "merge",
      merged: false,
    });
  });

  it("returns target-green outcome when waitForBranchChecks fails after merge", async () => {
    const prProvider: PRProvider = {
      createPr: vi.fn(),
      getPr: vi.fn(),
      getCheckStatus: vi.fn(),
      mergePr: vi.fn(async () => undefined),
      enableAutoMerge: vi.fn(),
      waitForPrChecks: vi.fn(async () => []),
      getBranchStatus: vi.fn(async () => {
        throw new Error("target branch did not settle");
      }),
    };

    const result = await runMergeCoordinator({
      prProvider,
      logger: makeLogger(),
      prNumber: 7,
      targetBranch: "main",
      matchHeadCommit: "abc123",
      checkWaitOptions: {
        checksFoundTimeoutMs: 1000,
        checksCompletionTimeoutMs: 100,
        pollIntervalMs: 0,
      },
    });

    expect(result).toMatchObject({
      stage: "target-green",
      merged: true,
    });
  });

  it("directly merges after checks when autoMerge is true", async () => {
    const prProvider: PRProvider = {
      createPr: vi.fn(),
      getPr: vi.fn(),
      getCheckStatus: vi.fn(),
      mergePr: vi.fn(async () => undefined),
      enableAutoMerge: vi.fn(async () => undefined),
      waitForPrChecks: vi.fn(async () => []),
      getBranchStatus: vi.fn(async () => {
        const result: BranchStatus = {
          headSha: "abc123",
          state: "green",
          checks: [],
        };
        return result;
      }),
    };

    const pr = {
      number: 7,
      nodeId: "PR_node123",
      url: "https://github.com/owner/repo/pull/7",
      title: "Test PR",
      body: "",
      headRefName: "feature/test",
      baseRefName: "main",
      state: "OPEN" as const,
      headRefOid: "abc123",
    };

    const result = await runMergeCoordinator({
      prProvider,
      logger: makeLogger(),
      prNumber: 7,
      targetBranch: "main",
      matchHeadCommit: "abc123",
      checkWaitOptions: {
        checksFoundTimeoutMs: 1000,
        checksCompletionTimeoutMs: 5000,
        pollIntervalMs: 0,
      },
      autoMerge: true,
      pr,
    });

    expect(result).toEqual({ stage: "completed", merged: true });
    expect(prProvider.mergePr).toHaveBeenCalledWith(7, {
      method: "squash",
      matchHeadCommit: "abc123",
    });
    expect(prProvider.enableAutoMerge).not.toHaveBeenCalled();
  });

  it("uses the requested merge method", async () => {
    const prProvider: PRProvider = {
      createPr: vi.fn(),
      getPr: vi.fn(),
      getCheckStatus: vi.fn(),
      mergePr: vi.fn(async () => undefined),
      enableAutoMerge: vi.fn(async () => undefined),
      waitForPrChecks: vi.fn(async () => []),
      getBranchStatus: vi.fn(async () => ({
        headSha: "abc123",
        state: "green" as const,
        checks: [],
      })),
    };

    await runMergeCoordinator({
      prProvider,
      logger: makeLogger(),
      prNumber: 7,
      targetBranch: "main",
      matchHeadCommit: "abc123",
      method: "merge",
      checkWaitOptions: {
        checksFoundTimeoutMs: 1000,
        checksCompletionTimeoutMs: 5000,
        pollIntervalMs: 0,
      },
    });

    expect(prProvider.mergePr).toHaveBeenCalledWith(7, {
      method: "merge",
      matchHeadCommit: "abc123",
    });
  });

  it("skips target green waiting when requested", async () => {
    const prProvider: PRProvider = {
      createPr: vi.fn(),
      getPr: vi.fn(),
      getCheckStatus: vi.fn(),
      mergePr: vi.fn(async () => undefined),
      enableAutoMerge: vi.fn(async () => undefined),
      waitForPrChecks: vi.fn(async () => []),
      getBranchStatus: vi.fn(),
    };

    const result = await runMergeCoordinator({
      prProvider,
      logger: makeLogger(),
      prNumber: 7,
      targetBranch: "main",
      matchHeadCommit: "abc123",
      waitForTargetGreen: false,
      checkWaitOptions: {
        checksFoundTimeoutMs: 1000,
        checksCompletionTimeoutMs: 5000,
        pollIntervalMs: 0,
      },
    });

    expect(result).toEqual({ stage: "completed", merged: true });
    expect(prProvider.getBranchStatus).not.toHaveBeenCalled();
  });

  it("returns merge-stage outcome when direct auto merge fails", async () => {
    const prProvider: PRProvider = {
      createPr: vi.fn(),
      getPr: vi.fn(),
      getCheckStatus: vi.fn(),
      mergePr: vi.fn(async () => {
        throw new Error("auto-merge rejected");
      }),
      enableAutoMerge: vi.fn(async () => undefined),
      waitForPrChecks: vi.fn(async () => []),
      getBranchStatus: vi.fn(),
    };

    const pr = {
      number: 7,
      nodeId: "PR_node123",
      url: "https://github.com/owner/repo/pull/7",
      title: "Test PR",
      body: "",
      headRefName: "feature/test",
      baseRefName: "main",
      state: "OPEN" as const,
      headRefOid: "abc123",
    };

    const result = await runMergeCoordinator({
      prProvider,
      logger: makeLogger(),
      prNumber: 7,
      targetBranch: "main",
      matchHeadCommit: "abc123",
      checkWaitOptions: {
        checksFoundTimeoutMs: 1000,
        checksCompletionTimeoutMs: 5000,
        pollIntervalMs: 0,
      },
      autoMerge: true,
      pr,
    });

    expect(result).toMatchObject({
      stage: "merge",
      merged: false,
    });
    expect(prProvider.enableAutoMerge).not.toHaveBeenCalled();
  });
});
