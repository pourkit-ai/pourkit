import { expect, it } from "vitest";
import { assertIssueLabels, lookupPrByBranch } from "./harness";
import {
  createQueueLoopLiveScenario,
  describeLive,
  resolveLivePrTitle,
} from "./scenario-test-support";

describeLive("live E2E Queue Loop", () => {
  it("processes multiple runnable issues sequentially", async () => {
    const titleA = resolveLivePrTitle("Queue Loop Sequential A");
    const titleB = resolveLivePrTitle("Queue Loop Sequential B");

    const scenario = await createQueueLoopLiveScenario({
      executionInjections: {
        finalizer: {
          title: titleA,
          body: "Queue Loop live test body.\n\ne2e-check: pass",
        },
      },
      prepareIssueB: async (issueNumber, _issueANumber, client) => {
        await client.octokit.rest.issues.update({
          owner: client.owner,
          repo: client.repo,
          issue_number: issueNumber,
          title: titleB,
        });
      },
    });

    let cleanupAttempted = false;
    try {
      const outcome = await scenario.runQueueLoop();

      expect(outcome).toMatchObject({
        drained: true,
        processedCount: 2,
      });
      if ("drained" in outcome) {
        expect(outcome.results).toHaveLength(2);
      }

      const prA = await lookupPrByBranch(
        scenario.issues[0].agentBranch,
        scenario.client
      );
      const prB = await lookupPrByBranch(
        scenario.issues[1].agentBranch,
        scenario.client
      );
      expect(prA).not.toBeNull();
      expect(prA?.state).toBe("MERGED");
      expect(prB).not.toBeNull();
      expect(prB?.state).toBe("MERGED");

      const issueAData = await scenario.issueProvider.fetchIssue(
        scenario.issues[0].issueNumber
      );
      expect(issueAData.state).toBe("closed");
      const issueBData = await scenario.issueProvider.fetchIssue(
        scenario.issues[1].issueNumber
      );
      expect(issueBData.state).toBe("closed");

      const cleanupErrors = await scenario.cleanup();
      cleanupAttempted = true;
      expect(cleanupErrors).toEqual([]);
    } finally {
      if (!cleanupAttempted) {
        await scenario.cleanup().catch(() => {});
      }
    }
  }, 600_000);

  it("reconciles blocked dependency and processes newly unblocked issue", async () => {
    const scenario = await createQueueLoopLiveScenario({
      executionInjections: {
        finalizer: {
          body: "Queue Loop blocked dependency test body.\n\ne2e-check: pass",
        },
      },
      prepareIssueB: async (issueNumber, issueANumber, client) => {
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
        await client.octokit.rest.issues.update({
          owner: client.owner,
          repo: client.repo,
          issue_number: issueNumber,
          body: `## Blocked by\n- #${issueANumber}`,
        });
      },
    });

    let cleanupAttempted = false;
    try {
      const outcome = await scenario.runQueueLoop();

      expect(outcome).toMatchObject({
        drained: true,
        processedCount: 2,
      });

      await assertIssueLabels(
        scenario.issues[1].issueNumber,
        {
          absent: ["blocked", "ready-for-agent"],
        },
        scenario.client
      );

      const cleanupErrors = await scenario.cleanup();
      cleanupAttempted = true;
      expect(cleanupErrors).toEqual([]);
    } finally {
      if (!cleanupAttempted) {
        await scenario.cleanup().catch(() => {});
      }
    }
  }, 600_000);
});
