import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  parsePrCreateArgs,
  validatePrCreateOptions,
  runPrCreateCommand,
} from "./pr-create";
import type { PourkitConfig } from "../shared/config";
import type { PourkitLogger } from "../shared/common";
import { DEFAULT_MANUAL_PR_BODY } from "../pr/pr-body";

const { readFileMock, runPrWorkflowMock, createLoggerMock } = vi.hoisted(
  () => ({
    readFileMock: vi.fn(),
    runPrWorkflowMock: vi.fn().mockResolvedValue({
      baseBranch: "next",
      currentBranch: "agent/test",
      root: "/fake/root",
      prNumber: 42,
      prUrl: "https://github.com/test/repo/pull/42",
    }),
    createLoggerMock: vi.fn().mockReturnValue({
      step: vi.fn(),
      line: vi.fn(),
      raw: vi.fn(),
      status: vi.fn(),
      kv: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  })
);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: readFileMock,
  };
});

vi.mock("../pr/pr-workflow", () => ({
  runPrWorkflow: runPrWorkflowMock,
}));

vi.mock("../shared/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/common")>();
  return {
    ...actual,
    createLogger: createLoggerMock,
  };
});

const makeConfig = (
  overrides: Partial<PourkitConfig["targets"][0]> = {}
): PourkitConfig => ({
  targets: [
    {
      name: "test",
      baseBranch: "main",
      branchTemplate: "pourkit/{{issue.number}}/{{issue.slug}}",
      strategy: {
        type: "review-refactor-loop",
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
      ...overrides,
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

describe("parsePrCreateArgs", () => {
  it("parses minimal valid invocation", () => {
    const { options, remaining } = parsePrCreateArgs([
      "--target",
      "test",
      "--title",
      "Add feature",
    ]);

    expect(options.target).toBe("test");
    expect(options.title).toBe("Add feature");
    expect(options.base).toBeUndefined();
    expect(options.head).toBeUndefined();
    expect(options.body).toBeUndefined();
    expect(options.bodyFile).toBeUndefined();
    expect(options.issue).toBeUndefined();
    expect(remaining).toEqual([]);
  });

  it("parses optional flags", () => {
    const { options, remaining } = parsePrCreateArgs([
      "--target",
      "test",
      "--title",
      "Add feature",
      "--base",
      "develop",
      "--head",
      "feature/test",
      "--body",
      "Some body",
      "--body-file",
      "body.md",
      "--issue",
      "42",
    ]);

    expect(options.base).toBe("develop");
    expect(options.head).toBe("feature/test");
    expect(options.body).toBe("Some body");
    expect(options.bodyFile).toBe("body.md");
    expect(options.issue).toBe(42);
    expect(remaining).toEqual([]);
  });

  it("throws on repeated --issue flags", () => {
    expect(() =>
      parsePrCreateArgs([
        "--target",
        "test",
        "--title",
        "Add feature",
        "--issue",
        "42",
        "--issue",
        "43",
      ])
    ).toThrow("at most one --issue is allowed");
  });

  it("throws on invalid issue number", () => {
    expect(() =>
      parsePrCreateArgs([
        "--target",
        "test",
        "--title",
        "Add feature",
        "--issue",
        "not-a-number",
      ])
    ).toThrow("Invalid issue number: not-a-number");
  });

  it("throws on partial numeric issue number like 42abc", () => {
    expect(() =>
      parsePrCreateArgs([
        "--target",
        "test",
        "--title",
        "Add feature",
        "--issue",
        "42abc",
      ])
    ).toThrow("Invalid issue number: 42abc");
  });

  it("throws on float issue number like 1.5", () => {
    expect(() =>
      parsePrCreateArgs([
        "--target",
        "test",
        "--title",
        "Add feature",
        "--issue",
        "1.5",
      ])
    ).toThrow("Invalid issue number: 1.5");
  });

  it("throws when flag value is missing at end of args", () => {
    expect(() => parsePrCreateArgs(["--target"])).toThrow(
      "--target requires a value"
    );
  });

  it("throws when flag value is another flag", () => {
    expect(() =>
      parsePrCreateArgs(["--target", "--title", "Add feature"])
    ).toThrow("--target requires a value");
  });

  it("throws when --title value is another flag", () => {
    expect(() =>
      parsePrCreateArgs(["--target", "test", "--title", "--body", "some body"])
    ).toThrow("--title requires a value");
  });
});

describe("validatePrCreateOptions", () => {
  it("passes for valid options", () => {
    expect(() =>
      validatePrCreateOptions({
        target: "test",
        title: "Add feature",
      })
    ).not.toThrow();
  });

  it("throws when --target is missing", () => {
    expect(() =>
      validatePrCreateOptions({
        target: "" as unknown as string,
        title: "Add feature",
      })
    ).toThrow("--target is required");
  });

  it("throws when --title is missing", () => {
    expect(() =>
      validatePrCreateOptions({
        target: "test",
        title: "" as unknown as string,
      })
    ).toThrow("--title is required");
  });

  it("throws with multiple missing fields", () => {
    expect(() =>
      validatePrCreateOptions({
        target: "" as unknown as string,
        title: "" as unknown as string,
      })
    ).toThrow("--target is required; --title is required");
  });

  it("throws when --body and --body-file are both provided", () => {
    expect(() =>
      validatePrCreateOptions({
        target: "test",
        title: "Add feature",
        body: "Custom body",
        bodyFile: "body.md",
      })
    ).toThrow("--body and --body-file cannot be used together");
  });

  it("throws when --head is blank", () => {
    expect(() =>
      validatePrCreateOptions({
        target: "test",
        title: "Add feature",
        head: "   ",
      })
    ).toThrow("--head must be a non-empty string");
  });
});

const dummyProvider = {} as any;
const testConfig = makeConfig();

describe("runPrCreateCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("succeeds with minimal valid args", async () => {
    expect(testConfig.targets[0]).not.toHaveProperty("verificationCommands");
    const result = await runPrCreateCommand(
      ["--target", "test", "--title", "Add feature"],
      undefined,
      dummyProvider,
      testConfig
    );

    expect(result.config).toBeDefined();
    expect(result.target.name).toBe("test");
    expect(result.options.title).toBe("Add feature");
  });

  it("returns prNumber and prUrl from workflow", async () => {
    const result = await runPrCreateCommand(
      ["--target", "test", "--title", "Add feature"],
      undefined,
      dummyProvider,
      testConfig
    );

    expect(result.prNumber).toBe(42);
    expect(result.prUrl).toBe("https://github.com/test/repo/pull/42");
  });

  it("passes title and rendered body to workflow", async () => {
    await runPrCreateCommand(
      ["--target", "test", "--title", "My PR title", "--body", "Custom body"],
      undefined,
      dummyProvider,
      testConfig
    );

    expect(runPrWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "My PR title",
        body: "Custom body",
      })
    );
  });

  it("throws a clear error when prProvider is not provided", async () => {
    await expect(
      runPrCreateCommand(
        ["--target", "test", "--title", "Add feature"],
        undefined,
        undefined,
        testConfig
      )
    ).rejects.toThrow("PR provider is required to create a pull request");
  });

  it("throws a clear error when config is not provided", async () => {
    await expect(
      runPrCreateCommand(
        ["--target", "test", "--title", "Add feature"],
        undefined,
        dummyProvider
      )
    ).rejects.toThrow("Config is required");
  });

  it("passes rendered body template to workflow when no custom body", async () => {
    await runPrCreateCommand(
      ["--target", "test", "--title", "Add feature"],
      undefined,
      dummyProvider,
      testConfig
    );

    expect(runPrWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: DEFAULT_MANUAL_PR_BODY,
      })
    );
  });

  it("passes canonical summary and changes headings in default body", async () => {
    await runPrCreateCommand(
      ["--target", "test", "--title", "Add feature"],
      undefined,
      dummyProvider,
      testConfig
    );

    expect(runPrWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("## Summary"),
      })
    );
    expect(runPrWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("## Changes"),
      })
    );
  });

  it("rejects unsupported extra args", async () => {
    await expect(
      runPrCreateCommand(
        ["--target", "test", "--title", "Add feature", "--unknown-flag"],
        undefined,
        dummyProvider,
        testConfig
      )
    ).rejects.toThrow("Unsupported arguments: --unknown-flag");
  });

  it("rejects positional extra args", async () => {
    await expect(
      runPrCreateCommand(
        ["--target", "test", "--title", "Add feature", "extra"],
        undefined,
        dummyProvider,
        testConfig
      )
    ).rejects.toThrow("Unsupported arguments: extra");
  });

  it("rejects missing required args", async () => {
    await expect(
      runPrCreateCommand(
        ["--title", "Add feature"],
        undefined,
        dummyProvider,
        testConfig
      )
    ).rejects.toThrow("--target is required");
  });

  it("returns rendered body from template when no custom body provided", async () => {
    const result = await runPrCreateCommand(
      ["--target", "test", "--title", "Add feature"],
      undefined,
      dummyProvider,
      testConfig
    );

    expect(result.renderedBody).toBe(DEFAULT_MANUAL_PR_BODY);
    expect(result.renderedBody).toContain("## Summary");
    expect(result.renderedBody).toContain("## Changes");
  });

  it("returns custom body when --body is provided", async () => {
    const result = await runPrCreateCommand(
      [
        "--target",
        "test",
        "--title",
        "Add feature",
        "--body",
        "Custom body content",
      ],
      undefined,
      dummyProvider,
      testConfig
    );

    expect(result.renderedBody).toBe("Custom body content");
  });

  it("reads body from file when --body-file is provided", async () => {
    readFileMock.mockImplementation((path: string) => {
      if (path === "body.md") {
        return Promise.resolve("Body from file");
      }
      return Promise.resolve(JSON.stringify(makeConfig()));
    });

    const result = await runPrCreateCommand(
      ["--target", "test", "--title", "Add feature", "--body-file", "body.md"],
      undefined,
      dummyProvider,
      testConfig
    );

    expect(result.renderedBody).toBe("Body from file");
  });

  it("rejects --body and --body-file together", async () => {
    await expect(
      runPrCreateCommand(
        [
          "--target",
          "test",
          "--title",
          "Add feature",
          "--body",
          "Custom body",
          "--body-file",
          "body.md",
        ],
        undefined,
        dummyProvider,
        testConfig
      )
    ).rejects.toThrow("--body and --body-file cannot be used together");
  });

  it("appends closing ref for explicit --issue value", async () => {
    const result = await runPrCreateCommand(
      ["--target", "test", "--title", "Add feature", "--issue", "42"],
      undefined,
      dummyProvider,
      testConfig
    );

    expect(result.renderedBody).toContain("Closes #42");
  });

  it("rejects repeated --issue flags", async () => {
    await expect(
      runPrCreateCommand(
        [
          "--target",
          "test",
          "--title",
          "Add feature",
          "--issue",
          "42",
          "--issue",
          "43",
        ],
        undefined,
        dummyProvider,
        testConfig
      )
    ).rejects.toThrow("at most one --issue is allowed");
  });

  it("does not append closing refs when no --issue provided", async () => {
    const result = await runPrCreateCommand(
      ["--target", "test", "--title", "Add feature"],
      undefined,
      dummyProvider,
      testConfig
    );

    expect(result.renderedBody).not.toContain("Closes #");
  });

  it("returns baseBranch and currentBranch from workflow", async () => {
    const result = await runPrCreateCommand(
      ["--target", "test", "--title", "Add feature"],
      undefined,
      dummyProvider,
      testConfig
    );

    expect(result.baseBranch).toBe("next");
    expect(result.currentBranch).toBe("agent/test");
  });

  it("passes explicit base to workflow", async () => {
    await runPrCreateCommand(
      ["--target", "test", "--title", "Add feature", "--base", "main"],
      undefined,
      dummyProvider,
      testConfig
    );

    expect(runPrWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({ explicitBase: "main" })
    );
  });

  it("passes explicit head to workflow", async () => {
    await runPrCreateCommand(
      ["--target", "test", "--title", "Add feature", "--head", "agent/test"],
      undefined,
      dummyProvider,
      testConfig
    );

    expect(runPrWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({ explicitHead: "agent/test" })
    );
  });

  it("closes the internally created logger when no logger is provided", async () => {
    await runPrCreateCommand(
      ["--target", "test", "--title", "Add feature"],
      undefined,
      dummyProvider,
      testConfig
    );

    const loggerInstance = createLoggerMock.mock.results[0].value;
    expect(loggerInstance.close).toHaveBeenCalled();
  });

  it("does not close the logger when one is provided by caller", async () => {
    const providedLogger: PourkitLogger = {
      step: vi.fn(),
      line: vi.fn(),
      raw: vi.fn(),
      status: vi.fn(),
      kv: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await runPrCreateCommand(
      ["--target", "test", "--title", "Add feature"],
      providedLogger,
      dummyProvider,
      testConfig
    );

    expect(providedLogger.close).not.toHaveBeenCalled();
  });
});
