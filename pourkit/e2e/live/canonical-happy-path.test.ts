import { expect, it } from "vitest";
import {
  assertIssueLabels,
  getTargetBranchStatus,
  lookupPrByBranch,
} from "./harness";
import {
  createLiveScenario,
  describeLive,
  resolveLivePrTitle,
} from "./scenario-test-support";

describeLive("live E2E canonical happy path", () => {
  it("completes the full live flow", async () => {
    const title = resolveLivePrTitle("canonical-happy-path");

    const scenario = await createLiveScenario({
      executionInjections: {
        finalizer: {
          title,
          body: [
            "Canonical live path should green-light the target branch.",
            "",
            "e2e-check: pass",
          ].join("\n"),
        },
      },
    });

    try {
      const result = await scenario.runIssue();
      const pr = await lookupPrByBranch(result.branchName, scenario.client);
      const targetStatus = await getTargetBranchStatus(
        scenario.prProvider,
        scenario.resources.targetBranch ?? ""
      );

      expect(pr).not.toBeNull();
      expect(pr?.baseRefName).toBe(scenario.resources.targetBranch);
      expect(pr?.state).toBe("MERGED");
      expect(pr?.headRefName).toBe(result.branchName);
      expect(result.prNumber).toBeGreaterThan(0);
      expect(targetStatus.state).toBe("green");

      await assertIssueLabels(
        scenario.issue.number,
        {
          absent: [
            "ready-for-agent",
            "agent-in-progress",
            "pr-open-awaiting-merge",
            "ready-for-human",
          ],
        },
        scenario.client
      );
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);
});
