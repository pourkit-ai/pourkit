import { expect, it } from "vitest";
import {
  assertIssueLabels,
  lookupPrByBranch,
  remoteBranchExists,
} from "./harness";
import { createLiveScenario, describeLive } from "./scenario-test-support";

describeLive("live E2E issue gates", () => {
  it("rejects blocked issue before branch work", async () => {
    const scenario = await createLiveScenario({
      prepareIssue: async (issueNumber, client) => {
        await client.octokit.rest.issues.removeLabel({
          owner: client.owner,
          repo: client.repo,
          issue_number: issueNumber,
          name: "ready-for-agent",
        });
        await client.octokit.rest.issues.addLabels({
          owner: client.owner,
          repo: client.repo,
          issue_number: issueNumber,
          labels: ["blocked"],
        });
      },
    });

    try {
      await expect(scenario.runIssue()).rejects.toThrow("Issue gates failed");
      expect(await remoteBranchExists(scenario.expectedBranchName)).toBe(false);
      expect(
        await lookupPrByBranch(scenario.expectedBranchName, scenario.client)
      ).toBeNull();
      await assertIssueLabels(
        scenario.issue.number,
        {
          absent: ["agent-in-progress", "pr-open-awaiting-merge"],
        },
        scenario.client
      );
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);

  it("accepts ready issue into the flow", async () => {
    const scenario = await createLiveScenario({
      executionInjections: {
        builder: { error: "intentional builder stop" },
      },
    });

    try {
      await expect(scenario.runIssue()).rejects.toThrow(
        "Sandcastle failed: intentional builder stop"
      );
      expect(scenario.executionProvider.stageCalls).toEqual(["builder"]);
      await assertIssueLabels(
        scenario.issue.number,
        {
          present: ["ready-for-human"],
          absent: ["agent-in-progress", "pr-open-awaiting-merge"],
        },
        scenario.client
      );
    } finally {
      await scenario.cleanup();
    }
  }, 600_000);
});
