import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadRepoConfigMock, repoRootMock, createLoggerMock, execCaptureMock } =
  vi.hoisted(() => ({
    loadRepoConfigMock: vi.fn(),
    repoRootMock: vi.fn((cwd?: string) => cwd ?? "/repo"),
    createLoggerMock: vi.fn(),
    execCaptureMock: vi
      .fn()
      .mockResolvedValue({ stdout: "v1.8.0-next.81\n", stderr: "", code: 0 }),
  }));

const {
  runIssueCommandMock,
  runQueueCommandMock,
  runPrCreateCommandMock,
  runPrMergeCommandMock,
  runInitCommandMock,
  promptForInitChoicesMock,
  cleanupRepositoryMock,
} = vi.hoisted(() => ({
  runIssueCommandMock: vi.fn(),
  runQueueCommandMock: vi.fn(),
  runPrCreateCommandMock: vi.fn(),
  runPrMergeCommandMock: vi.fn(),
  runInitCommandMock: vi.fn(),
  promptForInitChoicesMock: vi.fn(),
  cleanupRepositoryMock: vi.fn().mockResolvedValue(undefined),
}));

const { GitHubIssueProviderMock, GitHubPRProviderMock } = vi.hoisted(() => {
  const providerMethods = {
    fetchIssue: vi.fn(),
    addLabels: vi.fn(),
    removeLabel: vi.fn(),
    getComments: vi.fn(),
    listCandidates: vi.fn(),
    listRelatedIssues: vi.fn(),
  };
  const prProviderMethods = {
    createPr: vi.fn(),
    getPr: vi.fn(),
    getPrByNumber: vi.fn(),
    getCheckStatus: vi.fn(),
    mergePr: vi.fn(),
    enableAutoMerge: vi.fn(),
    waitForPrChecks: vi.fn(),
    getBranchStatus: vi.fn(),
  };
  return {
    GitHubIssueProviderMock: vi.fn().mockImplementation(function () {
      return { ...providerMethods };
    }),
    GitHubPRProviderMock: vi.fn().mockImplementation(function () {
      return { ...prProviderMethods };
    }),
  };
});

vi.mock("./shared/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared/config")>();
  return {
    ...actual,
    loadRepoConfig: loadRepoConfigMock,
  };
});

vi.mock("./shared/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared/common")>();
  return {
    ...actual,
    repoRoot: repoRootMock,
    createLogger: createLoggerMock,
    execCapture: execCaptureMock,
  };
});

vi.mock("./commands/issue", () => ({
  runIssueCommand: runIssueCommandMock,
}));

vi.mock("./commands/queue-run", () => ({
  runQueueCommand: runQueueCommandMock,
}));

vi.mock("./commands/pr-create", () => ({
  runPrCreateCommand: runPrCreateCommandMock,
}));

vi.mock("./commands/pr-merge", () => ({
  runPrMergeCommand: runPrMergeCommandMock,
}));

vi.mock("./commands/init", () => ({
  runInitCommand: runInitCommandMock,
  promptForInitChoices: promptForInitChoicesMock,
}));

vi.mock("./shared/cleanup", () => ({
  cleanupRepository: cleanupRepositoryMock,
}));

vi.mock("./providers/github-provider", () => ({
  GitHubIssueProvider: GitHubIssueProviderMock,
}));

vi.mock("./providers/github-pr-provider", () => ({
  GitHubPRProvider: GitHubPRProviderMock,
}));

vi.mock("./providers/github-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./providers/github-client")>();
  return {
    ...actual,
    requireGitHubClient: vi.fn().mockResolvedValue({
      octokit: {},
      owner: "test-owner",
      repo: "test-repo",
    }),
  };
});

const config = {
  targets: [
    {
      name: "default",
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
};

describe("pourkit cli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.POURKIT_CLI_VERSION;
    loadRepoConfigMock.mockResolvedValue(config);
    cleanupRepositoryMock.mockResolvedValue(undefined);
    createLoggerMock.mockReturnValue({
      step: vi.fn(),
      line: vi.fn(),
      raw: vi.fn(),
      status: vi.fn(),
      kv: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("routes issue commands through commander", async () => {
    runIssueCommandMock.mockResolvedValue({
      branchName: "pourkit/123/test-issue",
      target: config.targets[0],
      issue: { number: 123 },
      prNumber: 7,
      prUrl: "https://example.com/pr/7",
      prTitle: "fix: Test issue",
    });

    const { main } = await import("./cli");

    await main(["issue", "123", "--target", "default", "--force"]);

    expect(loadRepoConfigMock).toHaveBeenCalledWith("/repo");
    expect(config.targets[0]).not.toHaveProperty("verificationCommands");
    expect(createLoggerMock).toHaveBeenCalledWith(
      "pourkit",
      expect.stringContaining(".pourkit/logs")
    );
    expect(runIssueCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 123,
        targetName: "default",
        force: true,
      })
    );
    expect(GitHubIssueProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "test-owner", repo: "test-repo" }),
      expect.objectContaining({ readyForAgentLabel: "ready-for-agent" })
    );
    expect(GitHubPRProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "test-owner", repo: "test-repo" }),
      expect.any(Object)
    );
  });

  it("routes queue-run commands through commander", async () => {
    runQueueCommandMock.mockResolvedValue({
      selected: { number: 123 },
      runResult: {
        branchName: "pourkit/123/test-issue",
        target: config.targets[0],
        issue: { number: 123 },
        prNumber: 7,
        prUrl: "https://example.com/pr/7",
        prTitle: "fix: Test issue",
      },
    });

    const { main } = await import("./cli");

    await main(["queue-run", "--target", "default"]);

    expect(loadRepoConfigMock).toHaveBeenCalledWith("/repo");
    expect(createLoggerMock).toHaveBeenCalledWith(
      "pourkit",
      expect.stringContaining(".pourkit/logs")
    );
    expect(runQueueCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetName: "default",
        force: false,
      })
    );
    expect(GitHubIssueProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "test-owner", repo: "test-repo" }),
      expect.objectContaining({ readyForAgentLabel: "ready-for-agent" })
    );
    expect(GitHubPRProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "test-owner", repo: "test-repo" }),
      expect.any(Object)
    );
  });

  it("passes loop: true to runQueueCommand when --loop is provided", async () => {
    runQueueCommandMock.mockResolvedValue({
      selected: { number: 123 },
      runResult: {
        branchName: "pourkit/123/test-issue",
        target: config.targets[0],
        issue: { number: 123 },
        prNumber: 7,
        prUrl: "https://example.com/pr/7",
        prTitle: "fix: Test issue",
      },
    });

    const { main } = await import("./cli");

    await main(["queue-run", "--target", "default", "--loop"]);

    expect(runQueueCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ loop: true })
    );
  });

  it("passes loop: false to runQueueCommand by default", async () => {
    runQueueCommandMock.mockResolvedValue({
      selected: { number: 123 },
      runResult: {
        branchName: "pourkit/123/test-issue",
        target: config.targets[0],
        issue: { number: 123 },
        prNumber: 7,
        prUrl: "https://example.com/pr/7",
        prTitle: "fix: Test issue",
      },
    });

    const { main } = await import("./cli");

    await main(["queue-run", "--target", "default"]);

    expect(runQueueCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ loop: false })
    );
  });

  it("passes loop: true to runQueueCommand when target has queue.loop: true", async () => {
    const loopConfig = {
      ...config,
      targets: [
        {
          ...config.targets[0],
          name: "loop-target",
          queue: { loop: true },
        },
      ],
    };
    loadRepoConfigMock.mockResolvedValue(loopConfig);
    runQueueCommandMock.mockResolvedValue({
      selected: { number: 123 },
      runResult: {
        branchName: "pourkit/123/test-issue",
        target: loopConfig.targets[0],
        issue: { number: 123 },
        prNumber: 7,
        prUrl: "https://example.com/pr/7",
        prTitle: "fix: Test issue",
      },
    });

    const { main } = await import("./cli");

    await main(["queue-run", "--target", "loop-target"]);

    expect(runQueueCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ loop: true })
    );
  });

  it("exits successfully when queue-run --loop returns drained outcome", async () => {
    runQueueCommandMock.mockResolvedValue({
      drained: true,
      processedCount: 2,
      results: [],
      selected: null,
      reason: "Queue drained.",
      code: "drained",
    });

    const { main } = await import("./cli");

    process.exitCode = undefined;
    await main(["queue-run", "--target", "default", "--loop"]);

    expect(process.exitCode).toBeUndefined();
    expect(runQueueCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ loop: true })
    );
  });

  it("routes pr create commands through commander", async () => {
    runPrCreateCommandMock.mockResolvedValue({
      options: {
        target: "default",
        title: "Add feature",
      },
      currentBranch: "feature/add-feature",
      baseBranch: "main",
      prNumber: 99,
      prUrl: "https://example.com/pr/99",
    });

    const { main } = await import("./cli");

    await main([
      "pr",
      "create",
      "--target",
      "default",
      "--title",
      "Add feature",
      "--body",
      "Body text",
      "--issue",
      "42",
      "--issue",
      "43",
    ]);

    expect(loadRepoConfigMock).toHaveBeenCalledWith("/repo");
    expect(createLoggerMock).toHaveBeenCalledWith(
      "pourkit",
      expect.stringContaining(".pourkit/logs")
    );
    expect(runPrCreateCommandMock).toHaveBeenCalledWith(
      [
        "--target",
        "default",
        "--title",
        "Add feature",
        "--body",
        "Body text",
        "--issue",
        "42",
        "--issue",
        "43",
      ],
      expect.any(Object),
      expect.any(Object),
      config,
      "/repo"
    );
  });

  it("routes pr merge commands through commander", async () => {
    runPrMergeCommandMock.mockResolvedValue({
      options: {
        prNumber: 99,
        method: "squash",
      },
      prNumber: 99,
      prTitle: "Add feature",
      baseBranch: "main",
      prUrl: "https://example.com/pr/99",
    });

    const { main } = await import("./cli");

    await main([
      "pr",
      "merge",
      "99",
      "--target",
      "default",
      "--method",
      "merge",
      "--no-target-green",
    ]);

    expect(loadRepoConfigMock).toHaveBeenCalledWith("/repo");
    expect(createLoggerMock).toHaveBeenCalledWith(
      "pourkit",
      expect.stringContaining(".pourkit/logs")
    );
    expect(runPrMergeCommandMock).toHaveBeenCalledWith(
      ["99", "--target", "default", "--method", "merge", "--no-target-green"],
      expect.any(Object),
      expect.any(Object),
      config
    );
  });

  it("routes init --dry-run --from-local through commander", async () => {
    const { main } = await import("./cli");

    await main(["init", "--dry-run", "--from-local", "/source"]);

    expect(runInitCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fromLocal: "/source",
        dryRun: true,
        json: undefined,
      })
    );
  });

  it("routes init --dry-run --json --from-local through commander", async () => {
    const { main } = await import("./cli");

    await main(["init", "--dry-run", "--json", "--from-local", "/source"]);

    expect(runInitCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fromLocal: "/source",
        dryRun: true,
        json: true,
      })
    );
  });

  it("rejects --force flag for init command", async () => {
    const exitCode = process.exitCode;
    process.exitCode = undefined;
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      const { main } = await import("./cli");

      await expect(main(["init", "--force"])).rejects.toThrow();
    } finally {
      stderrWrite.mockRestore();
      process.exitCode = exitCode;
    }
  });

  it("rejects invalid --docs-migration value", async () => {
    const exitCode = process.exitCode;
    process.exitCode = undefined;
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      const { main } = await import("./cli");

      await expect(
        main(["init", "--docs-migration", "delete", "--from-local", "/source"])
      ).rejects.toThrow();
    } finally {
      stderrWrite.mockRestore();
      process.exitCode = exitCode;
    }
  });

  it("rejects invalid --agent-file value", async () => {
    const exitCode = process.exitCode;
    process.exitCode = undefined;
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      const { main } = await import("./cli");

      await expect(
        main(["init", "--agent-file", "none", "--from-local", "/source"])
      ).rejects.toThrow();
    } finally {
      stderrWrite.mockRestore();
      process.exitCode = exitCode;
    }
  });

  it("routes init --docs-migration move --yes --from-local through commander", async () => {
    const { main } = await import("./cli");

    await main([
      "init",
      "--docs-migration",
      "move",
      "--yes",
      "--from-local",
      "/source",
    ]);

    expect(runInitCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        docsMigration: "move",
        yes: true,
        fromLocal: "/source",
      })
    );
  });

  it("routes init --legacy-skills through commander", async () => {
    const { main } = await import("./cli");

    await main(["init", "--legacy-skills", "--from-local", "/source"]);

    expect(runInitCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        legacySkills: true,
        fromLocal: "/source",
      })
    );
  });

  it("routes init --agent-file claude --yes --docs-migration skip through commander", async () => {
    const { main } = await import("./cli");

    await main([
      "init",
      "--agent-file",
      "claude",
      "--yes",
      "--docs-migration",
      "skip",
      "--from-local",
      "/source",
    ]);

    expect(runInitCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentFile: "claude",
        yes: true,
        docsMigration: "skip",
        fromLocal: "/source",
      })
    );
  });

  it("routes init --cwd through commander", async () => {
    const { main } = await import("./cli");

    await main([
      "init",
      "--dry-run",
      "--from-local",
      "/source",
      "--cwd",
      "/target/repo",
    ]);

    expect(runInitCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/target/repo",
        fromLocal: "/source",
        dryRun: true,
      })
    );
  });

  it("routes init --package-manager through commander", async () => {
    const { main } = await import("./cli");

    await main([
      "init",
      "--dry-run",
      "--from-local",
      "/source",
      "--package-manager",
      "pnpm",
    ]);

    expect(runInitCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        packageManager: "pnpm",
        fromLocal: "/source",
      })
    );
  });

  it("routes init --no-git-check through commander", async () => {
    const { main } = await import("./cli");

    await main([
      "init",
      "--dry-run",
      "--from-local",
      "/source",
      "--no-git-check",
    ]);

    expect(runInitCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        noGitCheck: true,
        fromLocal: "/source",
      })
    );
  });

  it("routes init --skip-install through commander", async () => {
    const { main } = await import("./cli");

    await main([
      "init",
      "--dry-run",
      "--from-local",
      "/source",
      "--skip-install",
    ]);

    expect(runInitCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        skipInstall: true,
        fromLocal: "/source",
      })
    );
  });

  it("prints the resolved version tag on --version", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const { main } = await import("./cli");

    process.exitCode = undefined;
    await expect(main(["--version"])).rejects.toThrow();

    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining("v1.8.0-next.81")
    );
    expect(runIssueCommandMock).not.toHaveBeenCalled();
    expect(runQueueCommandMock).not.toHaveBeenCalled();
    expect(runPrCreateCommandMock).not.toHaveBeenCalled();

    stdoutSpy.mockRestore();
  });

  it("prints the resolved version tag on -V", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const { main } = await import("./cli");

    process.exitCode = undefined;
    await expect(main(["-V"])).rejects.toThrow();

    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining("v1.8.0-next.81")
    );
    expect(runIssueCommandMock).not.toHaveBeenCalled();
    expect(runQueueCommandMock).not.toHaveBeenCalled();
    expect(runPrCreateCommandMock).not.toHaveBeenCalled();

    stdoutSpy.mockRestore();
  });

  it("routes subcommand invocations containing --version through commander", async () => {
    const { main } = await import("./cli");

    await expect(
      main(["issue", "123", "--target", "default", "--version"])
    ).rejects.toThrow();

    expect(runIssueCommandMock).not.toHaveBeenCalled();
  });

  it("falls back to development version when tag lookup fails", async () => {
    execCaptureMock.mockRejectedValueOnce(new Error("not a git repository"));

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const { main } = await import("./cli");

    process.exitCode = undefined;
    await expect(main(["--version"])).rejects.toThrow();

    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining("0.0.0-development")
    );

    stdoutSpy.mockRestore();
  });

  it("prefers the packaged CLI version before repository inspection", async () => {
    process.env.POURKIT_CLI_VERSION = "v1.8.0-next.84";

    const { resolveCliVersion } = await import("./cli");
    const version = await resolveCliVersion();

    expect(version).toBe("v1.8.0-next.84");
    expect(repoRootMock).not.toHaveBeenCalled();
    expect(execCaptureMock).not.toHaveBeenCalled();
  });

  it("resolves version from the repo root using repoRoot()", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const { main } = await import("./cli");

    process.exitCode = undefined;
    await expect(main(["--version"])).rejects.toThrow();

    expect(repoRootMock).toHaveBeenCalled();
    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      [
        "tag",
        "--list",
        "v[0-9]*",
        "--sort=-version:refname",
        "--merged",
        "HEAD",
      ],
      expect.objectContaining({ cwd: "/repo" })
    );

    stdoutSpy.mockRestore();
  });

  it("falls back to development version for non-semver v... tags", async () => {
    execCaptureMock.mockResolvedValueOnce({
      stdout: "v1-initial\n",
      stderr: "",
      code: 0,
    });

    const { resolveCliVersion } = await import("./cli");
    const version = await resolveCliVersion();

    expect(version).toBe("0.0.0-development");
  });

  it("resolves valid release tag when a newer non-semver v* tag is also reachable", async () => {
    execCaptureMock.mockResolvedValueOnce({
      stdout: "v1-initial\nv1.0.0\n",
      stderr: "",
      code: 0,
    });

    const { resolveCliVersion } = await import("./cli");
    const version = await resolveCliVersion();

    expect(version).toBe("v1.0.0");
  });

  it("accepts valid hyphenated prerelease tags like v1.8.0-release-candidate.1", async () => {
    execCaptureMock.mockResolvedValueOnce({
      stdout: "v1.8.0-release-candidate.1\n",
      stderr: "",
      code: 0,
    });

    const { resolveCliVersion } = await import("./cli");
    const version = await resolveCliVersion();

    expect(version).toBe("v1.8.0-release-candidate.1");
  });

  it("ignores invalid packaged CLI versions", async () => {
    process.env.POURKIT_CLI_VERSION = "1.8.0-next.84";

    const { resolveCliVersion } = await import("./cli");
    const version = await resolveCliVersion();

    expect(version).toBe("v1.8.0-next.81");
    expect(repoRootMock).toHaveBeenCalled();
    expect(execCaptureMock).toHaveBeenCalled();
  });

  it("prints help and exits with a non-zero code when no args are provided", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const { main } = await import("./cli");

    process.exitCode = undefined;
    await main([]);

    expect(process.exitCode).toBe(1);
    expect(runIssueCommandMock).not.toHaveBeenCalled();
    expect(runQueueCommandMock).not.toHaveBeenCalled();
    expect(runPrCreateCommandMock).not.toHaveBeenCalled();

    stdoutSpy.mockRestore();
  });

  it("passes --cwd target root to issue command setup", async () => {
    runIssueCommandMock.mockResolvedValue({
      branchName: "pourkit/123/test-issue",
      target: config.targets[0],
      issue: { number: 123 },
      prNumber: 7,
      prUrl: "https://example.com/pr/7",
      prTitle: "fix: Test issue",
    });

    const { main } = await import("./cli");

    await main(["issue", "123", "--target", "default", "--cwd", "/tmp/target"]);

    expect(loadRepoConfigMock).toHaveBeenCalledWith("/tmp/target");
    expect(createLoggerMock).toHaveBeenCalledWith(
      "pourkit",
      expect.stringContaining("/tmp/target/.pourkit/logs")
    );
    expect(runIssueCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 123,
        targetName: "default",
        repoRoot: "/tmp/target",
      })
    );
    expect(GitHubIssueProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "test-owner", repo: "test-repo" }),
      expect.objectContaining({ readyForAgentLabel: "ready-for-agent" })
    );
    expect(GitHubPRProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "test-owner", repo: "test-repo" }),
      expect.any(Object)
    );
  });

  it("passes --cwd target root to queue-run command setup", async () => {
    runQueueCommandMock.mockResolvedValue({
      selected: { number: 456 },
      runResult: {
        branchName: "pourkit/456/test-issue",
        target: config.targets[0],
        issue: { number: 456 },
        prNumber: 8,
        prUrl: "https://example.com/pr/8",
        prTitle: "fix: Another issue",
      },
    });

    const { main } = await import("./cli");

    await main(["queue-run", "--target", "default", "--cwd", "/other/repo"]);

    expect(loadRepoConfigMock).toHaveBeenCalledWith("/other/repo");
    expect(createLoggerMock).toHaveBeenCalledWith(
      "pourkit",
      expect.stringContaining("/other/repo/.pourkit/logs")
    );
    expect(runQueueCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetName: "default",
        repoRoot: "/other/repo",
      })
    );
    expect(GitHubIssueProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "test-owner", repo: "test-repo" }),
      expect.objectContaining({ readyForAgentLabel: "ready-for-agent" })
    );
    expect(GitHubPRProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "test-owner", repo: "test-repo" }),
      expect.any(Object)
    );
  });

  it("normalizes lowercase prd ref and passes uppercase to runQueueCommand", async () => {
    runQueueCommandMock.mockResolvedValue({
      selected: { number: 123 },
      runResult: {
        branchName: "pourkit/123/test-issue",
        target: config.targets[0],
        issue: { number: 123 },
        prNumber: 7,
        prUrl: "https://example.com/pr/7",
        prTitle: "fix: Test issue",
      },
    });

    const { main } = await import("./cli");

    await main(["queue-run", "--target", "default", "--prd", "prd-021"]);

    expect(runQueueCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ targetName: "default", prdRef: "PRD-021" })
    );
  });

  it("rejects malformed prd refs with clear error", async () => {
    const { main } = await import("./cli");

    await expect(
      main(["queue-run", "--target", "default", "--prd", "21"])
    ).rejects.toThrow(/PRD-\d+/);
    expect(runQueueCommandMock).not.toHaveBeenCalled();
  });

  it("rejects malformed prd ref #21", async () => {
    const { main } = await import("./cli");

    await expect(
      main(["queue-run", "--target", "default", "--prd", "#21"])
    ).rejects.toThrow(/PRD-\d+/);
    expect(runQueueCommandMock).not.toHaveBeenCalled();
  });

  it("rejects malformed prd ref with space", async () => {
    const { main } = await import("./cli");

    await expect(
      main(["queue-run", "--target", "default", "--prd", "PRD 021"])
    ).rejects.toThrow(/PRD-\d+/);
    expect(runQueueCommandMock).not.toHaveBeenCalled();
  });

  it("invokes cleanup before issue command handler", async () => {
    runIssueCommandMock.mockResolvedValue({
      branchName: "pourkit/123/test-issue",
      target: config.targets[0],
      issue: { number: 123 },
      prNumber: 7,
      prUrl: "https://example.com/pr/7",
      prTitle: "fix: Test issue",
    });

    const { main } = await import("./cli");

    await main(["issue", "123", "--target", "default"]);

    expect(cleanupRepositoryMock).toHaveBeenCalled();
    expect(runIssueCommandMock).toHaveBeenCalled();
  });

  it("awaits cleanup before invoking issue command handler (ordering)", async () => {
    let resolveCleanup: () => void;
    cleanupRepositoryMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        })
    );
    runIssueCommandMock.mockResolvedValue({
      branchName: "pourkit/123/test-issue",
      target: config.targets[0],
      issue: { number: 123 },
      prNumber: 7,
      prUrl: "https://example.com/pr/7",
      prTitle: "fix: Test issue",
    });

    const { main } = await import("./cli");
    const promise = main(["issue", "123", "--target", "default"]);

    // After a microtask, cleanup should be called but handler should not
    await vi.waitFor(() => {
      expect(cleanupRepositoryMock).toHaveBeenCalled();
    });
    expect(runIssueCommandMock).not.toHaveBeenCalled();

    resolveCleanup!();
    await promise;

    expect(runIssueCommandMock).toHaveBeenCalled();
  });

  it("invokes cleanup before queue-run command handler", async () => {
    runQueueCommandMock.mockResolvedValue({
      selected: { number: 123 },
      runResult: {
        branchName: "pourkit/123/test-issue",
        target: config.targets[0],
        issue: { number: 123 },
        prNumber: 7,
        prUrl: "https://example.com/pr/7",
        prTitle: "fix: Test issue",
      },
    });

    const { main } = await import("./cli");

    await main(["queue-run", "--target", "default"]);

    expect(cleanupRepositoryMock).toHaveBeenCalled();
    expect(runQueueCommandMock).toHaveBeenCalled();
  });

  it("awaits cleanup before invoking queue-run command handler (ordering)", async () => {
    let resolveCleanup: () => void;
    cleanupRepositoryMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        })
    );
    runQueueCommandMock.mockResolvedValue({
      selected: { number: 123 },
      runResult: {
        branchName: "pourkit/123/test-issue",
        target: config.targets[0],
        issue: { number: 123 },
        prNumber: 7,
        prUrl: "https://example.com/pr/7",
        prTitle: "fix: Test issue",
      },
    });

    const { main } = await import("./cli");
    const promise = main(["queue-run", "--target", "default"]);

    await vi.waitFor(() => {
      expect(cleanupRepositoryMock).toHaveBeenCalled();
    });
    expect(runQueueCommandMock).not.toHaveBeenCalled();

    resolveCleanup!();
    await promise;

    expect(runQueueCommandMock).toHaveBeenCalled();
  });

  it("does not block issue command handler when cleanup fails", async () => {
    cleanupRepositoryMock.mockRejectedValueOnce(new Error("boom"));
    runIssueCommandMock.mockResolvedValue({
      branchName: "pourkit/123/test-issue",
      target: config.targets[0],
      issue: { number: 123 },
      prNumber: 7,
      prUrl: "https://example.com/pr/7",
      prTitle: "fix: Test issue",
    });

    const { main } = await import("./cli");

    await main(["issue", "123", "--target", "default"]);

    expect(cleanupRepositoryMock).toHaveBeenCalled();
    expect(runIssueCommandMock).toHaveBeenCalled();
  });

  it("does not block queue-run command handler when cleanup fails", async () => {
    cleanupRepositoryMock.mockRejectedValueOnce(new Error("boom"));
    runQueueCommandMock.mockResolvedValue({
      selected: { number: 123 },
      runResult: {
        branchName: "pourkit/123/test-issue",
        target: config.targets[0],
        issue: { number: 123 },
        prNumber: 7,
        prUrl: "https://example.com/pr/7",
        prTitle: "fix: Test issue",
      },
    });

    const { main } = await import("./cli");

    await main(["queue-run", "--target", "default"]);

    expect(cleanupRepositoryMock).toHaveBeenCalled();
    expect(runQueueCommandMock).toHaveBeenCalled();
  });

  it("passes --cwd target root to pr create command setup", async () => {
    runPrCreateCommandMock.mockResolvedValue({
      options: {
        target: "default",
        title: "Add feature",
      },
      currentBranch: "feature/add-feature",
      baseBranch: "main",
      prNumber: 99,
      prUrl: "https://example.com/pr/99",
    });

    const { main } = await import("./cli");

    await main([
      "pr",
      "create",
      "--target",
      "default",
      "--title",
      "Add feature",
      "--cwd",
      "/pr-repo",
    ]);

    expect(loadRepoConfigMock).toHaveBeenCalledWith("/pr-repo");
    expect(createLoggerMock).toHaveBeenCalledWith(
      "pourkit",
      expect.stringContaining("/pr-repo/.pourkit/logs")
    );
    expect(runPrCreateCommandMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Object),
      expect.any(Object),
      config,
      "/pr-repo"
    );
    expect(GitHubPRProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "test-owner", repo: "test-repo" }),
      expect.any(Object)
    );
  });
});
