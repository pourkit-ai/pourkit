import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  runReviewCommand,
  runReviewWithRefactorLoop,
  validateReviewArtifact,
  validateRefactorArtifact,
  ReviewArtifactValidationError,
  RefactorArtifactValidationError,
  extractLatestFindingIds,
  type RunReviewOptions,
  type RunReviewLoopOptions,
} from "./review";
import type {
  PourkitConfig,
  Target,
  IssueData,
  VerificationCommand,
} from "../shared/config";
import type {
  ExecutionProvider,
  ExecutionResult,
} from "../execution/execution-provider";
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "fs";
import { dirname, join } from "path";

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
          builder: {
            agent: "build",
            model: "test",
            promptTemplate: "test.md",
          },
        },
        review: {
          reviewer: {
            agent: "review",
            model: "test-review",
            promptTemplate: "review.md",
            criteria: ["correctness", "quality"],
          },
          refactor: {
            agent: "refactor",
            model: "test-refactor",
            promptTemplate: "refactor.prompt.md",
          },
          maxIterations: 3,
          passWithNotesRefactorAttempts: 2,
        },
        finalize: {
          prDescriptionAgent: {
            agent: "finalizer",
            model: "test-finalizer",
            promptTemplate: "finalizer.prompt.md",
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
});

const makeTarget = (): Target => ({
  name: "test",
  baseBranch: "main",
  branchTemplate: "pourkit/{{issue.number}}/{{issue.slug}}",
  autoMerge: true,
  strategy: {
    type: "review-refactor-loop",
    implement: {
      builder: {
        agent: "build",
        model: "test",
        promptTemplate: "test.md",
      },
    },
    review: {
      reviewer: {
        agent: "review",
        model: "test-review",
        promptTemplate: "review.md",
        criteria: ["correctness", "quality"],
      },
      refactor: {
        agent: "refactor",
        model: "test-refactor",
        promptTemplate: "refactor.prompt.md",
      },
      maxIterations: 3,
      passWithNotesRefactorAttempts: 2,
    },
    finalize: {
      prDescriptionAgent: {
        agent: "finalizer",
        model: "test-finalizer",
        promptTemplate: "finalizer.prompt.md",
      },
      maxAttempts: 2,
    },
  },
});

const makeIssue = (): IssueData => ({
  number: 42,
  title: "Test issue",
  body: "Test body",
  state: "open",
  labels: ["ready-for-agent"],
  comments: [],
});

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

const TMP_DIR = "/tmp/pourkit-review-test";
const WORKTREE_PATH = join(
  TMP_DIR,
  ".sandcastle",
  "worktrees",
  "pourkit-42-test-issue"
);

beforeEach(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true });
  }
});

function makeBaseOptions(
  overrides: Partial<RunReviewOptions> = {}
): RunReviewOptions {
  return {
    executionProvider: overrides.executionProvider ?? { execute: vi.fn() },
    config: overrides.config ?? makeConfig(),
    target: overrides.target ?? makeTarget(),
    issue: overrides.issue ?? makeIssue(),
    builderBranch: overrides.builderBranch ?? "pourkit/42/test-issue",
    worktreePath: overrides.worktreePath ?? WORKTREE_PATH,
    repoRoot: overrides.repoRoot ?? TMP_DIR,
    logger: overrides.logger ?? makeLogger(),
    ...overrides,
  };
}

function artifactPathFor(worktreePath: string) {
  return join(worktreePath, ".pourkit", ".tmp", "reviewers", "iteration-1.md");
}

function writeReviewerArtifact(
  worktreePath: string,
  output: string,
  iteration = 1,
  includePriorRefactorAssessment = false
) {
  const artifactPath = join(
    worktreePath,
    ".pourkit",
    ".tmp",
    "reviewers",
    `iteration-${iteration}.md`
  );
  mkdirSync(dirname(artifactPath), { recursive: true });
  let content = output;
  if (!output.includes("## Findings")) {
    const assessmentSection = includePriorRefactorAssessment
      ? [
          "## Prior Refactor Response Assessment",
          "",
          "| Prior Finding ID | Refactor Classification | Reviewer Assessment | Next Action |",
          "|------------------|-------------------------|---------------------|-------------|",
          "| R1.F1 | accepted | accepted-refactor-response | No further action needed. |",
          "",
        ].join("\n")
      : "";
    content = [
      "## Findings",
      "",
      "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
      "|----|------------|----------|-----------|-------|----------------|",
      "| none | n/a | n/a | n/a | No findings. | n/a |",
      "",
      assessmentSection,
      output,
    ]
      .filter((l) => l !== "")
      .join("\n");
  }
  writeFileSync(artifactPath, content, "utf-8");
  return artifactPath;
}

function writeRefactorArtifact(
  worktreePath: string,
  iteration: number,
  findingIds: string[] = []
) {
  const artifactPath = join(
    worktreePath,
    ".pourkit",
    ".tmp",
    "refactors",
    `iteration-${iteration}.md`
  );
  mkdirSync(dirname(artifactPath), { recursive: true });
  const findingRows =
    findingIds.length > 0
      ? findingIds
          .map(
            (id) => `| ${id} | accepted | Fixed as requested | src/test.ts |`
          )
          .join("\n")
      : "| R1.F1 | accepted | Fixed the issue | src/test.ts |";
  const content = [
    "## Finding Responses",
    "",
    "| Finding ID | Classification | Rationale | Files Changed |",
    "|------------|----------------|-----------|---------------|",
    findingRows,
    "",
    "## Verification",
    "",
    "| Command | Result | Notes |",
    "|---------|--------|-------|",
    "| npm test | passed | All tests green |",
    "",
    "## Open Blockers",
    "",
    "| Blocker | Needed From |",
    "|---------|-------------|",
    "| none | n/a |",
    "",
  ].join("\n");
  writeFileSync(artifactPath, content, "utf-8");
  return artifactPath;
}

function writeReviewLog(logPath: string, content: string) {
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, content, "utf-8");
}

function makeSuccessfulReviewExecutionProvider(
  writer?: (worktreePath: string) => void,
  logPath: string | null = null
): ExecutionProvider {
  return {
    execute: vi.fn(async (options) => {
      if (options.worktreePath && writer) {
        writer(options.worktreePath);
      }

      return {
        success: true,
        branch: "pourkit/42/test-issue",
        worktreePath: options.worktreePath ?? WORKTREE_PATH,
        commits: [],
        logPath,
      };
    }),
  };
}

describe("runReviewCommand", () => {
  it("throws when no reviewer config is present", async () => {
    const config = makeConfig();
    config.targets[0].strategy.review.reviewer = undefined as any;

    await expect(
      runReviewCommand(makeBaseOptions({ config, target: config.targets[0] }))
    ).rejects.toThrow("No reviewer config found");
  });

  it("throws when reviewer execution fails", async () => {
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async () => ({
        success: false,
        branch: "",
        worktreePath: "/worktree",
        commits: [],
        logPath: null,
        error: "reviewer crashed",
      })),
    };

    await expect(
      runReviewCommand(makeBaseOptions({ executionProvider }))
    ).rejects.toThrow("Reviewer execution failed: reviewer crashed");
  });

  it("returns PASS verdict and persists artifact written by reviewer", async () => {
    const artifactPath = artifactPathFor(WORKTREE_PATH);
    const executionProvider = makeSuccessfulReviewExecutionProvider(
      (worktreePath) => {
        writeReviewerArtifact(worktreePath, "<verdict>PASS</verdict>");
      }
    );

    const result = await runReviewCommand(
      makeBaseOptions({ executionProvider, repoRoot: TMP_DIR })
    );

    expect(result.verdict).toBe("PASS");
    expect(result.output).toContain("<verdict>PASS</verdict>");
    expect(result.output).toContain("## Findings");
    expect(result.artifactPath).toBe(artifactPath);
  });

  it("returns PASS_WITH_NOTES verdict", async () => {
    const executionProvider = makeSuccessfulReviewExecutionProvider(
      (worktreePath) => {
        writeReviewerArtifact(
          worktreePath,
          "<verdict>PASS_WITH_NOTES</verdict>"
        );
      }
    );

    const result = await runReviewCommand(
      makeBaseOptions({ executionProvider, repoRoot: TMP_DIR })
    );

    expect(result.verdict).toBe("PASS_WITH_NOTES");
  });

  it("ignores summary verdict text when the final line is the protocol verdict", async () => {
    const executionProvider = makeSuccessfulReviewExecutionProvider(
      (worktreePath) => {
        writeReviewerArtifact(
          worktreePath,
          [
            "## Summary",
            "",
            "The change is structurally fine.",
            "",
            "<verdict>PASS_WITH_NOTES</verdict>",
          ].join("\n")
        );
      }
    );

    const result = await runReviewCommand(
      makeBaseOptions({ executionProvider, repoRoot: TMP_DIR })
    );

    expect(result.verdict).toBe("PASS_WITH_NOTES");
  });

  it("returns FAIL verdict", async () => {
    const executionProvider = makeSuccessfulReviewExecutionProvider(
      (worktreePath) => {
        writeReviewerArtifact(worktreePath, "<verdict>FAIL</verdict>");
      }
    );

    const result = await runReviewCommand(
      makeBaseOptions({ executionProvider, repoRoot: TMP_DIR })
    );

    expect(result.verdict).toBe("FAIL");
  });

  it("throws when reviewer artifact is missing", async () => {
    const executionProvider = makeSuccessfulReviewExecutionProvider();

    await expect(
      runReviewCommand(
        makeBaseOptions({ executionProvider, repoRoot: TMP_DIR })
      )
    ).rejects.toThrow("Reviewer did not produce output");
  });

  it("recovers reviewer output from the sandbox log when the artifact is missing", async () => {
    const logPath = join(TMP_DIR, "logs", "reviewer.log");
    writeReviewLog(
      logPath,
      [
        "Agent started",
        "## Findings",
        "",
        "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
        "|----|------------|----------|-----------|-------|----------------|",
        "| none | n/a | n/a | n/a | No findings. | n/a |",
        "",
        "## Summary",
        "",
        "Ready to merge.",
        "",
        "## Recommendations",
        "",
        "- None.",
        "",
        "<verdict>PASS</verdict>",
        "Agent stopped",
      ].join("\n")
    );

    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => ({
        success: true,
        branch: "pourkit/42/test-issue",
        worktreePath: options.worktreePath ?? WORKTREE_PATH,
        commits: [],
        logPath,
      })),
    };

    const result = await runReviewCommand(
      makeBaseOptions({ executionProvider, repoRoot: TMP_DIR })
    );

    const recoveredArtifactPath = artifactPathFor(WORKTREE_PATH);
    expect(result.verdict).toBe("PASS");
    expect(result.output).toContain("## Findings");
    expect(result.output).toContain("<verdict>PASS</verdict>");
    expect(result.output).not.toContain("Agent stopped");
    expect(existsSync(recoveredArtifactPath)).toBe(true);
    expect(readFileSync(recoveredArtifactPath, "utf-8")).toBe(result.output);
  });

  it("throws on protocol error when no verdict found", async () => {
    const executionProvider = makeSuccessfulReviewExecutionProvider(
      (worktreePath) => {
        writeReviewerArtifact(worktreePath, "no verdict here");
      }
    );

    await expect(
      runReviewCommand(
        makeBaseOptions({ executionProvider, repoRoot: TMP_DIR })
      )
    ).rejects.toThrow(
      "Review protocol error: No <verdict>...</verdict> token found in reviewer output"
    );
  });

  it("returns NEEDS_REFACTOR verdict", async () => {
    const executionProvider = makeSuccessfulReviewExecutionProvider(
      (worktreePath) => {
        writeReviewerArtifact(
          worktreePath,
          "<verdict>NEEDS_REFACTOR</verdict>"
        );
      }
    );

    const result = await runReviewCommand(
      makeBaseOptions({ executionProvider, repoRoot: TMP_DIR })
    );

    expect(result.verdict).toBe("NEEDS_REFACTOR");
  });

  it("passes builder branch, worktree path, and artifact path to execution", async () => {
    const artifactPath = artifactPathFor(WORKTREE_PATH);
    const artifactPathInWorktree = ".pourkit/.tmp/reviewers/iteration-1.md";
    const config = makeConfig();
    let capturedOptions: any;
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        capturedOptions = options;
        writeReviewerArtifact(
          options.worktreePath ?? WORKTREE_PATH,
          "<verdict>PASS</verdict>",
          options.iteration ?? 1
        );
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    await runReviewCommand(
      makeBaseOptions({ executionProvider, config, repoRoot: TMP_DIR })
    );

    expect(capturedOptions.stage).toBe("reviewer");
    expect(capturedOptions.agent).toBe("review");
    expect(capturedOptions.model).toBe("test-review");
    expect(capturedOptions.branchName).toBe("pourkit/42/test-issue");
    expect(capturedOptions.worktreePath).toBe(WORKTREE_PATH);
    expect(capturedOptions.artifactPath).toBe(artifactPathInWorktree);
    expect(capturedOptions.artifacts).toEqual([
      expect.objectContaining({
        path: ".pourkit/.tmp/run-context.md",
        content: expect.stringContaining("Test issue"),
      }),
    ]);
    expect(capturedOptions.prompt).toContain(".pourkit/.tmp/run-context.md");
    expect(capturedOptions.prompt).toContain("correctness");
    expect(capturedOptions.prompt).toContain("quality");
    expect(capturedOptions.prompt).toContain(
      ".pourkit/.tmp/reviewers/iteration-1.md"
    );
    expect(capturedOptions.prompt).toContain(
      "runner only reads the file above"
    );
  });

  it("clears a stale artifact before reviewer execution", async () => {
    const artifactPath = writeReviewerArtifact(
      WORKTREE_PATH,
      "<verdict>PASS</verdict>"
    );

    const executionProvider = makeSuccessfulReviewExecutionProvider();

    await expect(
      runReviewCommand(
        makeBaseOptions({ executionProvider, repoRoot: TMP_DIR })
      )
    ).rejects.toThrow(`Reviewer did not produce output at ${artifactPath}`);
  });

  it("loads the configured prompt file and renders criteria snippets", async () => {
    const promptsDir = join(TMP_DIR, ".pourkit", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "reviewer.prompt.md"),
      "Header\n\n{{REVIEW_CRITERIA}}\n",
      "utf-8"
    );
    writeFileSync(
      join(promptsDir, "reviewer-correctness.snippet.md"),
      "### Correctness\n",
      "utf-8"
    );
    writeFileSync(
      join(promptsDir, "reviewer-tests.snippet.md"),
      "### Tests\n",
      "utf-8"
    );

    const config = makeConfig();
    config.targets[0].strategy.review.reviewer.promptTemplate =
      "reviewer.prompt.md";
    config.targets[0].strategy.review.reviewer.criteria = [
      "correctness",
      "tests",
    ];
    const target = config.targets[0];

    let capturedPrompt = "";
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        capturedPrompt = options.prompt;
        writeReviewerArtifact(
          options.worktreePath ?? WORKTREE_PATH,
          "<verdict>PASS</verdict>",
          options.iteration ?? 1
        );
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    await runReviewCommand(
      makeBaseOptions({ executionProvider, config, target, repoRoot: TMP_DIR })
    );

    expect(capturedPrompt).toContain("Header");
    expect(capturedPrompt).toContain("### Correctness");
    expect(capturedPrompt).toContain("### Tests");
    expect(capturedPrompt).not.toContain("{{REVIEW_CRITERIA}}");
  });

  it("loads reviewer prompt from explicit .pourkit/prompts/... path", async () => {
    const promptsDir = join(TMP_DIR, ".pourkit", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "reviewer.prompt.md"),
      "Explicit path reviewer template\n",
      "utf-8"
    );

    const config = makeConfig();
    config.targets[0].strategy.review.reviewer.promptTemplate =
      ".pourkit/prompts/reviewer.prompt.md";
    config.targets[0].strategy.review.reviewer.criteria = ["correctness"];

    let capturedPrompt = "";
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        capturedPrompt = options.prompt;
        writeReviewerArtifact(
          options.worktreePath ?? WORKTREE_PATH,
          "<verdict>PASS</verdict>",
          options.iteration ?? 1
        );
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    await runReviewCommand(
      makeBaseOptions({
        executionProvider,
        config,
        target: config.targets[0],
        repoRoot: TMP_DIR,
      })
    );

    expect(capturedPrompt).toContain("Explicit path reviewer template");
    expect(capturedPrompt).toContain("- correctness");
  });
});

const makeConfigWithRefactor = (): PourkitConfig => ({
  targets: [
    {
      name: "test",
      baseBranch: "main",
      branchTemplate: "pourkit/{{issue.number}}/{{issue.slug}}",
      autoMerge: true,
      strategy: {
        type: "review-refactor-loop",
        implement: {
          builder: {
            agent: "build",
            model: "test",
            promptTemplate: "test.md",
          },
        },
        review: {
          reviewer: {
            agent: "review",
            model: "test-review",
            promptTemplate: "review.md",
            criteria: ["correctness", "quality"],
          },
          refactor: {
            agent: "refactor",
            model: "test-refactor",
            promptTemplate: "refactor.prompt.md",
          },
          maxIterations: 3,
          passWithNotesRefactorAttempts: 2,
        },
        verify: {
          commands: [{ command: "npm run typecheck", label: "typecheck" }],
        },
        finalize: {
          prDescriptionAgent: {
            agent: "finalizer",
            model: "test-finalizer",
            promptTemplate: "finalizer.prompt.md",
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
});

function makeBaseLoopOptions(
  overrides: Partial<RunReviewLoopOptions> = {}
): RunReviewLoopOptions {
  return {
    executionProvider: overrides.executionProvider ?? { execute: vi.fn() },
    config: overrides.config ?? makeConfigWithRefactor(),
    target: overrides.target ?? makeTarget(),
    issue: overrides.issue ?? makeIssue(),
    builderBranch: overrides.builderBranch ?? "pourkit/42/test-issue",
    worktreePath: overrides.worktreePath ?? WORKTREE_PATH,
    repoRoot: overrides.repoRoot ?? TMP_DIR,
    logger: overrides.logger ?? makeLogger(),
    ...overrides,
  };
}

function makeLoopTargetWithVerify(
  commands: VerificationCommand[] = [
    { command: "npm run typecheck", label: "typecheck" },
  ]
): Target {
  return {
    ...makeTarget(),
    strategy: {
      type: "review-refactor-loop",
      implement: {
        builder: { agent: "build", model: "test", promptTemplate: "test.md" },
      },
      review: {
        reviewer: {
          agent: "review",
          model: "test-review",
          promptTemplate: "review.md",
          criteria: ["correctness", "quality"],
        },
        refactor: {
          agent: "refactor",
          model: "test-refactor",
          promptTemplate: "refactor.prompt.md",
        },
        maxIterations: 3,
        passWithNotesRefactorAttempts: 2,
      },
      verify: { commands },
      finalize: {
        prDescriptionAgent: {
          agent: "finalize",
          model: "test",
          promptTemplate: "test.md",
        },
        maxAttempts: 1,
      },
    },
  };
}

describe("runReviewWithRefactorLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execCaptureMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    if (existsSync(TMP_DIR)) {
      rmSync(TMP_DIR, { recursive: true });
    }
  });

  it("uses strategy-only config without legacy fallback fields", () => {
    const config = makeConfigWithRefactor();
    const target = config.targets[0];
    expect(config).not.toHaveProperty("refactorer");
    expect(config).not.toHaveProperty("maxReviewIterations");
    expect(target).not.toHaveProperty("maxReviewIterations");
    expect(target).not.toHaveProperty("verificationCommands");
    expect(target.strategy.review.passWithNotesRefactorAttempts).toBe(2);
  });

  it("throws when no reviewer config is present", async () => {
    const config = makeConfigWithRefactor();
    config.targets[0].strategy.review.reviewer = undefined as any;

    await expect(
      runReviewWithRefactorLoop(
        makeBaseLoopOptions({ config, target: config.targets[0] })
      )
    ).rejects.toThrow("No reviewer config found");
  });

  it("throws when no refactor config is present", async () => {
    const config = makeConfigWithRefactor();
    config.targets[0].strategy.review.refactor = undefined as any;

    await expect(
      runReviewWithRefactorLoop(
        makeBaseLoopOptions({ config, target: config.targets[0] })
      )
    ).rejects.toThrow("No refactorer config found");
  });

  it("resumed review writes next lifetime artifact", async () => {
    let reviewCallCount = 0;
    let capturedArtifactPath: string | undefined;
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        if (options.stage === "reviewer") {
          reviewCallCount++;
          capturedArtifactPath = options.artifactPath;
          writeReviewerArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            "<verdict>PASS</verdict>",
            options.iteration ?? 1
          );
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    const result = await runReviewWithRefactorLoop(
      makeBaseLoopOptions({ executionProvider, startingLifetimeIteration: 2 })
    );

    expect(result.verdict).toBe("PASS");
    expect(result.lifetimeIterations).toBe(3);
    expect(result.artifactPath).toContain("iteration-3.md");
    expect(capturedArtifactPath).toContain("iteration-3.md");
  });

  it("exhausted previous run does not block resumed budget", async () => {
    let reviewCallCount = 0;
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        if (options.stage === "reviewer") {
          reviewCallCount++;
          writeReviewerArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            "<verdict>PASS</verdict>",
            options.iteration ?? 1
          );
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    const result = await runReviewWithRefactorLoop(
      makeBaseLoopOptions({
        executionProvider,
        config: {
          ...makeConfigWithRefactor(),
          targets: [
            {
              ...makeConfigWithRefactor().targets[0],
              strategy: {
                ...makeConfigWithRefactor().targets[0].strategy,
                review: {
                  ...makeConfigWithRefactor().targets[0].strategy.review,
                  maxIterations: 2,
                },
              },
            },
          ],
        },
        startingLifetimeIteration: 2,
      })
    );

    expect(result.exhaustedMaxIterations).toBe(false);
    expect(result.lifetimeIterations).toBe(3);
    expect(reviewCallCount).toBe(1);
  });

  it("returns PASS on first iteration without refactor", async () => {
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        writeReviewerArtifact(
          options.worktreePath ?? WORKTREE_PATH,
          "<verdict>PASS</verdict>",
          options.iteration ?? 1
        );
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    const result = await runReviewWithRefactorLoop(
      makeBaseLoopOptions({ executionProvider })
    );

    expect(result.verdict).toBe("PASS");
    expect(result.iterations).toBe(1);
    expect(result.exhaustedMaxIterations).toBe(false);
  });

  it("refactors PASS_WITH_NOTES until the retry budget is exhausted", async () => {
    let reviewCallCount = 0;
    let refactorHasRun = false;
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        if (options.stage === "reviewer") {
          reviewCallCount++;
          writeReviewerArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            "<verdict>PASS_WITH_NOTES</verdict>",
            options.iteration ?? 1,
            refactorHasRun
          );
        } else if (options.stage === "refactor") {
          refactorHasRun = true;
          writeRefactorArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            options.iteration ?? 1
          );
        }

        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    const result = await runReviewWithRefactorLoop(
      makeBaseLoopOptions({ executionProvider })
    );

    expect(result.verdict).toBe("PASS");
    expect(result.iterations).toBe(3);
    expect(result.exhaustedMaxIterations).toBe(false);
    expect(reviewCallCount).toBe(3);
    expect(executionProvider.execute).toHaveBeenCalledTimes(5);
  });

  it("uses the configured PASS_WITH_NOTES retry budget", async () => {
    const config = makeConfigWithRefactor();
    config.targets[0].strategy.review.passWithNotesRefactorAttempts = 1;

    let reviewCallCount = 0;
    let refactorHasRun = false;
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        if (options.stage === "reviewer") {
          reviewCallCount++;
          writeReviewerArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            "<verdict>PASS_WITH_NOTES</verdict>",
            options.iteration ?? 1,
            refactorHasRun
          );
        } else if (options.stage === "refactor") {
          refactorHasRun = true;
          writeRefactorArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            options.iteration ?? 1
          );
        }

        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    const result = await runReviewWithRefactorLoop(
      makeBaseLoopOptions({
        executionProvider,
        config,
        target: config.targets[0],
      })
    );

    expect(result.verdict).toBe("PASS");
    expect(result.iterations).toBe(2);
    expect(reviewCallCount).toBe(2);
    expect(executionProvider.execute).toHaveBeenCalledTimes(3);
  });

  it("runs refactor on NEEDS_REFACTOR then passes on second iteration", async () => {
    let reviewCallCount = 0;
    let refactorHasRun = false;
    const prompts: string[] = [];
    const refactorPrompts: string[] = [];
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        if (options.stage === "reviewer") {
          reviewCallCount++;
          prompts.push(options.prompt);
          const verdict =
            reviewCallCount === 1
              ? "<verdict>NEEDS_REFACTOR</verdict>"
              : "<verdict>PASS</verdict>";
          writeReviewerArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            verdict,
            options.iteration ?? 1,
            refactorHasRun
          );
        } else if (options.stage === "refactor") {
          refactorHasRun = true;
          refactorPrompts.push(options.prompt);
          writeRefactorArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            options.iteration ?? 1
          );
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    const result = await runReviewWithRefactorLoop(
      makeBaseLoopOptions({ executionProvider })
    );

    expect(result.verdict).toBe("PASS");
    expect(result.iterations).toBe(2);
    expect(result.exhaustedMaxIterations).toBe(false);
    expect(prompts[0]).toContain(".pourkit/.tmp/reviewers/iteration-1.md");
    expect(prompts[1]).toContain(".pourkit/.tmp/reviewers/iteration-2.md");
    expect(prompts[1]).toContain("## Prior Refactor Artifacts");
    expect(prompts[1]).toContain("### Refactor Iteration 1");
    expect(prompts[1]).toContain(
      "Treat these as conversational context, not source of truth"
    );
    expect(prompts[1]).toContain("Fixed the issue");
    expect(prompts[1]).not.toContain("## Review History");
    expect(refactorPrompts[0]).toContain(
      ".pourkit/.tmp/refactors/iteration-1.md"
    );
    expect(refactorPrompts[0]).toContain("## Hard Rule");
    expect(refactorPrompts[0]).toContain(
      "Do **not** revert, delete, or substantially strip already-landed protected sibling/base work unless the issue explicitly requires those files."
    );
    expect(executionProvider.execute).toHaveBeenCalledTimes(3);
  });

  it("includeReviewHistory false suppresses review history but not refactor artifacts", async () => {
    const config = makeConfigWithRefactor();
    config.targets[0].strategy.review.reviewer.includeReviewHistory = false;

    let reviewCallCount = 0;
    let refactorHasRun = false;
    const prompts: string[] = [];
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        if (options.stage === "reviewer") {
          reviewCallCount++;
          prompts.push(options.prompt);
          const verdict =
            reviewCallCount === 1
              ? "<verdict>NEEDS_REFACTOR</verdict>"
              : "<verdict>PASS</verdict>";
          writeReviewerArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            verdict,
            options.iteration ?? 1,
            refactorHasRun
          );
        } else if (options.stage === "refactor") {
          refactorHasRun = true;
          writeRefactorArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            options.iteration ?? 1
          );
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    const result = await runReviewWithRefactorLoop(
      makeBaseLoopOptions({ executionProvider, config })
    );

    expect(result.verdict).toBe("PASS");
    expect(result.iterations).toBe(2);
    expect(refactorHasRun).toBe(true);
    expect(prompts[0]).toContain(".pourkit/.tmp/reviewers/iteration-1.md");
    expect(prompts[1]).toContain(".pourkit/.tmp/reviewers/iteration-2.md");
    expect(prompts[1]).toContain("## Prior Refactor Artifacts");
    expect(prompts[1]).toContain("### Refactor Iteration 1");
    expect(prompts[1]).toContain(
      "Treat these as conversational context, not source of truth"
    );
    expect(prompts[1]).not.toContain("## Review History");
  });

  it("loads refactor prompt from explicit .pourkit/prompts/... path", async () => {
    const promptsDir = join(TMP_DIR, ".pourkit", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "refactor.prompt.md"),
      "Explicit path refactor template",
      "utf-8"
    );

    let refactorPrompt = "";
    let reviewCallCount = 0;
    let refactorHasRun = false;
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        if (options.stage === "reviewer") {
          reviewCallCount++;
          writeReviewerArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            "<verdict>NEEDS_REFACTOR</verdict>",
            options.iteration ?? 1,
            refactorHasRun
          );
        } else if (options.stage === "refactor") {
          refactorHasRun = true;
          refactorPrompt = options.prompt;
          writeRefactorArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            options.iteration ?? 1
          );
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    const config = makeConfigWithRefactor();
    config.targets[0].strategy.review.refactor.promptTemplate =
      ".pourkit/prompts/refactor.prompt.md";

    const result = await runReviewWithRefactorLoop(
      makeBaseLoopOptions({ executionProvider, config })
    );

    expect(result.exhaustedMaxIterations).toBe(true);
    expect(refactorPrompt).toContain("Explicit path refactor template");
  });

  it("runs refactor on FAIL then passes on second iteration", async () => {
    let reviewCallCount = 0;
    let refactorHasRun = false;
    const prompts: string[] = [];
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        if (options.stage === "reviewer") {
          reviewCallCount++;
          prompts.push(options.prompt);
          const verdict =
            reviewCallCount === 1
              ? "<verdict>FAIL</verdict>"
              : "<verdict>PASS</verdict>";
          writeReviewerArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            verdict,
            options.iteration ?? 1,
            refactorHasRun
          );
        } else if (options.stage === "refactor") {
          refactorHasRun = true;
          writeRefactorArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            options.iteration ?? 1
          );
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    const result = await runReviewWithRefactorLoop(
      makeBaseLoopOptions({ executionProvider })
    );

    expect(result.verdict).toBe("PASS");
    expect(result.iterations).toBe(2);
    expect(result.exhaustedMaxIterations).toBe(false);
    expect(prompts[0]).toContain(".pourkit/.tmp/reviewers/iteration-1.md");
    expect(prompts[1]).toContain(".pourkit/.tmp/reviewers/iteration-2.md");
    expect(executionProvider.execute).toHaveBeenCalledTimes(3);
  });

  it("transitions to ready-for-human when FAIL refactor execution fails", async () => {
    let reviewCallCount = 0;
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        if (options.stage === "reviewer") {
          reviewCallCount++;
          writeReviewerArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            "<verdict>FAIL</verdict>",
            options.iteration ?? 1
          );
        }
        if (options.stage === "refactor") {
          return {
            success: false,
            branch: "pourkit/42/test-issue",
            worktreePath: options.worktreePath ?? WORKTREE_PATH,
            commits: [],
            logPath: null,
            error: "refactor crashed",
          };
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    const result = await runReviewWithRefactorLoop(
      makeBaseLoopOptions({ executionProvider })
    );

    expect(result.verdict).toBe("FAIL");
    expect(result.iterations).toBe(1);
    expect(result.exhaustedMaxIterations).toBe(false);
    expect(result.refactorCompletedForLastReview).toBe(false);
  });

  it("transitions to ready-for-human when max iterations exhausted", async () => {
    const config = makeConfigWithRefactor();
    config.targets[0].strategy.review.maxIterations = 2;

    let refactorHasRun = false;
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        if (options.stage === "reviewer") {
          writeReviewerArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            "<verdict>NEEDS_REFACTOR</verdict>",
            options.iteration ?? 1,
            refactorHasRun
          );
        } else if (options.stage === "refactor") {
          refactorHasRun = true;
          writeRefactorArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            options.iteration ?? 1
          );
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    const result = await runReviewWithRefactorLoop(
      makeBaseLoopOptions({
        executionProvider,
        config,
        target: config.targets[0],
      })
    );

    expect(result.verdict).toBe("FAIL");
    expect(result.iterations).toBe(2);
    expect(result.exhaustedMaxIterations).toBe(true);
  });

  it("persists iteration artifacts", async () => {
    let reviewCallCount = 0;
    let refactorHasRun = false;
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        if (options.stage === "reviewer") {
          reviewCallCount++;
          const verdict =
            reviewCallCount === 1
              ? "<verdict>NEEDS_REFACTOR</verdict>"
              : "<verdict>PASS</verdict>";
          writeReviewerArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            verdict,
            options.iteration ?? 1,
            refactorHasRun
          );
        } else if (options.stage === "refactor") {
          refactorHasRun = true;
          writeRefactorArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            options.iteration ?? 1
          );
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    await runReviewWithRefactorLoop(makeBaseLoopOptions({ executionProvider }));

    const iteration1Path = join(
      WORKTREE_PATH,
      ".pourkit",
      ".tmp",
      "reviewers",
      "iteration-1.md"
    );
    const iteration2Path = join(
      WORKTREE_PATH,
      ".pourkit",
      ".tmp",
      "reviewers",
      "iteration-2.md"
    );
    expect(existsSync(iteration1Path)).toBe(true);
    expect(existsSync(iteration2Path)).toBe(true);
    expect(readFileSync(iteration1Path, "utf-8")).toContain(
      "<verdict>NEEDS_REFACTOR</verdict>"
    );
    expect(readFileSync(iteration2Path, "utf-8")).toContain(
      "<verdict>PASS</verdict>"
    );
  });

  it("preserves malformed output on protocol failure", async () => {
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        const artifactPath = join(
          options.worktreePath ?? WORKTREE_PATH,
          ".pourkit",
          ".tmp",
          "reviewers",
          `iteration-${options.iteration ?? 1}.md`
        );
        mkdirSync(dirname(artifactPath), { recursive: true });
        writeFileSync(artifactPath, "no verdict here", "utf-8");
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    await expect(
      runReviewWithRefactorLoop(makeBaseLoopOptions({ executionProvider }))
    ).rejects.toThrow("Review protocol error");

    const iterationPath = join(
      WORKTREE_PATH,
      ".pourkit",
      ".tmp",
      "reviewers",
      "iteration-1.md"
    );
    expect(existsSync(iterationPath)).toBe(true);
    expect(readFileSync(iterationPath, "utf-8")).toBe("no verdict here");
  });

  it("persists iteration 2 review output to the matching artifact file", async () => {
    let reviewCallCount = 0;
    let refactorHasRun = false;
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        if (options.stage === "reviewer") {
          reviewCallCount++;
          const verdict =
            reviewCallCount === 1
              ? "<verdict>NEEDS_REFACTOR</verdict>"
              : "<verdict>PASS</verdict>";
          writeReviewerArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            verdict,
            options.iteration ?? 1,
            refactorHasRun
          );
        } else if (options.stage === "refactor") {
          refactorHasRun = true;
          writeRefactorArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            options.iteration ?? 1
          );
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    await runReviewWithRefactorLoop(makeBaseLoopOptions({ executionProvider }));

    const iteration2Path = join(
      WORKTREE_PATH,
      ".pourkit",
      ".tmp",
      "reviewers",
      "iteration-2.md"
    );
    expect(existsSync(iteration2Path)).toBe(true);
    expect(readFileSync(iteration2Path, "utf-8")).toContain(
      "<verdict>PASS</verdict>"
    );
  });

  it("does not run verification commands after refactor", async () => {
    let reviewCallCount = 0;
    let refactorHasRun = false;
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        if (options.stage === "reviewer") {
          reviewCallCount++;
          const verdict =
            reviewCallCount === 1
              ? "<verdict>NEEDS_REFACTOR</verdict>"
              : "<verdict>PASS</verdict>";
          writeReviewerArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            verdict,
            options.iteration ?? 1,
            refactorHasRun
          );
        } else if (options.stage === "refactor") {
          refactorHasRun = true;
          writeRefactorArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            options.iteration ?? 1
          );
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    await runReviewWithRefactorLoop(
      makeBaseLoopOptions({
        executionProvider,
        target: makeLoopTargetWithVerify(),
      })
    );

    expect(execCaptureMock).not.toHaveBeenCalledWith(
      "bash",
      ["-lc", "npm run typecheck"],
      expect.objectContaining({ label: "verify typecheck" })
    );
  });

  it("returns review lifecycle data after refactor execution", async () => {
    let reviewCallCount = 0;
    let refactorHasRun = false;
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        if (options.stage === "reviewer") {
          reviewCallCount++;
          writeReviewerArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            reviewCallCount === 1
              ? "<verdict>NEEDS_REFACTOR</verdict>"
              : "<verdict>PASS</verdict>",
            options.iteration ?? 1,
            refactorHasRun
          );
        } else if (options.stage === "refactor") {
          refactorHasRun = true;
          writeRefactorArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            options.iteration ?? 1
          );
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    const result = await runReviewWithRefactorLoop(
      makeBaseLoopOptions({
        executionProvider,
        target: makeLoopTargetWithVerify(),
      })
    );

    expect(result.verdict).toBe("PASS");
    expect(result.lifetimeIterations).toBe(2);
    expect(result.iterations).toBe(2);
    expect(result.exhaustedMaxIterations).toBe(false);
    expect(result.refactorCompletedForLastReview).toBe(false);
    expect(result.artifactPath).toContain("iteration-2.md");
  });

  it("does not run post-refactor verification even when verify commands are configured", async () => {
    const uniqueCommands: VerificationCommand[] = [
      { command: "npm run lint", label: "lint" },
      { command: "npm run typecheck", label: "typecheck" },
    ];

    let reviewCallCount = 0;
    let refactorHasRun = false;
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        if (options.stage === "reviewer") {
          reviewCallCount++;
          writeReviewerArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            reviewCallCount === 1
              ? "<verdict>NEEDS_REFACTOR</verdict>"
              : "<verdict>PASS</verdict>",
            options.iteration ?? 1,
            refactorHasRun
          );
        } else if (options.stage === "refactor") {
          refactorHasRun = true;
          writeRefactorArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            options.iteration ?? 1
          );
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    await runReviewWithRefactorLoop(
      makeBaseLoopOptions({
        executionProvider,
        target: makeLoopTargetWithVerify(uniqueCommands),
      })
    );

    const verifyCalls = execCaptureMock.mock.calls.filter(
      ([cmd]) => cmd === "bash"
    );
    expect(verifyCalls).toHaveLength(0);
  });

  it("skips post-refactor verification when target.strategy.verify is not defined", async () => {
    execCaptureMock.mockClear();

    let reviewCallCount = 0;
    let refactorHasRun = false;
    const executionProvider: ExecutionProvider = {
      execute: vi.fn(async (options) => {
        if (options.stage === "reviewer") {
          reviewCallCount++;
          writeReviewerArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            reviewCallCount === 1
              ? "<verdict>NEEDS_REFACTOR</verdict>"
              : "<verdict>PASS</verdict>",
            options.iteration ?? 1,
            refactorHasRun
          );
        } else if (options.stage === "refactor") {
          refactorHasRun = true;
          writeRefactorArtifact(
            options.worktreePath ?? WORKTREE_PATH,
            options.iteration ?? 1
          );
        }
        return {
          success: true,
          branch: "pourkit/42/test-issue",
          worktreePath: options.worktreePath ?? WORKTREE_PATH,
          commits: [],
          logPath: null,
        };
      }),
    };

    await runReviewWithRefactorLoop(
      makeBaseLoopOptions({
        executionProvider,
        target: makeTarget(),
      })
    );

    const verifyCalls = execCaptureMock.mock.calls.filter(
      ([cmd]) => cmd === "bash"
    );
    expect(verifyCalls).toHaveLength(0);
  });
});

describe("validateReviewArtifact", () => {
  it("accepts a valid findings table with multiple rows", () => {
    const output = [
      "## Findings",
      "",
      "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
      "|----|------------|----------|-----------|-------|----------------|",
      "| R1.F1 | - | high | foo.ts:10 | Bug | Fix it |",
      "| R1.F2 | - | low | bar.ts:20 | Style | Clean it |",
      "",
      "<verdict>NEEDS_REFACTOR</verdict>",
    ].join("\n");

    expect(() =>
      validateReviewArtifact(output, "NEEDS_REFACTOR", 1)
    ).not.toThrow();
  });

  it("rejects a finding row with an invalid Supersedes value", () => {
    const output = [
      "## Findings",
      "",
      "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
      "|----|------------|----------|-----------|-------|----------------|",
      "| R1.F1 | invalid | high | foo.ts:10 | Bug | Fix it |",
      "",
      "<verdict>NEEDS_REFACTOR</verdict>",
    ].join("\n");

    expect(() => validateReviewArtifact(output, "NEEDS_REFACTOR", 1)).toThrow(
      ReviewArtifactValidationError
    );
  });

  it("accepts a finding row with Supersedes referencing a valid finding ID", () => {
    const output = [
      "## Findings",
      "",
      "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
      "|----|------------|----------|-----------|-------|----------------|",
      "| R2.F1 | R1.F3 | high | foo.ts:10 | Bug | Fix it |",
      "",
      "<verdict>NEEDS_REFACTOR</verdict>",
    ].join("\n");

    expect(() =>
      validateReviewArtifact(output, "NEEDS_REFACTOR", 2)
    ).not.toThrow();
  });

  it("accepts a no-findings row with none", () => {
    const output = [
      "## Findings",
      "",
      "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
      "|----|------------|----------|-----------|-------|----------------|",
      "| none | n/a | n/a | n/a | No findings. | n/a |",
      "",
      "<verdict>PASS</verdict>",
    ].join("\n");

    expect(() => validateReviewArtifact(output, "PASS", 1)).not.toThrow();
  });

  it("rejects a finding row where the ID cell is for the wrong iteration even if another cell contains a current-iteration ID", () => {
    const output = [
      "## Findings",
      "",
      "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
      "|----|------------|----------|-----------|-------|----------------|",
      "| R1.F3 | R2.F1 | high | foo.ts:10 | Bug | Fix it |",
      "",
      "<verdict>NEEDS_REFACTOR</verdict>",
    ].join("\n");

    expect(() => validateReviewArtifact(output, "NEEDS_REFACTOR", 2)).toThrow(
      ReviewArtifactValidationError
    );
  });

  it("rejects a finding row whose issue text contains 'none' but has an invalid ID", () => {
    const output = [
      "## Findings",
      "",
      "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
      "|----|------------|----------|-----------|-------|----------------|",
      "| INVALID | - | high | foo.ts:10 | has none of the required tests | Fix it |",
      "",
      "<verdict>NEEDS_REFACTOR</verdict>",
    ].join("\n");

    expect(() => validateReviewArtifact(output, "NEEDS_REFACTOR", 2)).toThrow(
      ReviewArtifactValidationError
    );
  });

  it("rejects a Supersedes cell with a valid ID followed by garbage", () => {
    const output = [
      "## Findings",
      "",
      "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
      "|----|------------|----------|-----------|-------|----------------|",
      "| R2.F1 | R1.F3 garbage | high | foo.ts:10 | Bug | Fix it |",
      "",
      "<verdict>NEEDS_REFACTOR</verdict>",
    ].join("\n");

    expect(() => validateReviewArtifact(output, "NEEDS_REFACTOR", 2)).toThrow(
      ReviewArtifactValidationError
    );
  });

  it("rejects a Supersedes cell with a prefix before a valid ID", () => {
    const output = [
      "## Findings",
      "",
      "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
      "|----|------------|----------|-----------|-------|----------------|",
      "| R2.F1 | prefix R1.F3 | high | foo.ts:10 | Bug | Fix it |",
      "",
      "<verdict>NEEDS_REFACTOR</verdict>",
    ].join("\n");

    expect(() => validateReviewArtifact(output, "NEEDS_REFACTOR", 2)).toThrow(
      ReviewArtifactValidationError
    );
  });

  it("rejects an artifact without a Findings section", () => {
    const output = "<verdict>PASS</verdict>";

    expect(() => validateReviewArtifact(output, "PASS", 1)).toThrow(
      ReviewArtifactValidationError
    );
  });

  it("rejects an artifact with an empty Findings section", () => {
    const output = ["## Findings", "", "<verdict>PASS</verdict>"].join("\n");

    expect(() => validateReviewArtifact(output, "PASS", 1)).toThrow(
      ReviewArtifactValidationError
    );
  });

  it("rejects a NEEDS_HUMAN artifact missing Human Handoff Summary", () => {
    const output = [
      "## Findings",
      "",
      "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
      "|----|------------|----------|-----------|-------|----------------|",
      "| R1.F1 | - | high | foo.ts:10 | Bug | Fix it |",
      "",
      "## Human Handoff Reason",
      "",
      "Human must decide.",
      "",
      "<verdict>NEEDS_HUMAN</verdict>",
    ].join("\n");

    expect(() => validateReviewArtifact(output, "NEEDS_HUMAN", 1)).toThrow(
      ReviewArtifactValidationError
    );
  });

  it("rejects a NEEDS_HUMAN artifact missing Human Handoff Reason", () => {
    const output = [
      "## Findings",
      "",
      "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
      "|----|------------|----------|-----------|-------|----------------|",
      "| R1.F1 | - | high | foo.ts:10 | Bug | Fix it |",
      "",
      "## Human Handoff Summary",
      "",
      "Summary here.",
      "",
      "<verdict>NEEDS_HUMAN</verdict>",
    ].join("\n");

    expect(() => validateReviewArtifact(output, "NEEDS_HUMAN", 1)).toThrow(
      ReviewArtifactValidationError
    );
  });
});

describe("extractLatestFindingIds", () => {
  it("extracts findings matching the current iteration", () => {
    const output = [
      "## Findings",
      "",
      "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
      "|----|------------|----------|-----------|-------|----------------|",
      "| R2.F1 | - | high | foo.ts:10 | Bug | Fix it |",
      "| R2.F2 | R1.F1 | low | bar.ts:20 | Style | Clean it |",
      "",
      "<verdict>NEEDS_REFACTOR</verdict>",
    ].join("\n");

    const ids = extractLatestFindingIds(output, 2);
    expect(ids).toEqual(["R2.F1", "R2.F2"]);
  });

  it("returns empty array for no-findings row", () => {
    const output = [
      "## Findings",
      "",
      "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
      "|----|------------|----------|-----------|-------|----------------|",
      "| none | n/a | n/a | n/a | No findings. | n/a |",
      "",
      "<verdict>PASS</verdict>",
    ].join("\n");

    const ids = extractLatestFindingIds(output, 1);
    expect(ids).toEqual([]);
  });

  it("ignores findings from other iterations", () => {
    const output = [
      "## Findings",
      "",
      "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
      "|----|------------|----------|-----------|-------|----------------|",
      "| R1.F1 | - | high | foo.ts:10 | Bug | Fix it |",
      "| R2.F1 | R1.F1 | medium | bar.ts:20 | Issue | Address |",
      "",
      "<verdict>NEEDS_REFACTOR</verdict>",
    ].join("\n");

    const ids = extractLatestFindingIds(output, 2);
    expect(ids).toEqual(["R2.F1"]);
  });
});

describe("validateRefactorArtifact", () => {
  const TMP = "/tmp/pourkit-refactor-validation-test";

  beforeEach(() => {
    if (existsSync(TMP)) {
      rmSync(TMP, { recursive: true });
    }
    mkdirSync(TMP, { recursive: true });
  });

  function writeArtifact(content: string): string {
    const path = join(TMP, "artifact.md");
    writeFileSync(path, content, "utf-8");
    return path;
  }

  it("accepts a valid refactor artifact with all required sections", () => {
    const content = [
      "## Finding Responses",
      "",
      "| Finding ID | Classification | Rationale | Files Changed |",
      "|------------|----------------|-----------|---------------|",
      "| R1.F1 | accepted | Fixed | src/test.ts |",
      "",
      "## Verification",
      "",
      "| Command | Result | Notes |",
      "|---------|--------|-------|",
      "| npm test | passed | All good |",
      "",
      "## Open Blockers",
      "",
      "| Blocker | Needed From |",
      "|---------|-------------|",
      "| none | n/a |",
      "",
    ].join("\n");

    const path = writeArtifact(content);
    expect(() => validateRefactorArtifact(path, ["R1.F1"])).not.toThrow();
  });

  it("accepts an optional Advisory Analyzer Responses section", () => {
    const content = [
      "## Finding Responses",
      "",
      "| Finding ID | Classification | Rationale | Files Changed |",
      "|------------|----------------|-----------|---------------|",
      "| R1.F1 | accepted | Fixed | src/test.ts |",
      "",
      "## Verification",
      "",
      "| Command | Result | Notes |",
      "|---------|--------|-------|",
      "| npm test | passed | All good |",
      "",
      "## Advisory Analyzer Responses",
      "",
      "| Advisory Finding ID | Classification | Rationale | Files Changed |",
      "|---------------------|----------------|-----------|---------------|",
      "| A1 | rejected | Not in selected issue scope | none |",
      "",
      "## Open Blockers",
      "",
      "| Blocker | Needed From |",
      "|---------|-------------|",
      "| none | n/a |",
      "",
    ].join("\n");

    const path = writeArtifact(content);
    expect(() => validateRefactorArtifact(path, ["R1.F1"])).not.toThrow();
  });

  it("accepts any advisory analyzer response classifications", () => {
    const content = [
      "## Finding Responses",
      "",
      "| Finding ID | Classification | Rationale | Files Changed |",
      "|------------|----------------|-----------|---------------|",
      "| R1.F1 | accepted | Fixed | src/test.ts |",
      "",
      "## Verification",
      "",
      "| Command | Result | Notes |",
      "|---------|--------|-------|",
      "| npm test | passed | All good |",
      "",
      "## Advisory Analyzer Responses",
      "",
      "| Advisory Finding ID | Classification | Rationale | Files Changed |",
      "|---------------------|----------------|-----------|---------------|",
      "| A1 | invalid | Bad classification | src/test.ts |",
      "",
      "## Open Blockers",
      "",
      "| Blocker | Needed From |",
      "|---------|-------------|",
      "| none | n/a |",
      "",
    ].join("\n");

    const path = writeArtifact(content);
    expect(() => validateRefactorArtifact(path, ["R1.F1"])).not.toThrow();
  });

  it("accepts no-findings sentinel in advisory analyzer responses", () => {
    const content = [
      "## Finding Responses",
      "",
      "| Finding ID | Classification | Rationale | Files Changed |",
      "|------------|----------------|-----------|---------------|",
      "| R1.F1 | accepted | Fixed | src/test.ts |",
      "",
      "## Verification",
      "",
      "| Command | Result | Notes |",
      "|---------|--------|-------|",
      "| npm test | passed | All good |",
      "",
      "## Advisory Analyzer Responses",
      "",
      "| Advisory Finding ID | Classification | Rationale | Files Changed |",
      "|---------------------|----------------|-----------|---------------|",
      "| - | accepted (no findings) | No advisory findings. | none |",
      "",
      "## Open Blockers",
      "",
      "| Blocker | Needed From |",
      "|---------|-------------|",
      "| none | n/a |",
      "",
    ].join("\n");

    const path = writeArtifact(content);
    expect(() => validateRefactorArtifact(path, ["R1.F1"])).not.toThrow();
  });

  it("rejects missing artifact", () => {
    expect(() => validateRefactorArtifact("/nonexistent/path.md", [])).toThrow(
      RefactorArtifactValidationError
    );
  });

  it("rejects empty artifact", () => {
    const path = writeArtifact("");
    expect(() => validateRefactorArtifact(path, [])).toThrow(
      RefactorArtifactValidationError
    );
  });

  it("rejects artifact missing Finding Responses section", () => {
    const content = ["## Verification", "", "## Open Blockers", ""].join("\n");
    const path = writeArtifact(content);
    expect(() => validateRefactorArtifact(path, [])).toThrow(
      RefactorArtifactValidationError
    );
  });

  it("rejects artifact missing Verification section", () => {
    const content = ["## Finding Responses", "", "## Open Blockers", ""].join(
      "\n"
    );
    const path = writeArtifact(content);
    expect(() => validateRefactorArtifact(path, [])).toThrow(
      RefactorArtifactValidationError
    );
  });

  it("rejects artifact missing Open Blockers section", () => {
    const content = ["## Finding Responses", "", "## Verification", ""].join(
      "\n"
    );
    const path = writeArtifact(content);
    expect(() => validateRefactorArtifact(path, [])).toThrow(
      RefactorArtifactValidationError
    );
  });

  it("rejects artifact with ### headings instead of ## headings", () => {
    const content = [
      "### Finding Responses",
      "",
      "| Finding ID | Classification | Rationale | Files Changed |",
      "|------------|----------------|-----------|---------------|",
      "| R1.F1 | accepted | Fixed | src/test.ts |",
      "",
      "### Verification",
      "",
      "| Command | Result | Notes |",
      "|---------|--------|-------|",
      "| npm test | passed | All good |",
      "",
      "### Open Blockers",
      "",
      "| Blocker | Needed From |",
      "|---------|-------------|",
      "| none | n/a |",
      "",
    ].join("\n");
    const path = writeArtifact(content);
    expect(() => validateRefactorArtifact(path, ["R1.F1"])).toThrow(
      RefactorArtifactValidationError
    );
  });

  it("rejects missing finding response for a required finding ID", () => {
    const content = [
      "## Finding Responses",
      "",
      "| Finding ID | Classification | Rationale | Files Changed |",
      "|------------|----------------|-----------|---------------|",
      "| R1.F1 | accepted | Fixed | src/test.ts |",
      "",
      "## Verification",
      "",
      "| Command | Result | Notes |",
      "|---------|--------|-------|",
      "| npm test | passed | All good |",
      "",
      "## Open Blockers",
      "",
      "| Blocker | Needed From |",
      "|---------|-------------|",
      "| none | n/a |",
      "",
    ].join("\n");
    const path = writeArtifact(content);
    expect(() => validateRefactorArtifact(path, ["R1.F1", "R1.F2"])).toThrow(
      RefactorArtifactValidationError
    );
  });

  it("rejects invalid classification for a finding response", () => {
    const content = [
      "## Finding Responses",
      "",
      "| Finding ID | Classification | Rationale | Files Changed |",
      "|------------|----------------|-----------|---------------|",
      "| R1.F1 | invalid | Fixed | src/test.ts |",
      "",
      "## Verification",
      "",
      "| Command | Result | Notes |",
      "|---------|--------|-------|",
      "| npm test | passed | All good |",
      "",
      "## Open Blockers",
      "",
      "| Blocker | Needed From |",
      "|---------|-------------|",
      "| none | n/a |",
      "",
    ].join("\n");
    const path = writeArtifact(content);
    expect(() => validateRefactorArtifact(path, ["R1.F1"])).toThrow(
      RefactorArtifactValidationError
    );
  });

  it("accepts all valid classifications", () => {
    for (const classification of [
      "accepted",
      "rejected",
      "deferred",
      "blocked",
    ]) {
      const content = [
        "## Finding Responses",
        "",
        "| Finding ID | Classification | Rationale | Files Changed |",
        "|------------|----------------|-----------|---------------|",
        `| R1.F1 | ${classification} | Reason | src/test.ts |`,
        "",
        "## Verification",
        "",
        "| Command | Result | Notes |",
        "|---------|--------|-------|",
        "| npm test | passed | All good |",
        "",
        "## Open Blockers",
        "",
        "| Blocker | Needed From |",
        "|---------|-------------|",
        "| none | n/a |",
        "",
      ].join("\n");
      const path = writeArtifact(content);
      expect(() => validateRefactorArtifact(path, ["R1.F1"])).not.toThrow();
    }
  });

  it("accepts a backticked accepted classification", () => {
    const content = [
      "## Finding Responses",
      "",
      "| Finding ID | Classification | Rationale | Files Changed |",
      "|------------|----------------|-----------|---------------|",
      "| R1.F1 | `accepted` | Fixed | src/test.ts |",
      "",
      "## Verification",
      "",
      "| Command | Result | Notes |",
      "|---------|--------|-------|",
      "| npm test | passed | All good |",
      "",
      "## Open Blockers",
      "",
      "| Blocker | Needed From |",
      "|---------|-------------|",
      "| none | n/a |",
      "",
    ].join("\n");

    const path = writeArtifact(content);
    expect(() => validateRefactorArtifact(path, ["R1.F1"])).not.toThrow();
  });

  it("rejects uppercase or mixed-case classifications", () => {
    const invalidClassifications = [
      "Accepted",
      "ACCEPTED",
      "Rejected",
      "Deferred",
      "Blocked",
    ];
    for (const classification of invalidClassifications) {
      const content = [
        "## Finding Responses",
        "",
        "| Finding ID | Classification | Rationale | Files Changed |",
        "|------------|----------------|-----------|---------------|",
        `| R1.F1 | ${classification} | Reason | src/test.ts |`,
        "",
        "## Verification",
        "",
        "| Command | Result | Notes |",
        "|---------|--------|-------|",
        "| npm test | passed | All good |",
        "",
        "## Open Blockers",
        "",
        "| Blocker | Needed From |",
        "|---------|-------------|",
        "| none | n/a |",
        "",
      ].join("\n");
      const path = writeArtifact(content);
      expect(() => validateRefactorArtifact(path, ["R1.F1"])).toThrow(
        RefactorArtifactValidationError
      );
    }
  });

  it("skips per-finding validation when findingIds is empty", () => {
    const content = [
      "## Finding Responses",
      "",
      "## Verification",
      "",
      "## Open Blockers",
      "",
    ].join("\n");
    const path = writeArtifact(content);
    expect(() => validateRefactorArtifact(path, [])).not.toThrow();
  });
});
