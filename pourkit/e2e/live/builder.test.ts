import { expect, it } from "vitest";
import {
  assertIssueLabels,
  lookupPrByBranch,
  remoteBranchExists,
} from "./harness";
import { createLiveScenario, describeLive } from "./scenario-test-support";

describeLive("live E2E builder stage", () => {
  it("implements successfully and claims issue", async () => {
    const scenario = await createLiveScenario({
      executionInjections: {
        finalizer: { error: "stop after builder/reviewer" },
      },
    });

    try {
      await expect(scenario.runIssue()).rejects.toThrow(
        "Finalizer agent execution failed: stop after builder/reviewer"
      );
      expect(scenario.executionProvider.stageCalls).toContain("builder");
      expect(await remoteBranchExists(scenario.expectedBranchName)).toBe(false);
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);

  it("fails builder and transitions to ready-for-human", async () => {
    const scenario = await createLiveScenario({
      executionInjections: {
        builder: { error: "builder exploded" },
      },
    });

    try {
      await expect(scenario.runIssue()).rejects.toThrow(
        "Sandcastle failed: builder exploded"
      );
      await assertIssueLabels(
        scenario.issue.number,
        {
          present: ["ready-for-human"],
          absent: ["agent-in-progress", "pr-open-awaiting-merge"],
        },
        scenario.client
      );
      expect(
        await lookupPrByBranch(scenario.expectedBranchName, scenario.client)
      ).toBeNull();
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);
});
