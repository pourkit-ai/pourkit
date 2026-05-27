import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitForBranchChecks } from "./target-green";
import type { PRProvider, BranchStatus } from "../providers/pr-provider";

const { sleepMock } = vi.hoisted(() => ({
  sleepMock: vi.fn(async () => undefined),
}));

vi.mock("../shared/common", () => ({
  sleep: sleepMock,
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

function makePrProvider(responses: BranchStatus[]): PRProvider {
  let callCount = 0;
  return {
    createPr: vi.fn(),
    getPr: vi.fn(),
    getCheckStatus: vi.fn(),
    waitForPrChecks: vi.fn(),
    mergePr: vi.fn(),
    enableAutoMerge: vi.fn(),
    getBranchStatus: vi.fn(async () => {
      const response = responses[callCount] ?? responses[responses.length - 1];
      callCount++;
      return response;
    }),
  };
}

describe("waitForBranchChecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves when branch is already green", async () => {
    const prProvider = makePrProvider([
      { headSha: "abc123", state: "green", checks: [] },
    ]);
    const logger = makeLogger();

    await expect(
      waitForBranchChecks(prProvider, logger, {
        branchName: "main",
        checksCompletionTimeoutMs: 5000,
        pollIntervalMs: 0,
      })
    ).resolves.toBeUndefined();

    expect(logger.step).toHaveBeenCalledWith("success", expect.any(String));
  });

  it("waits for a green head to stay stable before resolving", async () => {
    const prProvider = makePrProvider([
      { headSha: "aaa111", state: "green", checks: [] },
      { headSha: "bbb222", state: "pending", checks: [] },
      { headSha: "bbb222", state: "green", checks: [] },
    ]);
    const logger = makeLogger();
    const nowValues = [0, 0, 0, 10, 10, 110, 110];
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => nowValues.shift() ?? 110);

    try {
      await expect(
        waitForBranchChecks(prProvider, logger, {
          branchName: "next",
          checksCompletionTimeoutMs: 1000,
          pollIntervalMs: 0,
          stableHeadMs: 100,
        })
      ).resolves.toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }

    expect(logger.step).toHaveBeenCalledWith("success", expect.any(String));
  });

  it("waits and resolves when branch becomes green", async () => {
    const prProvider = makePrProvider([
      { headSha: "abc123", state: "pending", checks: [] },
      { headSha: "abc123", state: "green", checks: [] },
    ]);
    const logger = makeLogger();

    await expect(
      waitForBranchChecks(prProvider, logger, {
        branchName: "main",
        checksCompletionTimeoutMs: 5000,
        pollIntervalMs: 0,
      })
    ).resolves.toBeUndefined();

    expect(logger.step).toHaveBeenCalledWith("success", expect.any(String));
  });

  it("throws when branch becomes red", async () => {
    const prProvider = makePrProvider([
      {
        headSha: "abc123",
        state: "pending",
        checks: [{ name: "test", conclusion: null, status: "IN_PROGRESS" }],
      },
      {
        headSha: "def456",
        state: "red",
        checks: [{ name: "test", conclusion: "FAILURE", status: "COMPLETED" }],
      },
    ]);
    const logger = makeLogger();

    await expect(
      waitForBranchChecks(prProvider, logger, {
        branchName: "main",
        checksCompletionTimeoutMs: 5000,
        pollIntervalMs: 0,
      })
    ).rejects.toThrow("Target branch main is red");
  });

  it("detects head changes during wait", async () => {
    const prProvider = makePrProvider([
      { headSha: "aaa111", state: "pending", checks: [] },
      { headSha: "bbb222", state: "pending", checks: [] },
      { headSha: "ccc333", state: "green", checks: [] },
    ]);
    const logger = makeLogger();

    await expect(
      waitForBranchChecks(prProvider, logger, {
        branchName: "main",
        checksCompletionTimeoutMs: 5000,
        pollIntervalMs: 0,
      })
    ).resolves.toBeUndefined();

    expect(logger.step).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("branch head changed")
    );
  });

  it("handles multiple head changes (semantic-release scenario)", async () => {
    const prProvider = makePrProvider([
      { headSha: "v1.0.0", state: "pending", checks: [] },
      { headSha: "v1.0.1", state: "pending", checks: [] },
      { headSha: "v1.0.2", state: "pending", checks: [] },
      { headSha: "v1.1.0", state: "green", checks: [] },
    ]);
    const logger = makeLogger();

    await expect(
      waitForBranchChecks(prProvider, logger, {
        branchName: "next",
        checksCompletionTimeoutMs: 10000,
        pollIntervalMs: 0,
      })
    ).resolves.toBeUndefined();

    expect(logger.step).toHaveBeenCalledWith("success", expect.any(String));
  });

  it("resolves when branch has no checks before timeout", async () => {
    const prProvider = makePrProvider([
      { headSha: "abc123", state: "pending", checks: [] },
      { headSha: "abc123", state: "pending", checks: [] },
      { headSha: "abc123", state: "pending", checks: [] },
    ]);
    const logger = makeLogger();
    const nowValues = [0, 10, 60];
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => nowValues.shift() ?? 60);

    try {
      await expect(
        waitForBranchChecks(prProvider, logger, {
          branchName: "main",
          checksFoundTimeoutMs: 50,
          pollIntervalMs: 0,
        })
      ).resolves.toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }

    expect(logger.step).toHaveBeenCalledWith(
      "success",
      expect.stringContaining("has no checks")
    );
  });

  it("throws timeout when branch never becomes green", async () => {
    const prProvider = makePrProvider([
      {
        headSha: "abc123",
        state: "pending",
        checks: [{ name: "test", conclusion: null, status: "IN_PROGRESS" }],
      },
      {
        headSha: "abc123",
        state: "pending",
        checks: [{ name: "test", conclusion: null, status: "IN_PROGRESS" }],
      },
      {
        headSha: "abc123",
        state: "pending",
        checks: [{ name: "test", conclusion: null, status: "IN_PROGRESS" }],
      },
    ]);
    const logger = makeLogger();
    const nowValues = [0, 10, 60];
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => nowValues.shift() ?? 60);

    try {
      await expect(
        waitForBranchChecks(prProvider, logger, {
          branchName: "main",
          checksCompletionTimeoutMs: 50,
          pollIntervalMs: 0,
        })
      ).rejects.toThrow("Timeout waiting for main to be green");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("throws timeout with moving head", async () => {
    const prProvider = makePrProvider([
      {
        headSha: "aaa111",
        state: "pending",
        checks: [{ name: "test", conclusion: null, status: "IN_PROGRESS" }],
      },
      {
        headSha: "bbb222",
        state: "pending",
        checks: [{ name: "test", conclusion: null, status: "IN_PROGRESS" }],
      },
      {
        headSha: "ccc333",
        state: "pending",
        checks: [{ name: "test", conclusion: null, status: "IN_PROGRESS" }],
      },
      {
        headSha: "ddd444",
        state: "pending",
        checks: [{ name: "test", conclusion: null, status: "IN_PROGRESS" }],
      },
      {
        headSha: "eee555",
        state: "pending",
        checks: [{ name: "test", conclusion: null, status: "IN_PROGRESS" }],
      },
    ]);
    const logger = makeLogger();
    const nowValues = [0, 10, 20, 30, 40, 120];
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => nowValues.shift() ?? 120);

    try {
      await expect(
        waitForBranchChecks(prProvider, logger, {
          branchName: "main",
          checksFoundTimeoutMs: 50,
          checksCompletionTimeoutMs: 50,
          pollIntervalMs: 0,
          stableHeadMs: 100,
        })
      ).rejects.toThrow("Timeout waiting for main to be green");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("throws when branch has failing checks", async () => {
    const prProvider = makePrProvider([
      {
        headSha: "abc123",
        state: "red",
        checks: [
          { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
          { name: "test", conclusion: "FAILURE", status: "COMPLETED" },
          { name: "build", conclusion: "SUCCESS", status: "COMPLETED" },
        ],
      },
    ]);
    const logger = makeLogger();

    await expect(
      waitForBranchChecks(prProvider, logger, {
        branchName: "main",
        checksCompletionTimeoutMs: 5000,
        pollIntervalMs: 0,
      })
    ).rejects.toThrow("test");
  });

  it("throws immediately for cancelled checks on a red branch", async () => {
    const prProvider = makePrProvider([
      {
        headSha: "abc123",
        state: "red",
        checks: [{ name: "test", conclusion: "CANCELLED", status: null }],
      },
    ]);
    const logger = makeLogger();

    await expect(
      waitForBranchChecks(prProvider, logger, {
        branchName: "main",
        checksCompletionTimeoutMs: 5000,
        pollIntervalMs: 0,
      })
    ).rejects.toThrow("test");

    expect(sleepMock).not.toHaveBeenCalled();
  });
});
