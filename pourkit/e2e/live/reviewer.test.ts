import path from "node:path";
import { expect, it } from "vitest";
import {
  assertIssueLabels,
  fileExists,
  localBranchExists,
  worktreeExistsForBranch,
  worktreePathForBranch,
} from "./harness";
import { createLiveScenario, describeLive } from "./scenario-test-support";

describeLive("live E2E reviewer stage", () => {
  it("passes reviewer and continues", async () => {
    const scenario = await createLiveScenario({
      executionInjections: {
        reviewer: { verdicts: ["PASS"] },
        finalizer: { error: "stop after reviewer pass" },
      },
    });

    try {
      await expect(scenario.runIssue()).rejects.toThrow(
        "Finalizer agent execution failed: stop after reviewer pass"
      );
      expect(scenario.executionProvider.stageCalls).toEqual([
        "builder",
        "reviewer",
        "finalizer",
      ]);
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);

  it("reworks after FAIL then passes", async () => {
    const scenario = await createLiveScenario({
      executionInjections: {
        reviewer: { verdicts: ["FAIL", "PASS"] },
        finalizer: { error: "stop after fail refactor loop" },
      },
    });

    try {
      await expect(scenario.runIssue()).rejects.toThrow(
        "Finalizer agent execution failed: stop after fail refactor loop"
      );
      expect(scenario.executionProvider.stageCalls).toEqual([
        "builder",
        "reviewer",
        "refactor",
        "reviewer",
        "finalizer",
      ]);
      expect(scenario.executionProvider.refactorIterations).toEqual([1]);
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);

  it("reworks after NEEDS_REFACTOR then passes", async () => {
    const scenario = await createLiveScenario({
      executionInjections: {
        reviewer: { verdicts: ["NEEDS_REFACTOR", "PASS"] },
        finalizer: { error: "stop after refactor loop" },
      },
    });

    try {
      await expect(scenario.runIssue()).rejects.toThrow(
        "Finalizer agent execution failed: stop after refactor loop"
      );
      expect(scenario.executionProvider.stageCalls).toEqual([
        "builder",
        "reviewer",
        "refactor",
        "reviewer",
        "finalizer",
      ]);
      expect(scenario.executionProvider.refactorIterations).toEqual([1]);
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);

  it("reworks after PASS_WITH_NOTES then passes", async () => {
    const scenario = await createLiveScenario({
      executionInjections: {
        reviewer: { verdicts: ["PASS_WITH_NOTES", "PASS"] },
        finalizer: { error: "stop after pass-with-notes" },
      },
    });

    try {
      await expect(scenario.runIssue()).rejects.toThrow(
        "Finalizer agent execution failed: stop after pass-with-notes"
      );
      expect(scenario.executionProvider.stageCalls).toEqual([
        "builder",
        "reviewer",
        "refactor",
        "reviewer",
        "finalizer",
      ]);
      expect(scenario.executionProvider.refactorIterations).toEqual([1]);
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);

  it("exhausts max review iterations and fails", async () => {
    const scenario = await createLiveScenario({
      executionInjections: {
        reviewer: { verdicts: ["NEEDS_REFACTOR", "NEEDS_REFACTOR"] },
      },
      mutateConfig: (config) => ({
        ...config,
        targets: config.targets.map((target) => ({
          ...target,
          strategy: {
            ...target.strategy!,
            review: {
              ...target.strategy!.review,
              maxIterations: 2,
            },
          },
        })),
      }),
    });

    try {
      await expect(scenario.runIssue()).rejects.toThrow(
        "Max review iterations (2) exhausted"
      );
      await assertIssueLabels(
        scenario.issue.number,
        {
          present: ["ready-for-human"],
          absent: ["agent-in-progress"],
        },
        scenario.client
      );
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);

  it("preserves worktree after exhausted review iterations", async () => {
    const scenario = await createLiveScenario({
      executionInjections: {
        reviewer: { verdicts: ["NEEDS_REFACTOR", "NEEDS_REFACTOR"] },
      },
      mutateConfig: (config) => ({
        ...config,
        targets: config.targets.map((target) => ({
          ...target,
          strategy: {
            ...target.strategy!,
            review: {
              ...target.strategy!.review,
              maxIterations: 2,
            },
          },
        })),
      }),
    });

    try {
      await expect(scenario.runIssue()).rejects.toThrow(
        "Max review iterations (2) exhausted"
      );

      const exists = await worktreeExistsForBranch(scenario.expectedBranchName);
      expect(exists).toBe(true);

      const wtPath = await worktreePathForBranch(scenario.expectedBranchName);
      expect(wtPath).not.toBeNull();
      const artifactExists = await fileExists(
        path.join(wtPath!, ".pourkit/.tmp/reviewers/iteration-1.md")
      );
      expect(artifactExists).toBe(true);
    } finally {
      await scenario.cleanup();
    }

    const existsAfterCleanup = await worktreeExistsForBranch(
      scenario.expectedBranchName
    );
    expect(existsAfterCleanup).toBe(false);

    const branchAfterCleanup = await localBranchExists(
      scenario.expectedBranchName
    );
    expect(branchAfterCleanup).toBe(false);
  }, 600_000);

  it("resumes review loop after previous exhaustion", async () => {
    const scenario = await createLiveScenario({
      executionInjections: {
        reviewer: { verdicts: ["NEEDS_REFACTOR", "NEEDS_REFACTOR"] },
      },
      mutateConfig: (config) => ({
        ...config,
        targets: config.targets.map((target) => ({
          ...target,
          strategy: {
            ...target.strategy!,
            review: {
              ...target.strategy!.review,
              maxIterations: 2,
            },
          },
        })),
      }),
    });

    try {
      await expect(scenario.runIssue()).rejects.toThrow(
        "Max review iterations (2) exhausted"
      );

      const exists = await worktreeExistsForBranch(scenario.expectedBranchName);
      expect(exists).toBe(true);

      const wtPath = await worktreePathForBranch(scenario.expectedBranchName);
      expect(wtPath).not.toBeNull();
      const artifactExists = await fileExists(
        path.join(wtPath!, ".pourkit/.tmp/reviewers/iteration-1.md")
      );
      expect(artifactExists).toBe(true);

      scenario.executionProvider.resetRunTracking();
      scenario.executionProvider.injections.reviewer!.verdicts = ["PASS"];
      scenario.executionProvider.injections.finalizer = {
        error: "stop after resumed review",
      };

      await expect(scenario.rerunIssue({ force: true })).rejects.toThrow(
        "Finalizer agent execution failed: stop after resumed review"
      );

      expect(scenario.executionProvider.stageCalls).not.toContain("builder");
      expect(scenario.executionProvider.stageCalls).toContain("reviewer");
    } finally {
      await scenario.cleanup();
    }

    const existsAfterCleanup = await worktreeExistsForBranch(
      scenario.expectedBranchName
    );
    expect(existsAfterCleanup).toBe(false);

    const branchAfterCleanup = await localBranchExists(
      scenario.expectedBranchName
    );
    expect(branchAfterCleanup).toBe(false);
  }, 600_000);
});
