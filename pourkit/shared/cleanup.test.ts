import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  existsSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseWorktreeListPorcelain,
  listCleanupCandidates,
  cleanupRepository,
} from "./cleanup";

const { execCaptureMock } = vi.hoisted(() => ({
  execCaptureMock: vi.fn(),
}));

const { readWorktreeRunStateMock } = vi.hoisted(() => ({
  readWorktreeRunStateMock: vi.fn(),
}));

vi.mock("./common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./common")>();
  return {
    ...actual,
    execCapture: execCaptureMock,
  };
});

vi.mock("./worktree-run-state", () => ({
  readWorktreeRunState: readWorktreeRunStateMock,
}));

function makePorcelain(entries: { path: string; branch?: string }[]): string {
  return (
    entries
      .map((e) => {
        let block = `worktree ${e.path}\nHEAD 0000000000000000000000000000000000000000`;
        if (e.branch) {
          block += `\nbranch refs/heads/${e.branch}`;
        }
        return block;
      })
      .join("\n\n") + "\n"
  );
}

const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
const recentDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

const mockLogger = {
  step: vi.fn(),
  line: vi.fn(),
  raw: vi.fn(),
  status: vi.fn(),
  kv: vi.fn(),
  close: vi.fn(),
};

describe("parseWorktreeListPorcelain", () => {
  it("parses a single worktree entry", () => {
    const text = makePorcelain([
      { path: "/repo/pourkit/123/test", branch: "pourkit/123/test" },
    ]);
    const result = parseWorktreeListPorcelain(text);
    expect(result).toEqual([
      { path: "/repo/pourkit/123/test", branch: "pourkit/123/test" },
    ]);
  });

  it("parses main worktree without branch", () => {
    const text = makePorcelain([{ path: "/repo" }]);
    const result = parseWorktreeListPorcelain(text);
    expect(result).toEqual([{ path: "/repo", branch: undefined }]);
  });

  it("parses multiple entries", () => {
    const text = makePorcelain([
      { path: "/repo" },
      { path: "/repo/pourkit/123/test", branch: "pourkit/123/test" },
    ]);
    const result = parseWorktreeListPorcelain(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ path: "/repo", branch: undefined });
    expect(result[1]).toEqual({
      path: "/repo/pourkit/123/test",
      branch: "pourkit/123/test",
    });
  });
});

describe("listCleanupCandidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty when no worktrees exist", async () => {
    execCaptureMock.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const result = await listCleanupCandidates("/repo", 14);
    expect(result).toEqual([]);
  });

  it("skips main worktree (no branch)", async () => {
    execCaptureMock.mockResolvedValue({
      stdout: makePorcelain([{ path: "/repo" }]),
      stderr: "",
      code: 0,
    });
    const result = await listCleanupCandidates("/repo", 14);
    expect(result).toEqual([]);
  });

  it("skips worktrees without run state", async () => {
    execCaptureMock.mockResolvedValue({
      stdout: makePorcelain([{ path: "/repo/wt", branch: "pourkit/123/test" }]),
      stderr: "",
      code: 0,
    });
    readWorktreeRunStateMock.mockReturnValue(null);
    const result = await listCleanupCandidates("/repo", 14);
    expect(result).toEqual([]);
  });

  it("skips worktrees that are not completed", async () => {
    execCaptureMock.mockResolvedValue({
      stdout: makePorcelain([{ path: "/repo/wt", branch: "pourkit/123/test" }]),
      stderr: "",
      code: 0,
    });
    readWorktreeRunStateMock.mockReturnValue({
      updatedAt: staleDate,
      completedStages: { builder: true },
      review: { lifetimeIterations: 1 },
    });
    const result = await listCleanupCandidates("/repo", 14);
    expect(result).toEqual([]);
  });

  it("skips worktrees that are recent (within retention window)", async () => {
    execCaptureMock.mockResolvedValue({
      stdout: makePorcelain([{ path: "/repo/wt", branch: "pourkit/123/test" }]),
      stderr: "",
      code: 0,
    });
    readWorktreeRunStateMock.mockReturnValue({
      updatedAt: recentDate,
      completedStages: { builder: true },
      review: { lifetimeIterations: 1 },
      pr: { created: true, merged: true },
    });
    const result = await listCleanupCandidates("/repo", 14);
    expect(result).toEqual([]);
  });

  it("returns stale completed worktrees as candidates", async () => {
    execCaptureMock.mockResolvedValue({
      stdout: makePorcelain([{ path: "/repo/wt", branch: "pourkit/123/test" }]),
      stderr: "",
      code: 0,
    });
    readWorktreeRunStateMock.mockReturnValue({
      updatedAt: staleDate,
      completedStages: { builder: true },
      review: { lifetimeIterations: 1 },
      pr: { created: true, merged: true },
    });
    const result = await listCleanupCandidates("/repo", 14);
    expect(result).toEqual([{ path: "/repo/wt", branch: "pourkit/123/test" }]);
  });

  it("does not consider finalizer.completed alone as completion", async () => {
    execCaptureMock.mockResolvedValue({
      stdout: makePorcelain([{ path: "/repo/wt", branch: "pourkit/123/test" }]),
      stderr: "",
      code: 0,
    });
    readWorktreeRunStateMock.mockReturnValue({
      updatedAt: staleDate,
      completedStages: { builder: true },
      review: { lifetimeIterations: 1 },
      finalizer: { completed: true },
    });
    const result = await listCleanupCandidates("/repo", 14);
    expect(result).toEqual([]);
  });

  it("skips resumable worktrees but returns stale completed ones", async () => {
    execCaptureMock.mockResolvedValue({
      stdout: makePorcelain([
        { path: "/repo" },
        {
          path: "/repo/pourkit/123/active",
          branch: "pourkit/123/active",
        },
        {
          path: "/repo/pourkit/456/stale-completed",
          branch: "pourkit/456/stale-completed",
        },
      ]),
      stderr: "",
      code: 0,
    });

    readWorktreeRunStateMock.mockImplementation((worktreePath: string) => {
      if (worktreePath === "/repo/pourkit/123/active") {
        return {
          updatedAt: recentDate,
          completedStages: { builder: true },
          review: { lifetimeIterations: 1 },
        };
      }
      if (worktreePath === "/repo/pourkit/456/stale-completed") {
        return {
          updatedAt: staleDate,
          completedStages: { builder: true },
          review: { lifetimeIterations: 1 },
          pr: { created: true, merged: true },
        };
      }
      return null;
    });

    const result = await listCleanupCandidates("/repo", 14);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/repo/pourkit/456/stale-completed");
    expect(result[0].path).not.toBe("/repo/pourkit/123/active");
  });
});

describe("cleanupRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when cleanup is disabled", async () => {
    await cleanupRepository({
      repoRoot: "/repo",
      config: {
        targets: [],
        labels: {
          readyForAgent: "",
          agentInProgress: "",
          blocked: "",
          prOpenAwaitingMerge: "",
          readyForHuman: "",
          needsTriage: "",
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
        serena: {
          enabled: false,
          required: false,
          mcpUrl: "http://localhost:9121/mcp",
          sandboxMcpUrl: "http://localhost:9121/mcp",
          dataDir: ".pourkit/serena/",
          autoStart: false,
        },
        cleanup: {
          enabled: false,
          worktreeRetentionDays: 14,
          logRetentionDays: 30,
        },
      },
      issueProvider: {} as any,
      prProvider: {} as any,
      logger: mockLogger as any,
    });

    expect(execCaptureMock).not.toHaveBeenCalled();
  });

  it("calls removeStaleWorktree for each candidate", async () => {
    execCaptureMock.mockResolvedValueOnce({
      stdout: makePorcelain([
        {
          path: "/repo/wt",
          branch: "pourkit/123/test",
        },
      ]),
      stderr: "",
      code: 0,
    });

    readWorktreeRunStateMock.mockReturnValue({
      updatedAt: staleDate,
      completedStages: { builder: true },
      review: { lifetimeIterations: 1 },
      pr: { created: true, merged: true },
    });

    execCaptureMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      code: 0,
    });
    execCaptureMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      code: 0,
    });
    execCaptureMock.mockResolvedValueOnce({
      stdout: makePorcelain([
        {
          path: "/repo/wt",
          branch: "pourkit/123/test",
        },
      ]),
      stderr: "",
      code: 0,
    });

    await cleanupRepository({
      repoRoot: "/repo",
      config: {
        targets: [],
        labels: {
          readyForAgent: "",
          agentInProgress: "",
          blocked: "",
          prOpenAwaitingMerge: "",
          readyForHuman: "",
          needsTriage: "",
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
      },
      issueProvider: {} as any,
      prProvider: {} as any,
      logger: mockLogger as any,
    });

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: "/repo" }
    );
    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/repo/wt"],
      { cwd: "/repo" }
    );
    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["branch", "-d", "pourkit/123/test"],
      { cwd: "/repo" }
    );
  });

  it("does not fail when git worktree list fails", async () => {
    execCaptureMock.mockRejectedValueOnce(new Error("git error"));

    await cleanupRepository({
      repoRoot: "/repo",
      config: {
        targets: [],
        labels: {
          readyForAgent: "",
          agentInProgress: "",
          blocked: "",
          prOpenAwaitingMerge: "",
          readyForHuman: "",
          needsTriage: "",
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
      },
      issueProvider: {} as any,
      prProvider: {} as any,
      logger: mockLogger as any,
    });

    expect(mockLogger.step).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("Cleanup failed")
    );
  });

  it("prunes aged logs and prompt dumps while keeping fresh ones", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pourkit-cleanup-test-"));
    try {
      mkdirSync(join(tmpDir, ".pourkit", "logs"), { recursive: true });

      const oldLogPath = join(tmpDir, ".pourkit", "logs", "old.log");
      writeFileSync(oldLogPath, "old");
      const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      utimesSync(oldLogPath, fortyDaysAgo, fortyDaysAgo);

      const freshLogPath = join(tmpDir, ".pourkit", "logs", "fresh.log");
      writeFileSync(freshLogPath, "fresh");

      const wtPath = join(tmpDir, "worktrees", "test");
      mkdirSync(join(wtPath, ".pourkit", ".tmp", "prompts"), {
        recursive: true,
      });

      const oldPromptPath = join(
        wtPath,
        ".pourkit",
        ".tmp",
        "prompts",
        "old-prompt.md"
      );
      writeFileSync(oldPromptPath, "old prompt");
      utimesSync(oldPromptPath, fortyDaysAgo, fortyDaysAgo);

      const freshPromptPath = join(
        wtPath,
        ".pourkit",
        ".tmp",
        "prompts",
        "fresh-prompt.md"
      );
      writeFileSync(freshPromptPath, "fresh prompt");

      execCaptureMock.mockResolvedValueOnce({
        stdout: makePorcelain([{ path: wtPath, branch: "pourkit/123/test" }]),
        stderr: "",
        code: 0,
      });

      readWorktreeRunStateMock.mockReturnValue({
        updatedAt: staleDate,
        completedStages: { builder: true },
        review: { lifetimeIterations: 1 },
        pr: { created: true, merged: true },
      });

      execCaptureMock.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        code: 0,
      });
      execCaptureMock.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        code: 0,
      });

      execCaptureMock.mockResolvedValueOnce({
        stdout: makePorcelain([{ path: wtPath, branch: "pourkit/123/test" }]),
        stderr: "",
        code: 0,
      });

      await cleanupRepository({
        repoRoot: tmpDir,
        config: {
          targets: [],
          labels: {
            readyForAgent: "",
            agentInProgress: "",
            blocked: "",
            prOpenAwaitingMerge: "",
            readyForHuman: "",
            needsTriage: "",
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
        },
        issueProvider: {} as any,
        prProvider: {} as any,
        logger: mockLogger as any,
      });

      expect(existsSync(oldLogPath)).toBe(false);
      expect(existsSync(freshLogPath)).toBe(true);
      expect(existsSync(oldPromptPath)).toBe(false);
      expect(existsSync(freshPromptPath)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves old unreadable log files rather than deleting them", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pourkit-cleanup-test-"));
    const unreadableLogPath = join(
      tmpDir,
      ".pourkit",
      "logs",
      "unreadable.log"
    );
    try {
      mkdirSync(join(tmpDir, ".pourkit", "logs"), { recursive: true });
      writeFileSync(unreadableLogPath, "secret");
      const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      utimesSync(unreadableLogPath, fortyDaysAgo, fortyDaysAgo);
      chmodSync(unreadableLogPath, 0o000);

      execCaptureMock.mockResolvedValueOnce({
        stdout: makePorcelain([]),
        stderr: "",
        code: 0,
      });

      await cleanupRepository({
        repoRoot: tmpDir,
        config: {
          targets: [],
          labels: {
            readyForAgent: "",
            agentInProgress: "",
            blocked: "",
            prOpenAwaitingMerge: "",
            readyForHuman: "",
            needsTriage: "",
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
        },
        issueProvider: {} as any,
        prProvider: {} as any,
        logger: mockLogger as any,
      });

      expect(existsSync(unreadableLogPath)).toBe(true);
    } finally {
      try {
        chmodSync(unreadableLogPath, 0o644);
      } catch {
        // may not exist after cleanup if running as root
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
