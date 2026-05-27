import { expect, it } from "vitest";
import { assertIssueLabels, lookupPrByBranch } from "./harness";
import { createLiveScenario, describeLive } from "./scenario-test-support";

describeLive("live E2E PR creation and merge", () => {
  it("creates PR on recreated target branch", async () => {
    const scenario = await createLiveScenario({
      prInjections: {
        waitForChecksError: "stop after opening PR",
      },
    });

    try {
      await expect(scenario.runIssue()).rejects.toThrow(
        "stop after opening PR"
      );
      const pr = await lookupPrByBranch(
        scenario.expectedBranchName,
        scenario.client
      );
      expect(pr).not.toBeNull();
      expect(pr?.baseRefName).toBe(scenario.resources.targetBranch);
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);

  it("waits for checks before merge", async () => {
    const scenario = await createLiveScenario({
      prInjections: {
        requireWaitForChecksBeforeMerge: true,
      },
    });
    scenario.prProvider.setExpectedLabelBeforeMerge(
      scenario.issue.number,
      "pr-open-awaiting-merge"
    );

    try {
      await scenario.runIssue();
      expect(scenario.prProvider.waitForPrChecksCalls).toBe(1);
      expect(scenario.prProvider.mergeCalls).toBe(1);
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);

  it("merges only after checks pass", async () => {
    const scenario = await createLiveScenario({
      prInjections: {
        requireWaitForChecksBeforeMerge: true,
      },
    });

    try {
      const result = await scenario.runIssue();
      const pr = await lookupPrByBranch(result.branchName, scenario.client);

      expect(pr?.state).toBe("MERGED");
      expect(scenario.prProvider.waitForPrChecksCalls).toBe(1);
      await assertIssueLabels(
        scenario.issue.number,
        {
          absent: ["pr-open-awaiting-merge", "agent-in-progress"],
        },
        scenario.client
      );
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);
});
