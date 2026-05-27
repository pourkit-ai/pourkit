import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  inferBaseBranch,
  getCurrentBranch,
  validatePrHead,
  runPrPolicy,
} from "./pr-policy";
import type { Target } from "../shared/config";
import type { PourkitLogger } from "../shared/common";

const { execCaptureMock } = vi.hoisted(() => ({
  execCaptureMock: vi.fn(),
}));

vi.mock("../shared/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/common")>();
  return {
    ...actual,
    execCapture: execCaptureMock,
    repoRoot: () => "/fake/root",
  };
});

const makeTarget = (overrides: Partial<Target> = {}): Target => ({
  name: "test",
  baseBranch: "next",
  branchTemplate: "pourkit/{{issue.number}}/{{issue.slug}}",
  strategy: {
    type: "review-refactor-loop" as const,
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
      refactor: { agent: "refactor", model: "test", promptTemplate: "test.md" },
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
  ...overrides,
});

const makeLogger = (): PourkitLogger =>
  ({
    step: vi.fn(),
    line: vi.fn(),
    kv: vi.fn(),
  }) as unknown as PourkitLogger;

describe("inferBaseBranch", () => {
  it("returns explicit base when provided", async () => {
    const target = makeTarget();
    expect(target).not.toHaveProperty("verificationCommands");
    const result = await inferBaseBranch("develop", target);
    expect(result).toBe("develop");
  });

  it("falls back to target baseBranch when explicit base is undefined", async () => {
    const result = await inferBaseBranch(undefined, makeTarget());
    expect(result).toBe("next");
  });

  it("normalizes 'main' to 'next' when explicit base is 'main'", async () => {
    const result = await inferBaseBranch("main", makeTarget());
    expect(result).toBe("next");
  });

  it("normalizes 'main' to 'next' when falling back to target baseBranch", async () => {
    const result = await inferBaseBranch(
      undefined,
      makeTarget({ baseBranch: "main" })
    );
    expect(result).toBe("next");
  });
});

describe("getCurrentBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns branch name from git output", async () => {
    execCaptureMock.mockResolvedValue({
      code: 0,
      stdout: "feature/test\n",
      stderr: "",
    });

    const result = await getCurrentBranch("/fake/root");
    expect(result).toBe("feature/test");
  });

  it("throws on detached HEAD", async () => {
    execCaptureMock.mockResolvedValue({
      code: 0,
      stdout: "HEAD\n",
      stderr: "",
    });

    await expect(getCurrentBranch("/fake/root")).rejects.toThrow(
      "Cannot determine current branch"
    );
  });

  it("throws on empty branch name", async () => {
    execCaptureMock.mockResolvedValue({ code: 0, stdout: "\n", stderr: "" });

    await expect(getCurrentBranch("/fake/root")).rejects.toThrow(
      "Cannot determine current branch"
    );
  });
});

describe("validatePrHead", () => {
  it("rejects disposable E2E target branches for normal bases", () => {
    expect(() => validatePrHead("pourkit-e2e-target/run-123", "next")).toThrow(
      "Refusing to create PR from disposable E2E target branch"
    );
    expect(() => validatePrHead("pourkit-e2e-target/run-123", "master")).toThrow(
      "Refusing to create PR from disposable E2E target branch"
    );
  });

  it("rejects disposable E2E agent branches for normal bases", () => {
    expect(() =>
      validatePrHead("pourkit/123/e2e-test-issue-456", "next")
    ).toThrow("Refusing to create PR from disposable E2E agent branch");
    expect(() =>
      validatePrHead("pourkit/123/e2e-test-issue-456", "master")
    ).toThrow("Refusing to create PR from disposable E2E agent branch");
  });

  it("allows disposable E2E agent branches targeting E2E branches", () => {
    expect(() =>
      validatePrHead(
        "pourkit/123/e2e-test-issue-456",
        "pourkit-e2e-target/run-123"
      )
    ).not.toThrow();
  });

  it("allows normal topic branches", () => {
    expect(() => validatePrHead("agent/foo", "next")).not.toThrow();
  });
});

describe("runPrPolicy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execCaptureMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  });

  it("uses explicit head without checking the current branch", async () => {
    execCaptureMock.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    const logger = makeLogger();

    const result = await runPrPolicy({
      target: makeTarget(),
      explicitHead: "agent/explicit-head",
      logger,
      repoRoot: "/fake-root",
    });

    expect(result.currentBranch).toBe("agent/explicit-head");
    expect(execCaptureMock).toHaveBeenCalledTimes(1);
    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["ls-remote", "--exit-code", "--heads", "origin", "agent/explicit-head"],
      { cwd: "/fake-root" }
    );
  });

  it("throws when explicit head matches the base branch", async () => {
    await expect(
      runPrPolicy({
        target: makeTarget({ baseBranch: "develop" }),
        explicitHead: "develop",
        logger: makeLogger(),
        repoRoot: "/fake-root",
      })
    ).rejects.toThrow("cannot match base branch");

    expect(execCaptureMock).not.toHaveBeenCalled();
  });

  it("throws when explicit head is blank", async () => {
    await expect(
      runPrPolicy({
        target: makeTarget(),
        explicitHead: "   ",
        logger: makeLogger(),
        repoRoot: "/fake-root",
      })
    ).rejects.toThrow("must be a non-empty string");

    expect(execCaptureMock).not.toHaveBeenCalled();
  });

  it("throws when explicit head is missing on origin", async () => {
    execCaptureMock.mockRejectedValue(new Error("not found"));

    await expect(
      runPrPolicy({
        target: makeTarget(),
        explicitHead: "agent/missing",
        logger: makeLogger(),
        repoRoot: "/fake-root",
      })
    ).rejects.toThrow("must exist on origin");

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["ls-remote", "--exit-code", "--heads", "origin", "agent/missing"],
      { cwd: "/fake-root" }
    );
  });

  it("returns inferred base and current branch", async () => {
    execCaptureMock.mockResolvedValue({
      code: 0,
      stdout: "agent/test-feature\n",
      stderr: "",
    });

    const logger = makeLogger();
    const result = await runPrPolicy({
      target: makeTarget(),
      explicitBase: undefined,
      logger,
      repoRoot: "/fake-root",
    });

    expect(result.baseBranch).toBe("next");
    expect(result.currentBranch).toBe("agent/test-feature");
    expect(result.root).toBe("/fake-root");
  });

  it("normalizes explicit base 'main' to 'next'", async () => {
    execCaptureMock.mockResolvedValue({
      code: 0,
      stdout: "agent/test-feature\n",
      stderr: "",
    });

    const result = await runPrPolicy({
      target: makeTarget(),
      explicitBase: "main",
      logger: makeLogger(),
      repoRoot: "/fake-root",
    });

    expect(result.baseBranch).toBe("next");
  });
});
