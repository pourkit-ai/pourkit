import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubPRProvider } from "../providers/github-pr-provider";
import type { GitHubClient } from "./github-client";

const { sleepMock } = vi.hoisted(() => ({
  sleepMock: vi.fn(async () => undefined),
}));

vi.mock("../shared/common", () => ({
  sleep: sleepMock,
}));

function makeClient(): GitHubClient {
  return {
    owner: "test-owner",
    repo: "test-repo",
    octokit: {
      rest: {
        pulls: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          merge: vi.fn(),
        },
        checks: {
          listForRef: vi.fn(),
        },
        repos: {
          getBranch: vi.fn(),
          getCombinedStatusForRef: vi.fn(),
        },
      },
      graphql: vi.fn(),
      paginate: vi.fn(),
    } as unknown as GitHubClient["octokit"],
  };
}

function makeLogger() {
  return {
    line: vi.fn(),
    raw: vi.fn(),
    step: vi.fn(),
    status: vi.fn(),
    kv: vi.fn(),
    close: vi.fn(),
  };
}

function mockPrResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      number: 12,
      node_id: "PR_node1",
      html_url: "https://github.com/test/repo/pull/12",
      title: "feat: test",
      body: "Closes #12",
      head: {
        ref: "agent/test",
        sha: "abc123",
        label: "test-owner:agent/test",
        user: null,
        repo: null,
      },
      base: {
        ref: "main",
        sha: "def456",
        label: "test-owner:main",
        user: null,
        repo: null,
      },
      state: "open",
      merged: false,
      draft: false,
      ...overrides,
    },
  };
}

function mockTargetBranchStatus(options: {
  sha: string;
  checkRuns?: { name: string; status: string; conclusion: string | null }[];
  statuses?: { context: string; state: string }[];
}) {
  const client = makeClient();
  vi.mocked(client.octokit.rest.repos.getBranch).mockResolvedValue({
    data: { commit: { sha: options.sha } },
  } as never);
  vi.mocked(client.octokit.paginate).mockResolvedValue(
    (options.checkRuns ?? []) as never
  );
  vi.mocked(
    client.octokit.rest.repos.getCombinedStatusForRef
  ).mockResolvedValue({
    data: {
      statuses: options.statuses ?? [],
      state: "pending",
      total_count: 0,
      commit_url: "",
      url: "",
    },
  } as never);
  return client;
}

describe("GitHubPRProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a PR via Octokit and returns mapped PullRequest", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.pulls.create).mockResolvedValue(
      mockPrResponse({
        number: 12,
        html_url: "https://github.com/test/repo/pull/12",
        title: "feat: test",
        body: "Closes #12",
        head: { ref: "agent/test", sha: "abc123" },
        base: { ref: "main" },
        state: "open",
        node_id: "PR_node1",
      }) as never
    );

    const provider = new GitHubPRProvider(client, makeLogger());
    const pr = await provider.createPr({
      title: "feat: test",
      body: "Closes #12",
      head: "agent/test",
      base: "main",
    });

    expect(client.octokit.rest.pulls.create).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      title: "feat: test",
      body: "Closes #12",
      head: "agent/test",
      base: "main",
    });
    expect(pr.number).toBe(12);
    expect(pr.nodeId).toBe("PR_node1");
    expect(pr.url).toBe("https://github.com/test/repo/pull/12");
    expect(pr.headRefName).toBe("agent/test");
    expect(pr.baseRefName).toBe("main");
    expect(pr.state).toBe("OPEN");
    expect(pr.headRefOid).toBe("abc123");
  });

  it("merges a PR with squash merge and match head commit", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.pulls.merge).mockResolvedValue({
      data: {
        merged: true,
        message: "Pull Request successfully merged",
        sha: "abc123",
      },
    } as never);

    const provider = new GitHubPRProvider(client, makeLogger());
    await provider.mergePr(12, { matchHeadCommit: "abc123" });

    expect(client.octokit.rest.pulls.merge).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      pull_number: 12,
      merge_method: "squash",
      sha: "abc123",
    });
  });

  it("does not call enableAutoMerge when performing direct merge", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.pulls.merge).mockResolvedValue({
      data: { merged: true, message: "merged", sha: "abc123" },
    } as never);

    const provider = new GitHubPRProvider(client, makeLogger());
    await provider.mergePr(12, { matchHeadCommit: "abc123" });

    expect(client.octokit.graphql).not.toHaveBeenCalled();
  });

  it("enables auto merge through GraphQL", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.graphql).mockResolvedValue({
      enablePullRequestAutoMerge: {
        pullRequest: { id: "PR_node1", number: 12 },
      },
    });

    const pr = {
      number: 12,
      nodeId: "PR_node1",
      url: "https://github.com/test/repo/pull/12",
      title: "feat: test",
      body: "Closes #12",
      headRefName: "agent/test",
      baseRefName: "main",
      state: "OPEN" as const,
      headRefOid: "abc123",
    };

    const provider = new GitHubPRProvider(client, makeLogger());
    await provider.enableAutoMerge(pr, {
      method: "squash",
      expectedHeadOid: "abc123",
    });

    expect(client.octokit.graphql).toHaveBeenCalledWith(
      expect.stringContaining("enablePullRequestAutoMerge"),
      expect.objectContaining({
        pullRequestId: "PR_node1",
        mergeMethod: "SQUASH",
        expectedHeadOid: "abc123",
      })
    );
    expect(client.octokit.rest.pulls.merge).not.toHaveBeenCalled();
  });

  it("looks up PRs across all states by head branch", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.pulls.list).mockResolvedValue({
      data: [
        {
          number: 12,
          node_id: "PR_node1",
          html_url: "https://github.com/test/repo/pull/12",
          title: "feat: test",
          body: "Closes #12",
          head: { ref: "agent/test", sha: "abc123" },
          base: { ref: "main" },
          state: "open",
          merged: false,
          draft: false,
        },
      ],
    } as never);

    const provider = new GitHubPRProvider(client, makeLogger());
    const pr = await provider.getPr("agent/test");

    expect(pr?.state).toBe("OPEN");
    expect(client.octokit.rest.pulls.list).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      head: "test-owner:agent/test",
      state: "all",
      per_page: 1,
    });
  });

  it("looks up a PR by number", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.pulls.get).mockResolvedValue(
      mockPrResponse({
        number: 99,
        head: { ref: "feature/test", sha: "abc123" },
      }) as never
    );

    const provider = new GitHubPRProvider(client, makeLogger());
    const pr = await provider.getPrByNumber(99);

    expect(client.octokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      pull_number: 99,
    });
    expect(pr?.number).toBe(99);
    expect(pr?.headRefOid).toBe("abc123");
  });

  it("returns null when PR lookup by number fails", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.pulls.get).mockRejectedValue(
      new Error("not found")
    );

    const provider = new GitHubPRProvider(client, makeLogger());
    const pr = await provider.getPrByNumber(99);

    expect(pr).toBeNull();
  });

  it("returns null when no PRs found", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.pulls.list).mockResolvedValue({
      data: [],
    } as never);

    const provider = new GitHubPRProvider(client, makeLogger());
    const pr = await provider.getPr("agent/test");

    expect(pr).toBeNull();
  });

  it("returns empty checks when Octokit calls fail", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.pulls.get).mockRejectedValue(
      new Error("boom")
    );

    const provider = new GitHubPRProvider(client, makeLogger());
    const checks = await provider.getCheckStatus(999999);

    expect(checks).toEqual([]);
  });

  it("times out when required checks never appear", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.pulls.get).mockRejectedValue(
      new Error("boom")
    );

    const provider = new GitHubPRProvider(client, makeLogger());

    await expect(
      provider.waitForPrChecks(999999, {
        checksFoundTimeoutMs: 5,
        checksCompletionTimeoutMs: 1000,
        pollIntervalMs: 0,
        requiredChecks: ["lint"],
      })
    ).rejects.toThrow("Timeout waiting for required checks");
  });

  it("passes after grace period when no checks ever appear", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.pulls.get).mockRejectedValue(
      new Error("no checks")
    );

    const provider = new GitHubPRProvider(client, makeLogger());

    const checks = await provider.waitForPrChecks(123, {
      checksFoundTimeoutMs: 50,
      checksCompletionTimeoutMs: 5000,
      pollIntervalMs: 0,
    });

    expect(checks).toEqual([]);
  });

  it("succeeds when all checks are passing", async () => {
    const client = makeClient();

    // Mock the PR response to get head SHA
    vi.mocked(client.octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc123" } },
    } as never);

    // Mock check runs via paginate
    vi.mocked(client.octokit.paginate).mockResolvedValue([
      { name: "lint", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "success" },
    ] as never);

    // Mock commit statuses
    vi.mocked(
      client.octokit.rest.repos.getCombinedStatusForRef
    ).mockResolvedValue({
      data: {
        statuses: [],
        state: "success",
        total_count: 0,
        commit_url: "",
        url: "",
      },
    } as never);

    const provider = new GitHubPRProvider(client, makeLogger());

    const checks = await provider.waitForPrChecks(123, {
      checksFoundTimeoutMs: 1000,
      checksCompletionTimeoutMs: 1000,
      pollIntervalMs: 0,
    });

    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.status === "COMPLETED")).toBe(true);
  });

  it("fails when any check has failure conclusion", async () => {
    const client = makeClient();

    vi.mocked(client.octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc123" } },
    } as never);

    vi.mocked(client.octokit.paginate).mockResolvedValue([
      { name: "lint", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "failure" },
    ] as never);

    vi.mocked(
      client.octokit.rest.repos.getCombinedStatusForRef
    ).mockResolvedValue({
      data: {
        statuses: [],
        state: "success",
        total_count: 0,
        commit_url: "",
        url: "",
      },
    } as never);

    const provider = new GitHubPRProvider(client, makeLogger());

    await expect(
      provider.waitForPrChecks(123, {
        checksFoundTimeoutMs: 1000,
        checksCompletionTimeoutMs: 1000,
        pollIntervalMs: 0,
      })
    ).rejects.toThrow("Checks failed: test=FAILURE");
  });

  it("waits and retries when checks are still in progress", async () => {
    const client = makeClient();

    // Mock PR call to get head SHA (called each time getCheckStatus runs)
    vi.mocked(client.octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc123" } },
    } as never);

    // First call: test is in progress
    vi.mocked(client.octokit.paginate)
      .mockResolvedValueOnce([
        { name: "lint", status: "completed", conclusion: "success" },
        { name: "test", status: "in_progress", conclusion: null },
      ] as never)
      // Second call: all completed
      .mockResolvedValueOnce([
        { name: "lint", status: "completed", conclusion: "success" },
        { name: "test", status: "completed", conclusion: "success" },
      ] as never);

    vi.mocked(
      client.octokit.rest.repos.getCombinedStatusForRef
    ).mockResolvedValue({
      data: {
        statuses: [],
        state: "success",
        total_count: 0,
        commit_url: "",
        url: "",
      },
    } as never);

    const provider = new GitHubPRProvider(client, makeLogger());

    const checks = await provider.waitForPrChecks(123, {
      checksFoundTimeoutMs: 1000,
      checksCompletionTimeoutMs: 5000,
      pollIntervalMs: 0,
    });

    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.conclusion === "SUCCESS")).toBe(true);
    // getCheckStatus calls pulls.get + checks.listForRef (via paginate) + getCombinedStatusForRef per call
    // With 2 iterations of getCheckStatus, we expect 2 calls to paginate
    expect(client.octokit.paginate).toHaveBeenCalledTimes(2);
  });

  it("includes check runs from all paginated pages in getCheckStatus", async () => {
    const client = makeClient();

    vi.mocked(client.octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc123" } },
    } as never);

    const page1 = { name: "lint", status: "completed", conclusion: "success" };
    const page2 = { name: "test", status: "completed", conclusion: "success" };
    vi.mocked(client.octokit.paginate).mockResolvedValue([
      page1,
      page2,
    ] as never);

    vi.mocked(
      client.octokit.rest.repos.getCombinedStatusForRef
    ).mockResolvedValue({
      data: {
        statuses: [],
        state: "success",
        total_count: 0,
        commit_url: "",
        url: "",
      },
    } as never);

    const provider = new GitHubPRProvider(client, makeLogger());
    const checks = await provider.getCheckStatus(123);

    expect(checks).toHaveLength(2);
    expect(checks.map((c) => c.name)).toEqual(["lint", "test"]);
  });

  it("detects failure from a check run on a subsequent paginated page", async () => {
    const client = makeClient();

    vi.mocked(client.octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc123" } },
    } as never);

    // Page 1 is green, page 2 has a failing check
    vi.mocked(client.octokit.paginate).mockResolvedValue([
      { name: "lint", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "failure" },
    ] as never);

    vi.mocked(
      client.octokit.rest.repos.getCombinedStatusForRef
    ).mockResolvedValue({
      data: {
        statuses: [],
        state: "success",
        total_count: 0,
        commit_url: "",
        url: "",
      },
    } as never);

    const provider = new GitHubPRProvider(client, makeLogger());
    const checks = await provider.getCheckStatus(123);

    expect(checks).toHaveLength(2);
    expect(checks.find((c) => c.name === "test")?.conclusion).toBe("FAILURE");
  });

  it("detects failure from paginated check runs in waitForPrChecks", async () => {
    const client = makeClient();

    vi.mocked(client.octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc123" } },
    } as never);

    // Page 1: lint passes; page 2: test fails
    vi.mocked(client.octokit.paginate).mockResolvedValue([
      { name: "lint", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "failure" },
    ] as never);

    vi.mocked(
      client.octokit.rest.repos.getCombinedStatusForRef
    ).mockResolvedValue({
      data: {
        statuses: [],
        state: "success",
        total_count: 0,
        commit_url: "",
        url: "",
      },
    } as never);

    const provider = new GitHubPRProvider(client, makeLogger());

    await expect(
      provider.waitForPrChecks(123, {
        checksFoundTimeoutMs: 1000,
        checksCompletionTimeoutMs: 1000,
        pollIntervalMs: 0,
      })
    ).rejects.toThrow("Checks failed: test=FAILURE");
  });

  describe("getBranchStatus", () => {
    it("returns head SHA and green state when all completed checks pass", async () => {
      const client = mockTargetBranchStatus({
        sha: "abc123",
        checkRuns: [{ name: "ci", status: "completed", conclusion: "success" }],
      });

      const provider = new GitHubPRProvider(client, makeLogger());
      const status = await provider.getBranchStatus("next");

      expect(status.headSha).toBe("abc123");
      expect(status.state).toBe("green");
      expect(status.checks).toEqual([
        { name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
      ]);
    });

    it("returns pending state when checks are in progress", async () => {
      const client = mockTargetBranchStatus({
        sha: "abc123",
        checkRuns: [{ name: "ci", status: "in_progress", conclusion: null }],
      });

      const provider = new GitHubPRProvider(client, makeLogger());
      const status = await provider.getBranchStatus("next");

      expect(status.headSha).toBe("abc123");
      expect(status.state).toBe("pending");
    });

    it("returns red state when any check fails", async () => {
      const client = mockTargetBranchStatus({
        sha: "abc123",
        checkRuns: [{ name: "ci", status: "completed", conclusion: "failure" }],
      });

      const provider = new GitHubPRProvider(client, makeLogger());
      const status = await provider.getBranchStatus("next");

      expect(status.headSha).toBe("abc123");
      expect(status.state).toBe("red");
    });

    it("includes commit statuses in branch state", async () => {
      const client = mockTargetBranchStatus({
        sha: "abc123",
        checkRuns: [{ name: "ci", status: "completed", conclusion: "success" }],
        statuses: [{ context: "release", state: "pending" }],
      });

      const provider = new GitHubPRProvider(client, makeLogger());
      const status = await provider.getBranchStatus("next");

      expect(status.state).toBe("pending");
      expect(status.checks).toContainEqual({
        name: "release",
        conclusion: null,
        status: "PENDING",
      });
    });

    it("returns red state for cancelled checks", async () => {
      const client = mockTargetBranchStatus({
        sha: "abc123",
        checkRuns: [
          { name: "lint", status: "completed", conclusion: "success" },
          { name: "test", status: "completed", conclusion: "cancelled" },
        ],
      });

      const provider = new GitHubPRProvider(client, makeLogger());
      const status = await provider.getBranchStatus("next");

      expect(status.headSha).toBe("abc123");
      expect(status.state).toBe("red");
      expect(status.checks).toContainEqual({
        name: "test",
        conclusion: "CANCELLED",
        status: "COMPLETED",
      });
    });

    it("treats neutral completed checks as green", async () => {
      const client = mockTargetBranchStatus({
        sha: "abc123",
        checkRuns: [
          { name: "lint", status: "completed", conclusion: "success" },
          { name: "docs", status: "completed", conclusion: "neutral" },
        ],
      });

      const provider = new GitHubPRProvider(client, makeLogger());
      const status = await provider.getBranchStatus("next");

      expect(status.state).toBe("green");
      expect(status.checks).toContainEqual({
        name: "docs",
        conclusion: "NEUTRAL",
        status: "COMPLETED",
      });
    });

    it("returns pending state with empty checks when branch has no checks", async () => {
      const client = mockTargetBranchStatus({ sha: "abc123" });

      const provider = new GitHubPRProvider(client, makeLogger());
      const status = await provider.getBranchStatus("next");

      expect(status.headSha).toBe("abc123");
      expect(status.state).toBe("pending");
      expect(status.checks).toHaveLength(0);
    });

    it("includes paginated check runs from multiple pages in branch status", async () => {
      const client = mockTargetBranchStatus({
        sha: "abc123",
        checkRuns: [
          { name: "lint", status: "completed", conclusion: "success" },
          { name: "test", status: "completed", conclusion: "failure" },
          { name: "audit", status: "completed", conclusion: "success" },
        ],
      });

      const provider = new GitHubPRProvider(client, makeLogger());
      const status = await provider.getBranchStatus("next");

      expect(status.checks).toHaveLength(3);
      expect(status.state).toBe("red");
      expect(status.checks.find((c) => c.name === "test")?.conclusion).toBe(
        "FAILURE"
      );
    });

    it("throws a clear error when API fails", async () => {
      const client = makeClient();
      vi.mocked(client.octokit.rest.repos.getBranch).mockRejectedValue(
        new Error("API error")
      );

      const provider = new GitHubPRProvider(client, makeLogger());

      await expect(provider.getBranchStatus("main")).rejects.toThrow(
        "Failed to get branch status for main: API error"
      );
    });
  });
});
