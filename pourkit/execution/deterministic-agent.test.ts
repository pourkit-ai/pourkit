import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sandcastleMocks = vi.hoisted(() => ({
  runMock: vi.fn(),
  createWorktreeMock: vi.fn(),
  dockerMock: vi.fn(() => ({ name: "docker" })),
  ensureSandboxImageBuiltMock: vi.fn(),
}));

const sandboxConfig = {
  provider: "docker",
  mounts: [
    {
      hostPath: "~/.config/opencode",
      sandboxPath: "/home/agent/.config/opencode",
      readonly: true,
    },
  ],
  env: {
    HOME: "/home/agent",
    XDG_CONFIG_HOME: "/home/agent/.config",
    XDG_STATE_HOME: "/home/agent/.local/state",
  },
};

vi.mock("@ai-hero/sandcastle", () => ({
  run: sandcastleMocks.runMock,
  createWorktree: sandcastleMocks.createWorktreeMock,
}));

vi.mock("@ai-hero/sandcastle/sandboxes/docker", () => ({
  docker: sandcastleMocks.dockerMock,
}));

vi.mock("./sandbox-image-build", () => ({
  ensureSandboxImageBuilt: sandcastleMocks.ensureSandboxImageBuiltMock,
}));

import { DeterministicExecutionProvider } from "./deterministic-agent";

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

function makeOptions() {
  return {
    stage: "reviewer" as const,
    agent: "review",
    model: "test-review",
    prompt: "review this",
    target: {
      name: "test",
      baseBranch: "main",
      branchTemplate: "pourkit/{{issue.number}}/{{issue.slug}}",
      setupCommands: [],
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
    repoRoot: "/repo",
    branchName: "pourkit/42/test-issue",
    worktreePath: "/repo/.sandcastle/worktrees/pourkit-42-test-issue",
    sandbox: sandboxConfig,
    logger: makeLogger(),
  };
}

describe("DeterministicExecutionProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses the provided reviewer worktree path", async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "pourkit-review-"));
    sandcastleMocks.runMock.mockResolvedValue({
      branch: "pourkit/42/test-issue",
      commits: [],
      logFilePath: "/tmp/reviewer.log",
    });

    const opts = makeOptions();
    expect(opts.target).not.toHaveProperty("verificationCommands");
    const provider = new DeterministicExecutionProvider();
    try {
      const result = await provider.execute({
        ...opts,
        worktreePath,
        artifacts: [
          { path: ".pourkit/.tmp/run-context.md", content: "context" },
        ],
      });

      expect(sandcastleMocks.dockerMock).toHaveBeenCalledWith({
        imageName: "sandcastle:repo",
        mounts: sandboxConfig.mounts,
        env: sandboxConfig.env,
      });
      expect(sandcastleMocks.ensureSandboxImageBuiltMock).toHaveBeenCalledWith(
        "/repo",
        { force: undefined }
      );
      expect(sandcastleMocks.createWorktreeMock).not.toHaveBeenCalled();
      expect(sandcastleMocks.runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: worktreePath,
          branchStrategy: { type: "head" },
          prompt: "review this",
        })
      );
      const runCall = sandcastleMocks.runMock.mock.calls[0]?.[0];
      expect(runCall.agent.env).toMatchObject({
        POURKIT_STAGE: "reviewer",
        POURKIT_BRANCH_NAME: "pourkit/42/test-issue",
      });
      expect(
        existsSync(join(worktreePath, ".pourkit/.tmp/run-context.md"))
      ).toBe(true);
      expect(result.success).toBe(true);
      expect(result.worktreePath).toBe(worktreePath);
      expect(result.logPath).toContain(
        "/repo/.pourkit/logs/pourkit-42-test-issue-deterministic-"
      );
      expect(result.logPath).toMatch(/\.log$/);
      expect(sandcastleMocks.runMock.mock.calls[0][0].logging.path).toContain(
        "/repo/.pourkit/logs/pourkit-42-test-issue-deterministic-"
      );
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("allows zero-commit reviewer executions", async () => {
    sandcastleMocks.runMock.mockResolvedValue({
      branch: "pourkit/42/test-issue",
      commits: [],
      logFilePath: "/tmp/reviewer.log",
    });

    const provider = new DeterministicExecutionProvider();
    const result = await provider.execute({
      ...makeOptions(),
      iteration: 1,
      artifactPath: ".pourkit/.tmp/reviewers/iteration-1.md",
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        branch: "pourkit/42/test-issue",
        commits: [],
      })
    );
    const runCall = sandcastleMocks.runMock.mock.calls[0]?.[0];
    expect(runCall.agent.env).toMatchObject({
      POURKIT_STAGE: "reviewer",
      POURKIT_REVIEW_ITERATION: "1",
      POURKIT_ARTIFACT_PATH: ".pourkit/.tmp/reviewers/iteration-1.md",
    });
  });

  it("still rejects zero-commit non-reviewer executions", async () => {
    sandcastleMocks.runMock.mockResolvedValue({
      branch: "pourkit/42/test-issue",
      commits: [],
      logFilePath: "/tmp/builder.log",
    });

    const provider = new DeterministicExecutionProvider();
    const result = await provider.execute({
      ...makeOptions(),
      stage: "builder",
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: "Deterministic agent returned zero commits",
      })
    );
  });

  it("allows zero-commit finalizer executions", async () => {
    sandcastleMocks.runMock.mockResolvedValue({
      branch: "pourkit/42/test-issue",
      commits: [],
      logFilePath: "/tmp/finalizer.log",
    });

    const provider = new DeterministicExecutionProvider();
    const result = await provider.execute({
      ...makeOptions(),
      stage: "finalizer",
      artifactPath: ".pourkit/.tmp/finalizer/agent-output.md",
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        branch: "pourkit/42/test-issue",
        commits: [],
      })
    );
    const runCall = sandcastleMocks.runMock.mock.calls[0]?.[0];
    expect(runCall.agent.env).toMatchObject({
      POURKIT_STAGE: "finalizer",
      POURKIT_ARTIFACT_PATH: ".pourkit/.tmp/finalizer/agent-output.md",
    });
  });

  it("requires commits for refactor executions", async () => {
    sandcastleMocks.runMock.mockResolvedValue({
      branch: "pourkit/42/test-issue",
      commits: [{ sha: "abc123" }],
      logFilePath: "/tmp/refactor.log",
    });

    const provider = new DeterministicExecutionProvider();
    const result = await provider.execute({
      ...makeOptions(),
      stage: "refactor",
      iteration: 1,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        branch: "pourkit/42/test-issue",
        commits: ["abc123"],
      })
    );
    const runCall = sandcastleMocks.runMock.mock.calls[0]?.[0];
    expect(runCall.agent.env).toMatchObject({
      POURKIT_STAGE: "refactor",
      POURKIT_REVIEW_ITERATION: "1",
    });
  });

  it("does not run setup commands on the host for deterministic fresh worktrees", async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "pourkit-setup-"));
    const markerPath = join(worktreePath, ".setup-ran");
    const worktreeRun = vi.fn().mockResolvedValue({
      branch: "pourkit/42/test-issue",
      commits: [{ sha: "abc123" }],
      logFilePath: "/tmp/builder.log",
    });
    sandcastleMocks.createWorktreeMock.mockResolvedValue({
      worktreePath,
      run: worktreeRun,
    });

    const provider = new DeterministicExecutionProvider();
    try {
      const result = await provider.execute({
        ...makeOptions(),
        stage: "builder",
        worktreePath: undefined,
        target: {
          ...makeOptions().target,
          setupCommands: [{ command: "touch .setup-ran", label: "install" }],
        },
      });

      expect(sandcastleMocks.createWorktreeMock).toHaveBeenCalledWith({
        cwd: "/repo",
        branchStrategy: {
          type: "branch",
          branch: "pourkit/42/test-issue",
          baseBranch: "main",
        },
      });
      expect(existsSync(markerPath)).toBe(false);
      expect(worktreeRun).toHaveBeenCalled();
      expect(worktreeRun.mock.calls[0][0].logging.path).toContain(
        "/repo/.pourkit/logs/pourkit-42-test-issue-deterministic-"
      );
      expect(result.logPath).toContain(
        "/repo/.pourkit/logs/pourkit-42-test-issue-deterministic-"
      );
      expect(result.logPath).toMatch(/\.log$/);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("passes configured sandbox mounts unchanged", async () => {
    sandcastleMocks.runMock.mockResolvedValue({
      branch: "pourkit/42/test-issue",
      commits: [],
      logFilePath: "/tmp/reviewer.log",
    });

    const provider = new DeterministicExecutionProvider();
    const result = await provider.execute(makeOptions());

    expect(sandcastleMocks.dockerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mounts: sandboxConfig.mounts,
        imageName: "sandcastle:repo",
        env: sandboxConfig.env,
      })
    );
    expect(result.success).toBe(true);
  });

  it("does not mutate the original sandbox config mounts", async () => {
    sandcastleMocks.runMock.mockResolvedValue({
      branch: "pourkit/42/test-issue",
      commits: [],
      logFilePath: "/tmp/reviewer.log",
    });

    const originalMounts = [
      {
        hostPath: "~/.config/opencode",
        sandboxPath: "/home/agent/.config/opencode",
        readonly: true,
      },
    ];
    const originalMountsCopy = JSON.parse(JSON.stringify(originalMounts));

    const provider = new DeterministicExecutionProvider();
    await provider.execute({
      ...makeOptions(),
      sandbox: {
        provider: "docker",
        mounts: originalMounts,
        env: sandboxConfig.env,
      },
    });

    expect(originalMounts).toEqual(originalMountsCopy);
  });
});
