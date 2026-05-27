import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sandcastleMocks = vi.hoisted(() => ({
  createSandboxFromExistingWorktreeMock: vi.fn(),
  createWorktreeMock: vi.fn(),
  opencodeMock: vi.fn(() => ({ name: "mock-agent" })),
  dockerMock: vi.fn(() => ({ name: "docker" })),
  ensureSandboxImageBuiltMock: vi.fn(),
}));

const sandboxConfig = {
  provider: "docker",
  copyToWorktree: ["node_modules"],
  mounts: [
    {
      hostPath: "~/.local/share/opencode",
      sandboxPath: "/home/agent/.local/share/opencode",
      readonly: false,
    },
  ],
  env: {
    HOME: "/home/agent",
    XDG_CONFIG_HOME: "/home/agent/.config",
    XDG_STATE_HOME: "/home/agent/.local/state",
  },
};

vi.mock("@ai-hero/sandcastle", () => ({
  createWorktree: sandcastleMocks.createWorktreeMock,
  opencode: sandcastleMocks.opencodeMock,
}));

vi.mock("./sandcastle-existing-worktree", () => ({
  createSandboxFromExistingWorktree:
    sandcastleMocks.createSandboxFromExistingWorktreeMock,
}));

vi.mock("@ai-hero/sandcastle/sandboxes/docker", () => ({
  docker: sandcastleMocks.dockerMock,
}));

vi.mock("./sandbox-image-build", () => ({
  ensureSandboxImageBuilt: sandcastleMocks.ensureSandboxImageBuiltMock,
}));

import { SandcastleExecutionProvider } from "./sandcastle-execution";

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

function makeTarget(
  setupCommands: Array<{ command: string; label: string }> = []
) {
  return {
    name: "test",
    baseBranch: "main",
    branchTemplate: "pourkit/{{issue.number}}/{{issue.slug}}",
    setupCommands,
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
  };
}

describe("SandcastleExecutionProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a worktree-backed sandbox and runs setup inside the sandbox", async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "pourkit-setup-"));
    const sandboxRun = vi.fn().mockResolvedValue({
      branch: "pourkit/42/test-issue",
      commits: [{ sha: "abc123" }],
      logFilePath: "/tmp/builder.log",
    });
    const sandboxClose = vi.fn();
    const createSandbox = vi.fn().mockResolvedValue({
      branch: "pourkit/42/test-issue",
      worktreePath,
      run: sandboxRun,
      close: sandboxClose,
    });

    sandcastleMocks.createWorktreeMock.mockResolvedValue({
      branch: "pourkit/42/test-issue",
      worktreePath,
      createSandbox,
    });

    const provider = new SandcastleExecutionProvider();
    try {
      const result = await provider.execute({
        stage: "builder",
        agent: "build",
        model: "test-build",
        prompt: "build this",
        target: makeTarget([
          { command: "npm install", label: "install" },
        ]),
        repoRoot: "/repo",
        branchName: "pourkit/42/test-issue",
        sandbox: sandboxConfig,
        artifacts: [
          { path: ".pourkit/.tmp/run-context.md", content: "context" },
        ],
        logger: makeLogger(),
      });

      expect(sandcastleMocks.createWorktreeMock).toHaveBeenCalledWith({
        cwd: "/repo",
        branchStrategy: {
          type: "branch",
          branch: "pourkit/42/test-issue",
          baseBranch: "main",
        },
        copyToWorktree: ["node_modules"],
      });
      expect(createSandbox).toHaveBeenCalledWith({
        sandbox: { name: "docker" },
        copyToWorktree: ["node_modules"],
        hooks: {
          sandbox: {
            onSandboxReady: [{ command: "npm install" }],
          },
        },
      });
      expect(
        existsSync(join(worktreePath, ".pourkit/.tmp/run-context.md"))
      ).toBe(true);
      expect(sandboxRun).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "build this", name: "builder" })
      );
      expect(sandcastleMocks.opencodeMock).toHaveBeenCalledWith(
        "test-build",
        expect.objectContaining({ agent: "build", env: {} })
      );
      expect(sandboxClose).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.worktreePath).toBe(worktreePath);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("reuses one sandbox across a session", async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "pourkit-session-"));
    const sandboxRun = vi
      .fn()
      .mockResolvedValueOnce({ branch: "pourkit/42/test-issue", commits: [] })
      .mockResolvedValueOnce({ branch: "pourkit/42/test-issue", commits: [] });
    const sandboxClose = vi.fn();
    const createSandbox = vi.fn().mockResolvedValue({
      branch: "pourkit/42/test-issue",
      worktreePath,
      run: sandboxRun,
      close: sandboxClose,
    });

    sandcastleMocks.createWorktreeMock.mockResolvedValue({
      branch: "pourkit/42/test-issue",
      worktreePath,
      createSandbox,
    });

    const provider = new SandcastleExecutionProvider();
    const session = await provider.createSession();
    try {
      await session.execute({
        stage: "builder",
        agent: "build",
        model: "test-build",
        prompt: "build this",
        target: makeTarget(),
        repoRoot: "/repo",
        branchName: "pourkit/42/test-issue",
        sandbox: sandboxConfig,
        logger: makeLogger(),
      });
      await session.execute({
        stage: "reviewer",
        agent: "review",
        model: "test-review",
        prompt: "review this",
        target: makeTarget(),
        repoRoot: "/repo",
        branchName: "pourkit/42/test-issue",
        worktreePath,
        sandbox: sandboxConfig,
        logger: makeLogger(),
      });

      expect(sandcastleMocks.createWorktreeMock).toHaveBeenCalledTimes(1);
      expect(createSandbox).toHaveBeenCalledTimes(1);
      expect(sandboxRun).toHaveBeenCalledTimes(2);
    } finally {
      await session.close();
      rmSync(worktreePath, { recursive: true, force: true });
    }

    expect(sandboxClose).toHaveBeenCalledTimes(1);
  });

  it("creates a sandbox around an existing worktree on resume", async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "pourkit-resume-"));
    const sandboxRun = vi.fn().mockResolvedValue({
      branch: "pourkit/42/test-issue",
      commits: [],
      logFilePath: "/tmp/reviewer.log",
    });
    sandcastleMocks.createSandboxFromExistingWorktreeMock.mockResolvedValue({
      branch: "pourkit/42/test-issue",
      worktreePath,
      run: sandboxRun,
      close: vi.fn(),
    });

    const provider = new SandcastleExecutionProvider();
    try {
      const result = await provider.execute({
        stage: "reviewer",
        agent: "review",
        model: "test-review",
        prompt: "review this",
        target: makeTarget(),
        repoRoot: "/repo",
        branchName: "pourkit/42/test-issue",
        worktreePath,
        sandbox: sandboxConfig,
        artifacts: [
          { path: ".pourkit/.tmp/run-context.md", content: "context" },
        ],
        logger: makeLogger(),
      });

      expect(sandcastleMocks.createWorktreeMock).not.toHaveBeenCalled();
      expect(
        sandcastleMocks.createSandboxFromExistingWorktreeMock
      ).toHaveBeenCalledWith({
        branch: "pourkit/42/test-issue",
        hostRepoDir: "/repo",
        worktreePath,
        sandbox: { name: "docker" },
        copyToWorktree: ["node_modules"],
        hooks: { sandbox: { onSandboxReady: [] } },
      });
      expect(sandboxRun).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "review this", name: "reviewer" })
      );
      expect(sandcastleMocks.opencodeMock).toHaveBeenCalledWith(
        "test-review",
        expect.objectContaining({ agent: "review", env: {} })
      );
      expect(result.success).toBe(true);
      expect(result.worktreePath).toBe(worktreePath);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("falls back to the requested branch when sandbox metadata is missing", async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "pourkit-missing-branch-"));
    const sandboxRun = vi.fn().mockResolvedValue({
      commits: [],
      logFilePath: "/tmp/reviewer.log",
    });
    sandcastleMocks.createSandboxFromExistingWorktreeMock.mockResolvedValue({
      branch: undefined,
      worktreePath,
      run: sandboxRun,
      close: vi.fn(),
    });

    const logger = makeLogger();
    const provider = new SandcastleExecutionProvider();
    try {
      const result = await provider.execute({
        stage: "reviewer",
        agent: "review",
        model: "test-review",
        prompt: "review this",
        target: makeTarget(),
        repoRoot: "/repo",
        branchName: "pourkit/42/test-issue",
        worktreePath,
        sandbox: sandboxConfig,
        logger,
      });

      expect(result.success).toBe(true);
      expect(result.branch).toBe("pourkit/42/test-issue");
      expect(logger.kv).toHaveBeenCalledWith(
        "WORKTREE_BRANCH",
        "pourkit/42/test-issue"
      );
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("passes configured sandbox mounts unchanged", async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "pourkit-mounts-"));
    const originalMounts = [
      {
        hostPath: "~/.local/share/opencode",
        sandboxPath: "/home/agent/.local/share/opencode",
        readonly: false,
      },
    ];
    const originalMountsCopy = JSON.parse(JSON.stringify(originalMounts));
    const sandboxRun = vi.fn().mockResolvedValue({
      branch: "pourkit/42/test-issue",
      commits: [],
    });
    sandcastleMocks.createSandboxFromExistingWorktreeMock.mockResolvedValue({
      branch: "pourkit/42/test-issue",
      worktreePath,
      run: sandboxRun,
      close: vi.fn(),
    });

    const provider = new SandcastleExecutionProvider();
    try {
      await provider.execute({
        stage: "reviewer",
        agent: "review",
        model: "test-review",
        prompt: "review this",
        target: makeTarget(),
        repoRoot: "/repo",
        branchName: "pourkit/42/test-issue",
        worktreePath,
        sandbox: {
          provider: "docker",
          mounts: originalMounts,
          env: sandboxConfig.env,
        },
        logger: makeLogger(),
      });

      expect(sandcastleMocks.dockerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          mounts: originalMounts,
          imageName: "sandcastle:repo",
          env: sandboxConfig.env,
        })
      );
      expect(originalMounts).toEqual(originalMountsCopy);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("passes auto approve environment with role agent", async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "pourkit-autoadvance-"));
    const sandboxRun = vi.fn().mockResolvedValue({
      branch: "pourkit/42/test-issue",
      commits: [],
    });
    sandcastleMocks.createSandboxFromExistingWorktreeMock.mockResolvedValue({
      branch: "pourkit/42/test-issue",
      worktreePath,
      run: sandboxRun,
      close: vi.fn(),
    });

    const provider = new SandcastleExecutionProvider();
    try {
      const result = await provider.execute({
        stage: "refactor",
        agent: "refactor",
        model: "test-refactor",
        prompt: "refactor this",
        target: makeTarget(),
        repoRoot: "/repo",
        branchName: "pourkit/42/test-issue",
        worktreePath,
        sandbox: sandboxConfig,
        autoApprove: true,
        logger: makeLogger(),
      });

      expect(sandcastleMocks.opencodeMock).toHaveBeenCalledWith(
        "test-refactor",
        expect.objectContaining({
          agent: "refactor",
          env: { OPENCODE_AUTO_APPROVE: "true" },
        })
      );
      expect(result.success).toBe(true);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("logs tool call stream events with formatted arguments", async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "pourkit-stream-"));
    const sandboxRun = vi.fn().mockResolvedValue({
      branch: "pourkit/42/test-issue",
      commits: [],
    });
    sandcastleMocks.createSandboxFromExistingWorktreeMock.mockResolvedValue({
      branch: "pourkit/42/test-issue",
      worktreePath,
      run: sandboxRun,
      close: vi.fn(),
    });

    const logger = makeLogger();
    const provider = new SandcastleExecutionProvider();
    try {
      await provider.execute({
        stage: "builder",
        agent: "build",
        model: "test-build",
        prompt: "build this",
        target: makeTarget(),
        repoRoot: "/repo",
        branchName: "pourkit/42/test-issue",
        worktreePath,
        sandbox: sandboxConfig,
        logger,
      });

      const runOptions = sandboxRun.mock.calls[0]?.[0] as {
        logging: {
          onAgentStreamEvent: (event: {
            type: "toolCall";
            name: string;
            formattedArgs: string;
            iteration: number;
            timestamp: Date;
          }) => void;
        };
      };
      runOptions.logging.onAgentStreamEvent({
        type: "toolCall",
        name: "Read",
        formattedArgs: '{"filePath":"/repo/file.ts","offset":1}',
        iteration: 1,
        timestamp: new Date("2026-01-01T00:00:00.000Z"),
      });

      expect(logger.raw).toHaveBeenCalledWith(
        'Read({"filePath":"/repo/file.ts","offset":1})'
      );
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });
});
