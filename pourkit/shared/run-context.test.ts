import { describe, it, expect } from "vitest";
import {
  RUN_CONTEXT_PATH_IN_WORKTREE,
  buildRunContextMarkdown,
  STAGE_SECTIONS,
  ALL_RUN_CONTEXT_SECTIONS,
} from "./run-context";
import type { IssueData, Target } from "./config";

const stubIssue: IssueData = {
  number: 42,
  title: "Test issue",
  body: "Some body text",
  state: "open",
  labels: ["ready-for-agent"],
  comments: ["First comment", "Second comment\n\nWith detail"],
};

const stubTarget: Target = {
  name: "default",
  baseBranch: "main",
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
    verify: {
      commands: [
        { command: "npm test", label: "tests" },
        { command: "npm run build", label: "build" },
      ],
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

describe("buildRunContextMarkdown", () => {
  it("includes all sections when sections param is omitted", () => {
    expect(stubTarget).not.toHaveProperty("verificationCommands");
    const result = buildRunContextMarkdown({
      issue: stubIssue,
      target: stubTarget,
      branchName: "pourkit/42/test-issue",
      reviewerCriteria: ["correctness"],
    });

    expect(result).toContain("## Issue");
    expect(result).toContain("## Comments");
    expect(result).toContain("## Branch");
    expect(result).toContain("## Verification Commands");
    expect(result).toContain(
      "Run these commands from the repository root exactly as written. Do not substitute equivalent scripts from nested package.json files."
    );
    expect(result).toContain("## Review Criteria");
    expect(result).toContain("## Artifacts");
    expect(result).not.toContain("Builder handoff dir");
  });

  it("excludes sections not in the provided list", () => {
    const result = buildRunContextMarkdown({
      issue: stubIssue,
      target: stubTarget,
      branchName: "pourkit/42/test-issue",
      reviewerCriteria: ["correctness"],
      sections: ["issue", "comments", "branch"],
    });

    expect(result).toContain("## Issue");
    expect(result).toContain("## Comments");
    expect(result).toContain("## Branch");
    expect(result).not.toContain("## Verification Commands");
    expect(result).not.toContain("## Review Criteria");
    expect(result).not.toContain("## Artifacts");
  });

  it("excludes review criteria when not in sections even if criteria are provided", () => {
    const result = buildRunContextMarkdown({
      issue: stubIssue,
      target: stubTarget,
      branchName: "pourkit/42/test-issue",
      reviewerCriteria: ["correctness", "scope"],
      sections: [
        "issue",
        "comments",
        "branch",
        "verification-commands",
        "artifacts",
      ],
    });

    expect(result).not.toContain("## Review Criteria");
  });

  it("includes verification commands in builder-stage run context", () => {
    const result = buildRunContextMarkdown({
      issue: stubIssue,
      target: stubTarget,
      branchName: "pourkit/42/test-issue",
      reviewerCriteria: ["correctness"],
      sections: STAGE_SECTIONS.builder,
    });

    expect(result).toContain("## Verification Commands");
    expect(result).toContain("- tests: `npm test`");
    expect(result).toContain("- build: `npm run build`");
  });

  it("produces empty body between header and footer when no sections match", () => {
    const result = buildRunContextMarkdown({
      issue: stubIssue,
      target: stubTarget,
      branchName: "pourkit/42/test-issue",
      sections: [],
    });

    expect(result).toBe("# Pourkit Run Context\n");
  });
});

describe("STAGE_SECTIONS", () => {
  it("builder excludes review-criteria", () => {
    expect(STAGE_SECTIONS.builder).not.toContain("review-criteria");
    expect(STAGE_SECTIONS.builder).toContain("issue");
    expect(STAGE_SECTIONS.builder).toContain("comments");
    expect(STAGE_SECTIONS.builder).toContain("branch");
    expect(STAGE_SECTIONS.builder).toContain("verification-commands");
    expect(STAGE_SECTIONS.builder).toContain("artifacts");
  });

  it("reviewer includes all builder sections plus review-criteria", () => {
    expect(STAGE_SECTIONS.reviewer).toContain("review-criteria");
    for (const section of STAGE_SECTIONS.builder) {
      expect(STAGE_SECTIONS.reviewer).toContain(section);
    }
  });

  it("refactor includes all builder sections plus review-criteria", () => {
    expect(STAGE_SECTIONS.refactor).toContain("review-criteria");
    for (const section of STAGE_SECTIONS.builder) {
      expect(STAGE_SECTIONS.refactor).toContain(section);
    }
  });

  it("finalizer includes all builder sections plus review-criteria", () => {
    expect(STAGE_SECTIONS.finalizer).toContain("review-criteria");
    for (const section of STAGE_SECTIONS.builder) {
      expect(STAGE_SECTIONS.finalizer).toContain(section);
    }
  });

  it("conflictResolution includes builder sections without review-criteria", () => {
    expect(STAGE_SECTIONS.conflictResolution).toEqual([
      "issue",
      "comments",
      "branch",
      "verification-commands",
      "artifacts",
    ]);
    expect(STAGE_SECTIONS.conflictResolution).not.toContain("review-criteria");
  });
});

describe("ALL_RUN_CONTEXT_SECTIONS", () => {
  it("contains every section from every stage", () => {
    const allStageSections = new Set(Object.values(STAGE_SECTIONS).flat());
    for (const section of allStageSections) {
      expect(ALL_RUN_CONTEXT_SECTIONS).toContain(section);
    }
  });
});

describe("RUN_CONTEXT_PATH_IN_WORKTREE", () => {
  it("is the canonical .pourkit/.tmp/run-context.md path", () => {
    expect(RUN_CONTEXT_PATH_IN_WORKTREE).toBe(".pourkit/.tmp/run-context.md");
  });
});
