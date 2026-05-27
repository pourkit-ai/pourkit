import { expect, it } from "vitest";
import {
  assertIssueLabels,
  lookupPrByBranch,
  worktreeExistsForBranch,
} from "./harness";
import {
  createLiveScenario,
  describeLive,
  resolveLivePrTitle,
} from "./scenario-test-support";

describeLive("live E2E finalizer stage", () => {
  it("generates PR title and body successfully", async () => {
    const title = resolveLivePrTitle("finalizer-stage");

    const scenario = await createLiveScenario({
      executionInjections: {
        finalizer: {
          title,
          body: "Live finalizer body",
        },
      },
      prInjections: {
        waitForChecksError: "stop after PR creation",
      },
    });

    try {
      await expect(scenario.runIssue()).rejects.toThrow(
        "stop after PR creation"
      );
      const pr = await lookupPrByBranch(
        scenario.expectedBranchName,
        scenario.client
      );
      expect(pr).not.toBeNull();
      expect(pr?.title).toBe(title);
      expect(pr?.body).toContain("Live finalizer body");
      expect(pr?.body).toContain(`Closes #${scenario.issue.number}`);
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);

  it("fails finalizer and transitions to ready-for-human", async () => {
    const scenario = await createLiveScenario({
      executionInjections: {
        finalizer: { error: "finalizer crashed" },
      },
    });

    try {
      await expect(scenario.runIssue()).rejects.toThrow(
        "Finalizer agent execution failed: finalizer crashed"
      );
      expect(
        await lookupPrByBranch(scenario.expectedBranchName, scenario.client)
      ).toBeNull();
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

  it("resumes finalizer after finalizer failure", async () => {
    const title = resolveLivePrTitle("finalizer-resume");
    const scenario = await createLiveScenario({
      executionInjections: {
        reviewer: { verdicts: ["PASS"] },
        finalizer: { error: "finalizer crashed" },
      },
      prInjections: {
        waitForChecksError: "stop after PR creation",
      },
    });

    try {
      await expect(scenario.runIssue()).rejects.toThrow(
        "Finalizer agent execution failed: finalizer crashed"
      );

      const exists = await worktreeExistsForBranch(scenario.expectedBranchName);
      expect(exists).toBe(true);

      scenario.executionProvider.resetRunTracking();
      delete scenario.executionProvider.injections.finalizer!.error;

      await expect(scenario.rerunIssue({ force: true })).rejects.toThrow(
        "stop after PR creation"
      );

      expect(scenario.executionProvider.stageCalls).not.toContain("builder");
      expect(scenario.executionProvider.stageCalls).not.toContain("reviewer");
      expect(scenario.executionProvider.stageCalls).toContain("finalizer");

      const pr = await lookupPrByBranch(
        scenario.expectedBranchName,
        scenario.client
      );
      expect(pr).not.toBeNull();
      expect(pr?.title).toBe(title);
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);
});
