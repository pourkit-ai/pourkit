import { expect, it } from "vitest";
import { assertIssueLabels } from "./harness";
import { createLiveScenario, describeLive } from "./scenario-test-support";

describeLive("live E2E auto-merge opt-out", () => {
  it("hands off to a human when checks fail", async () => {
    const scenario = await createLiveScenario({
      mutateConfig: (config) => ({
        ...config,
        targets: config.targets.map((target) => ({
          ...target,
          autoMerge: false,
        })),
      }),
      prInjections: {
        waitForChecksError: "simulated check failure",
        requireWaitForChecksBeforeMerge: true,
      },
    });

    try {
      await expect(scenario.runIssue()).rejects.toThrow(
        "simulated check failure"
      );

      expect(scenario.prProvider.waitForPrChecksCalls).toBe(1);
      expect(scenario.prProvider.mergeCalls).toBe(0);

      await assertIssueLabels(
        scenario.issue.number,
        {
          present: ["ready-for-human"],
          absent: ["pr-open-awaiting-merge", "agent-in-progress"],
        },
        scenario.client
      );
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);
});
