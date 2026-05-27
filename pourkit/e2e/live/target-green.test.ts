import { expect, it } from "vitest";
import type { BranchStatus } from "../../providers/pr-provider";
import { createLiveScenario, describeLive } from "./scenario-test-support";

function branchStatus(
  headSha: string,
  state: BranchStatus["state"]
): BranchStatus {
  return {
    headSha,
    state,
    checks:
      state === "red"
        ? [
            {
              name: "e2e",
              status: "COMPLETED",
              conclusion: "FAILURE",
            },
          ]
        : [
            {
              name: "e2e",
              status: state === "pending" ? "IN_PROGRESS" : "COMPLETED",
              conclusion: state === "green" ? "SUCCESS" : null,
            },
          ],
  };
}

describeLive("live E2E target-green gate", () => {
  it("succeeds when target branch turns green", async () => {
    const scenario = await createLiveScenario({
      prInjections: {
        branchStatuses: [
          branchStatus("abc1234", "pending"),
          branchStatus("abc1234", "green"),
          branchStatus("abc1234", "green"),
        ],
      },
    });

    try {
      const result = await scenario.runIssue();
      expect(result.prNumber).toBeGreaterThan(0);
      expect(scenario.prProvider.branchStatusCalls).toBeGreaterThan(1);
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);

  it("fails when target branch turns red", async () => {
    const scenario = await createLiveScenario({
      prInjections: {
        branchStatuses: [branchStatus("abc1234", "red")],
      },
    });

    try {
      await expect(scenario.runIssue()).rejects.toThrow("is red: e2e");
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);

  it("times out while target checks stay pending", async () => {
    const scenario = await createLiveScenario({
      prInjections: {
        branchStatuses: [branchStatus("abc1234", "pending")],
      },
      mutateConfig: (config) => ({
        ...config,
        checks: {
          ...config.checks,
          checksCompletionTimeoutSeconds: 1,
          pollIntervalSeconds: 1,
        },
      }),
    });

    try {
      await expect(scenario.runIssue()).rejects.toThrow("Timeout waiting for");
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);
});
