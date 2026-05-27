import { describe, expect, it, vi, beforeEach } from "vitest";
import { runPrWorkflow } from "./pr-workflow";
import type { Target } from "../shared/config";
import type { PourkitLogger } from "../shared/common";
import type { PRProvider, PullRequest } from "../providers/pr-provider";

const { runPrPolicyMock, validatePrHeadMock } = vi.hoisted(() => ({
  runPrPolicyMock: vi.fn().mockResolvedValue({
    baseBranch: "next",
    currentBranch: "agent/test-feature",
    root: "/fake/root",
  }),
  validatePrHeadMock: vi.fn(),
}));

vi.mock("./pr-policy", () => ({
  runPrPolicy: runPrPolicyMock,
  validatePrHead: validatePrHeadMock,
}));

vi.mock("../shared/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/common")>();
  return {
    ...actual,
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

function makeFakeProvider(): {
  provider: PRProvider;
  createPr: ReturnType<typeof vi.fn>;
} {
  const createPr = vi.fn().mockResolvedValue({
    number: 99,
    nodeId: "PR_99",
    url: "https://github.com/test/repo/pull/99",
    title: "feat: test",
    body: "body",
    headRefName: "agent/test-feature",
    baseRefName: "next",
    state: "OPEN",
    headRefOid: "abc123",
  } satisfies PullRequest);

  return {
    provider: { createPr } as unknown as PRProvider,
    createPr,
  };
}

describe("runPrWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validatePrHeadMock.mockImplementation(() => undefined);
  });

  it("does not call verification before creating the PR", async () => {
    const { provider, createPr } = makeFakeProvider();
    const target = makeTarget({
      setupCommands: [{ label: "lint", command: "npm run lint" }],
    });
    expect(target).not.toHaveProperty("verificationCommands");

    await runPrWorkflow({
      target,
      logger: makeLogger(),
      title: "feat: test",
      body: "body",
      prProvider: provider,
      repoRoot: "/fake-root",
    });

    expect(validatePrHeadMock).toHaveBeenCalledWith(
      "agent/test-feature",
      "next"
    );
    expect(createPr).toHaveBeenCalled();
  });

  it("forwards explicit head to policy", async () => {
    const { provider } = makeFakeProvider();

    await runPrWorkflow({
      target: makeTarget(),
      logger: makeLogger(),
      title: "feat: test",
      body: "body",
      explicitHead: "agent/explicit-head",
      prProvider: provider,
      repoRoot: "/fake-root",
    });

    expect(runPrPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({ explicitHead: "agent/explicit-head" })
    );
  });

  it("creates PR without verification dependency", async () => {
    const { provider, createPr } = makeFakeProvider();

    const result = await runPrWorkflow({
      target: makeTarget(),
      logger: makeLogger(),
      title: "feat: test",
      body: "body",
      prProvider: provider,
      repoRoot: "/fake-root",
    });

    expect(result.prNumber).toBe(99);
    expect(createPr).toHaveBeenCalled();
  });

  it("creates a PR with assembled title, body, head, and base", async () => {
    const { provider, createPr } = makeFakeProvider();

    const result = await runPrWorkflow({
      target: makeTarget(),
      logger: makeLogger(),
      title: "feat: add cool feature",
      body: "Closes #42\n\nThis is the body",
      prProvider: provider,
      repoRoot: "/fake-root",
    });

    expect(createPr).toHaveBeenCalledWith({
      title: "feat: add cool feature",
      body: "Closes #42\n\nThis is the body",
      head: "agent/test-feature",
      base: "next",
    });
  });

  it("returns prNumber and prUrl from the created PR", async () => {
    const { provider } = makeFakeProvider();

    const result = await runPrWorkflow({
      target: makeTarget(),
      logger: makeLogger(),
      title: "feat: test",
      body: "body",
      prProvider: provider,
      repoRoot: "/fake-root",
    });

    expect(result.prNumber).toBe(99);
    expect(result.prUrl).toBe("https://github.com/test/repo/pull/99");
  });

  it("includes policy result fields in the return value", async () => {
    const { provider } = makeFakeProvider();

    const result = await runPrWorkflow({
      target: makeTarget(),
      logger: makeLogger(),
      title: "feat: test",
      body: "body",
      prProvider: provider,
      repoRoot: "/fake-root",
    });

    expect(result.baseBranch).toBe("next");
    expect(result.currentBranch).toBe("agent/test-feature");
    expect(result.root).toBe("/fake/root");
  });
});
