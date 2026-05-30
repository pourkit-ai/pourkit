import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runSerenaInitCommand,
  runSerenaRefreshCommand,
  runSerenaStartCommand,
  runSerenaStatusCommand,
  runSerenaStopCommand,
} from "./serena";

const { loadRepoConfigMock, repoRootMock } = vi.hoisted(() => ({
  loadRepoConfigMock: vi.fn(),
  repoRootMock: vi.fn((cwd?: string) => cwd ?? "/repo"),
}));

const {
  ensureBaselineWorktreeMock,
  refreshSerenaBaselineMock,
  prepareSerenaSidecarConfigMock,
  getSerenaSidecarStatusMock,
  getSerenaBaselineStatusMock,
  startSerenaSidecarMock,
  stopSerenaSidecarMock,
} = vi.hoisted(() => ({
  ensureBaselineWorktreeMock: vi.fn(),
  refreshSerenaBaselineMock: vi.fn(),
  prepareSerenaSidecarConfigMock: vi.fn(),
  getSerenaSidecarStatusMock: vi.fn(),
  getSerenaBaselineStatusMock: vi.fn(),
  startSerenaSidecarMock: vi.fn(),
  stopSerenaSidecarMock: vi.fn(),
}));

vi.mock("../shared/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/config")>();
  return {
    ...actual,
    loadRepoConfig: loadRepoConfigMock,
  };
});

vi.mock("../shared/common", () => ({
  repoRoot: repoRootMock,
}));

vi.mock("../serena/baseline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../serena/baseline")>();
  return {
    ...actual,
    ensureBaselineWorktree: ensureBaselineWorktreeMock,
    getSerenaBaselineStatus: getSerenaBaselineStatusMock,
    refreshSerenaBaseline: refreshSerenaBaselineMock,
  };
});

vi.mock("../serena/container", () => ({
  prepareSerenaSidecarConfig: prepareSerenaSidecarConfigMock,
  getSerenaSidecarStatus: getSerenaSidecarStatusMock,
  startSerenaSidecar: startSerenaSidecarMock,
  stopSerenaSidecar: stopSerenaSidecarMock,
}));

const config = {
  targets: [
    {
      name: "default",
      baseBranch: "dev",
      branchTemplate: "pourkit/{{issue.number}}/{{issue.slug}}",
      strategy: {
        type: "review-refactor-loop" as const,
        implement: {
          builder: {
            agent: "build",
            model: "test",
            promptTemplate: "builder.prompt.md",
          },
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
    {
      name: "other",
      baseBranch: "main",
      branchTemplate: "pourkit/{{issue.number}}/{{issue.slug}}",
      strategy: {
        type: "review-refactor-loop" as const,
        implement: {
          builder: {
            agent: "build",
            model: "test",
            promptTemplate: "builder.prompt.md",
          },
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
  serena: {
    enabled: true,
    required: false,
    mcpUrl: "http://localhost:9121/mcp",
    sandboxMcpUrl: "http://localhost:9121/mcp",
    dataDir: ".pourkit/serena/",
    autoStart: false,
  },
};

describe("serena commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadRepoConfigMock.mockResolvedValue(config);
  });

  it("initializes Serena baseline for target base branch", async () => {
    const resolvedPaths = {
      rootDir: "/repo/.pourkit/serena",
      baselineWorktreePath: "/repo/.pourkit/serena/baseline/active-repo",
      dataDir: "/repo/.pourkit/serena/data",
    };
    ensureBaselineWorktreeMock.mockResolvedValue(resolvedPaths);

    await runSerenaInitCommand({ target: "default", cwd: "/repo" });

    expect(repoRootMock).toHaveBeenCalledWith("/repo");
    expect(loadRepoConfigMock).toHaveBeenCalledWith("/repo");
    expect(ensureBaselineWorktreeMock).toHaveBeenCalledWith({
      repoRoot: "/repo",
      dataDir: ".pourkit/serena/",
    });
    expect(refreshSerenaBaselineMock).toHaveBeenCalledWith({
      repoRoot: "/repo",
      dataDir: ".pourkit/serena/",
      baseBranch: "dev",
    });
    expect(prepareSerenaSidecarConfigMock).toHaveBeenCalledWith({
      baselineWorktreePath: resolvedPaths.baselineWorktreePath,
      dataDir: resolvedPaths.dataDir,
    });
  });

  it("resolves Serena data directory path from config for init", async () => {
    const { resolveSerenaPaths } =
      await vi.importActual<typeof import("../serena/baseline")>(
        "../serena/baseline"
      );

    const paths = resolveSerenaPaths("/repo", ".pourkit/serena/");

    expect(paths.dataDir).toBe(
      path.join("/repo", ".pourkit", "serena", "data")
    );
  });

  it("refreshes Serena baseline for target base branch", async () => {
    await runSerenaRefreshCommand({ target: "other" });

    expect(repoRootMock).toHaveBeenCalled();
    expect(loadRepoConfigMock).toHaveBeenCalledWith("/repo");
    expect(ensureBaselineWorktreeMock).not.toHaveBeenCalled();
    expect(refreshSerenaBaselineMock).toHaveBeenCalledWith({
      repoRoot: "/repo",
      dataDir: ".pourkit/serena/",
      baseBranch: "main",
    });
  });

  it("starts Serena sidecar without refreshing baseline", async () => {
    const resolvedPaths = {
      rootDir: "/repo/.pourkit/serena",
      baselineWorktreePath: "/repo/.pourkit/serena/baseline/active-repo",
      dataDir: "/repo/.pourkit/serena/data",
    };
    ensureBaselineWorktreeMock.mockResolvedValue(resolvedPaths);
    startSerenaSidecarMock.mockResolvedValue({
      running: true,
      mcpUrl: "http://localhost:9121/mcp",
      dashboardUrl: "http://localhost:24282",
      containerName: "pourkit-serena-sidecar",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await runSerenaStartCommand({ cwd: "/repo" });

      expect(ensureBaselineWorktreeMock).toHaveBeenCalledWith({
        repoRoot: "/repo",
        dataDir: ".pourkit/serena/",
      });
      expect(refreshSerenaBaselineMock).not.toHaveBeenCalled();
      expect(startSerenaSidecarMock).toHaveBeenCalledWith(
        expect.objectContaining({
          baselineWorktreePath: resolvedPaths.baselineWorktreePath,
          dataDir: resolvedPaths.dataDir,
        })
      );
      expect(prepareSerenaSidecarConfigMock).toHaveBeenCalledWith({
        baselineWorktreePath: resolvedPaths.baselineWorktreePath,
        dataDir: resolvedPaths.dataDir,
      });
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Serena sidecar started")
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("stops Serena sidecar without deleting data", async () => {
    stopSerenaSidecarMock.mockResolvedValue({
      running: false,
      mcpUrl: "http://localhost:9121/mcp",
      dashboardUrl: "http://localhost:24282",
      containerName: "pourkit-serena-sidecar",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await runSerenaStopCommand({ cwd: "/repo" });

      expect(ensureBaselineWorktreeMock).not.toHaveBeenCalled();
      expect(stopSerenaSidecarMock).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Serena sidecar stopped")
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("reports Serena status freshness when target is provided", async () => {
    getSerenaSidecarStatusMock.mockResolvedValue({
      running: true,
      mcpUrl: "http://localhost:9121/mcp",
      dashboardUrl: "http://localhost:24282",
      containerName: "pourkit-serena-sidecar",
    });
    getSerenaBaselineStatusMock.mockResolvedValue({
      exists: true,
      baselineWorktreePath: "/repo/.pourkit/serena/baseline/active-repo",
      currentCommit: "abc123",
      expectedRef: "origin/dev",
      fresh: false,
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await runSerenaStatusCommand({ target: "default", cwd: "/repo" });

      expect(getSerenaSidecarStatusMock).toHaveBeenCalledWith(
        expect.objectContaining({
          baselineWorktreePath: "/repo/.pourkit/serena/baseline/active-repo",
          dataDir: "/repo/.pourkit/serena/data",
        })
      );
      expect(getSerenaBaselineStatusMock).toHaveBeenCalledWith({
        repoRoot: "/repo",
        dataDir: ".pourkit/serena/",
        baseBranch: "dev",
      });
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Baseline freshness: stale")
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("reports Serena status without target freshness", async () => {
    getSerenaSidecarStatusMock.mockResolvedValue({
      running: false,
      mcpUrl: "http://localhost:9121/mcp",
      dashboardUrl: "http://localhost:24282",
      containerName: "pourkit-serena-sidecar",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await runSerenaStatusCommand({ cwd: "/repo" });

      expect(getSerenaBaselineStatusMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Serena sidecar status")
      );
    } finally {
      logSpy.mockRestore();
    }
  });
});
