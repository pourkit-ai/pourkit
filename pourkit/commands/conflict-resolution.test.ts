import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  runConflictResolutionOnce,
  runConflictResolutionLoop,
} from "./conflict-resolution";
import { FakeExecutionProvider } from "../execution/execution-provider";
import type { PourkitConfig, IssueData } from "../shared/config";

const { execCaptureMock } = vi.hoisted(() => ({
  execCaptureMock: vi.fn(),
}));
vi.mock("../shared/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/common")>();
  return {
    ...actual,
    execCapture: execCaptureMock,
  };
});

const makeLogger = () => ({
  line: () => {},
  raw: () => {},
  step: () => {},
  status: () => {},
  kv: () => {},
  close: async () => {},
});

const makeConfig = (): PourkitConfig => ({
  targets: [
    {
      name: "test",
      baseBranch: "main",
      branchTemplate: "pourkit/{{issue.number}}/{{issue.slug}}",
      autoMerge: true,
      strategy: {
        type: "review-refactor-loop",
        implement: {
          builder: { agent: "build", model: "test", promptTemplate: "test.md" },
        },
        conflictResolution: {
          agent: "resolve",
          model: "test-resolve",
          promptTemplate: "resolve.md",
          maxAttempts: 1,
        },
        review: {
          reviewer: {
            agent: "review",
            model: "test",
            promptTemplate: "test.md",
            criteria: [],
          },
          refactor: {
            agent: "refactor",
            model: "test",
            promptTemplate: "test.md",
          },
          maxIterations: 3,
          passWithNotesRefactorAttempts: 2,
        },
        verify: {
          commands: [{ command: "echo ok", label: "ok" }],
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
    pollIntervalSeconds: 0,
    issueListLimit: 50,
  },
  cleanup: {
    enabled: true,
    worktreeRetentionDays: 14,
    logRetentionDays: 30,
  },
});

const makeIssue = (): IssueData => ({
  number: 42,
  title: "Test issue",
  body: "Test body",
  state: "open",
  labels: [],
  comments: [],
  createdAt: new Date("2024-01-01T00:00:00Z"),
});

describe("runConflictResolutionOnce", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cr-prompt-test-"));
    const promptsDir = join(tmpDir, ".pourkit", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "resolve.md"),
      "# Test conflict resolution prompt",
      "utf-8"
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes the artifact path in the prompt passed to the execution provider", async () => {
    const provider = new FakeExecutionProvider({
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: tmpDir,
      commits: [],
      logPath: null,
    });

    const superExecute = provider.execute.bind(provider);
    provider.execute = (async (opts: any) => {
      const result = await superExecute(opts);
      if (
        opts.stage === "conflictResolution" &&
        opts.artifactPath &&
        opts.worktreePath
      ) {
        const fullPath = join(opts.worktreePath, opts.artifactPath);
        mkdirSync(join(fullPath, ".."), { recursive: true });
        writeFileSync(
          fullPath,
          [
            "## Status",
            "",
            "resolved",
            "",
            "## Summary",
            "",
            "- Resolved conflict.",
            "",
            "## Files",
            "",
            "- `test-file.ts`",
            "",
            "<conflict-resolution>resolved</conflict-resolution>",
          ].join("\n"),
          "utf-8"
        );
      }
      return result;
    }) as any;

    const config = makeConfig();

    const result = await runConflictResolutionOnce({
      executionProvider: provider as any,
      config,
      target: config.targets[0],
      issue: makeIssue(),
      branchName: "pourkit/42/test-issue",
      worktreePath: tmpDir,
      repoRoot: tmpDir,
      conflictedPaths: ["test-file.ts"],
      attempt: 1,
      logger: makeLogger(),
    });

    expect(provider.lastOptions?.prompt).toContain(
      ".pourkit/.tmp/conflict-resolution/attempt-1.md"
    );
    expect(result.status).toBe("resolved");
  });
});

describe("runConflictResolutionLoop", () => {
  let tmpDir: string;
  const logger = makeLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cr-loop-test-"));
    const promptsDir = join(tmpDir, ".pourkit", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "resolve.md"),
      "# Test conflict resolution prompt",
      "utf-8"
    );
    execCaptureMock.mockReset();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns failed when git rebase --continue fails without new conflicted paths", async () => {
    writeFileSync(join(tmpDir, "test-file.ts"), "resolved content\n", "utf-8");

    execCaptureMock
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("no changes - empty commit"))
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    const provider = new FakeExecutionProvider({
      success: true,
      branch: "pourkit/42/test-issue",
      worktreePath: tmpDir,
      commits: [],
      logPath: null,
    });

    const superExecute = provider.execute.bind(provider);
    provider.execute = (async (opts: any) => {
      const result = await superExecute(opts);
      if (
        opts.stage === "conflictResolution" &&
        opts.artifactPath &&
        opts.worktreePath
      ) {
        const fullPath = join(opts.worktreePath, opts.artifactPath);
        mkdirSync(join(fullPath, ".."), { recursive: true });
        writeFileSync(
          fullPath,
          [
            "## Status",
            "",
            "resolved",
            "",
            "## Summary",
            "",
            "- Resolved conflict.",
            "",
            "## Files",
            "",
            "- `test-file.ts`",
            "",
            "<conflict-resolution>resolved</conflict-resolution>",
          ].join("\n"),
          "utf-8"
        );
      }
      return result;
    }) as any;

    const config = makeConfig();

    const result = await runConflictResolutionLoop({
      executionProvider: provider as any,
      config,
      target: config.targets[0],
      issue: makeIssue(),
      branchName: "pourkit/42/test-issue",
      worktreePath: tmpDir,
      repoRoot: tmpDir,
      initialConflictedPaths: ["test-file.ts"],
      maxAttempts: 2,
      logger,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.message).toContain(
        "git rebase --continue failed with no remaining conflicts"
      );
      expect(result.message).toContain("no changes - empty commit");
    }
    expect(result.attempts).toBe(1);
  });
});
