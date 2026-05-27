import { describe, expect, it, vi } from "vitest";

import { createIssueTransitions } from "./issue-transitions";
import { reconcileBlockedIssue, reconcileBlockedIssues } from "./blocked-issue";

describe("blocked issue reconciliation", () => {
  it("does nothing when a blocker is still open", async () => {
    const deps = {
      getIssueState: vi.fn().mockResolvedValue("OPEN"),
      transitions: {
        removeBlocked: vi.fn(),
        addReadyForAgent: vi.fn(),
        moveToNeedsTriage: vi.fn(),
        moveToReadyForHuman: vi.fn(),
        closeCompleted: vi.fn(),
      },
      typeLabels: [],
      readyLabel: "ready-for-agent",
    };

    await expect(
      reconcileBlockedIssue(
        {
          number: 1,
          body: "## Blocked by\n- #2",
          labels: [{ name: "blocked" }, { name: "type:feature" }],
        },
        deps
      )
    ).resolves.toBe("still-blocked");

    expect(deps.transitions.removeBlocked).not.toHaveBeenCalled();
    expect(deps.transitions.addReadyForAgent).not.toHaveBeenCalled();
    expect(deps.transitions.moveToNeedsTriage).not.toHaveBeenCalled();
  });

  it("removes blocked and adds ready-for-agent when fully unblocked", async () => {
    const fetchIssue = vi.fn().mockResolvedValue({
      labels: ["blocked", "type:feature"],
    });
    const addLabels = vi.fn();
    const removeLabel = vi.fn();
    const transitions = createIssueTransitions(
      { fetchIssue, addLabels, removeLabel },
      {
        blocked: "blocked",
        readyForAgent: "ready-for-agent",
        needsTriage: "needs-triage",
        agentInProgress: "agent-in-progress",
        readyForHuman: "ready-for-human",
        prOpenAwaitingMerge: "pr-open-awaiting-merge",
      }
    );
    const deps = {
      getIssueState: vi.fn().mockResolvedValue("CLOSED"),
      transitions,
      typeLabels: ["type:feature"],
      readyLabel: "ready-for-agent",
    };

    await expect(
      reconcileBlockedIssue(
        {
          number: 2,
          body: "## Blocked by\n- #7",
          labels: [{ name: "blocked" }, { name: "type:feature" }],
        },
        deps
      )
    ).resolves.toBe("unblocked");

    expect(removeLabel).toHaveBeenCalledWith(2, "blocked");
    expect(addLabels).toHaveBeenCalledWith(2, ["ready-for-agent"]);
    expect(addLabels).not.toHaveBeenCalledWith(2, ["needs-triage"]);
  });

  it("does not duplicate ready-for-agent when already present on unblocked issue", async () => {
    const fetchIssue = vi.fn().mockResolvedValue({
      labels: ["blocked", "type:feature", "ready-for-agent"],
    });
    const addLabels = vi.fn();
    const removeLabel = vi.fn();
    const transitions = createIssueTransitions(
      { fetchIssue, addLabels, removeLabel },
      {
        blocked: "blocked",
        readyForAgent: "ready-for-agent",
        needsTriage: "needs-triage",
        agentInProgress: "agent-in-progress",
        readyForHuman: "ready-for-human",
        prOpenAwaitingMerge: "pr-open-awaiting-merge",
      }
    );
    const deps = {
      getIssueState: vi.fn().mockResolvedValue("CLOSED"),
      transitions,
      typeLabels: ["type:feature"],
      readyLabel: "ready-for-agent",
    };

    await expect(
      reconcileBlockedIssue(
        {
          number: 4,
          body: "## Blocked by\n- #8",
          labels: [
            { name: "blocked" },
            { name: "type:feature" },
            { name: "ready-for-agent" },
          ],
        },
        deps
      )
    ).resolves.toBe("unblocked");

    expect(removeLabel).toHaveBeenCalledWith(4, "blocked");
    expect(addLabels).not.toHaveBeenCalled();
  });

  it("moves malformed blocked issues to needs-triage", async () => {
    const fetchIssue = vi.fn().mockResolvedValue({ labels: ["blocked"] });
    const addLabels = vi.fn();
    const removeLabel = vi.fn();
    const transitions = createIssueTransitions(
      { fetchIssue, addLabels, removeLabel },
      {
        blocked: "blocked",
        readyForAgent: "ready-for-agent",
        needsTriage: "needs-triage",
        agentInProgress: "agent-in-progress",
        readyForHuman: "ready-for-human",
        prOpenAwaitingMerge: "pr-open-awaiting-merge",
      }
    );
    const deps = {
      getIssueState: vi.fn(),
      transitions,
      typeLabels: ["type:feature"],
      readyLabel: "ready-for-agent",
    };

    await expect(
      reconcileBlockedIssue(
        {
          number: 3,
          body: "No dependency section here.",
          labels: [{ name: "blocked" }],
        },
        deps
      )
    ).resolves.toBe("needs-triage");

    expect(removeLabel).toHaveBeenCalledWith(3, "blocked");
    expect(addLabels).toHaveBeenCalledWith(3, ["needs-triage"]);
  });
});

describe("reconcileBlockedIssues", () => {
  it("returns per-issue results for mixed outcomes", async () => {
    const deps = {
      getIssueState: vi
        .fn()
        .mockImplementation(async (n: number) => (n === 3 ? "OPEN" : "CLOSED")),
      transitions: {
        removeBlocked: vi.fn().mockResolvedValue(undefined),
        addReadyForAgent: vi.fn().mockResolvedValue(undefined),
        moveToNeedsTriage: vi.fn(),
        moveToReadyForHuman: vi.fn(),
        closeCompleted: vi.fn(),
      },
      typeLabels: ["type:feature"],
      readyLabel: "ready-for-agent",
    };

    const issues = [
      {
        number: 1,
        body: "## Blocked by\n- #3",
        labels: [{ name: "blocked" }, { name: "type:feature" }],
      },
      {
        number: 2,
        body: "## Blocked by\n- #4",
        labels: [{ name: "blocked" }, { name: "type:feature" }],
      },
    ];

    const results = await reconcileBlockedIssues(issues, deps);

    expect(results).toEqual([
      { issueNumber: 1, result: "still-blocked" },
      { issueNumber: 2, result: "unblocked" },
    ]);
  });

  it("rejects when a dependency fails", async () => {
    const deps = {
      getIssueState: vi.fn().mockImplementation(async (n: number) => "CLOSED"),
      transitions: {
        removeBlocked: vi.fn().mockImplementation(async (n: number) => {
          throw new Error("API failure");
        }),
        addReadyForAgent: vi.fn().mockResolvedValue(undefined),
        moveToNeedsTriage: vi.fn(),
        moveToReadyForHuman: vi.fn(),
        closeCompleted: vi.fn(),
      },
      typeLabels: ["type:feature"],
      readyLabel: "ready-for-agent",
    };

    const issues = [
      {
        number: 1,
        body: "## Blocked by\n- #10",
        labels: [{ name: "blocked" }, { name: "type:feature" }],
      },
    ];

    await expect(reconcileBlockedIssues(issues, deps)).rejects.toThrow(
      "API failure"
    );
  });

  it("handles empty issue list", async () => {
    const deps = {
      getIssueState: vi.fn(),
      transitions: {
        removeBlocked: vi.fn(),
        addReadyForAgent: vi.fn(),
        moveToNeedsTriage: vi.fn(),
        moveToReadyForHuman: vi.fn(),
        closeCompleted: vi.fn(),
      },
      typeLabels: [],
      readyLabel: "ready-for-agent",
    };

    const results = await reconcileBlockedIssues([], deps);
    expect(results).toEqual([]);
  });
});
