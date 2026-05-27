import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubIssueProvider } from "../providers/github-provider";
import type { GitHubClient } from "./github-client";

function makeClient(overrides?: Partial<GitHubClient>): GitHubClient {
  return {
    owner: "test-owner",
    repo: "test-repo",
    octokit: {
      rest: {
        issues: {
          get: vi.fn(),
          listForRepo: vi.fn(),
          listComments: vi.fn(),
          update: vi.fn(),
          createComment: vi.fn(),
          addLabels: vi.fn(),
          removeLabel: vi.fn(),
        },
        pulls: {} as Record<string, unknown>,
      },
      graphql: vi.fn(),
      paginate: vi.fn(),
    } as unknown as GitHubClient["octokit"],
    ...overrides,
  } as GitHubClient;
}

function makeRawIssue(
  overrides: Partial<{
    number: number;
    title: string;
    body: string | null;
    state: string;
    labels: Array<{ name: string } | string>;
    created_at: string;
  }> = {}
) {
  return {
    id: 1,
    node_id: "node1",
    url: "https://api.github.com/repos/test-owner/test-repo/issues/42",
    repository_url: "",
    labels_url: "",
    comments_url: "",
    events_url: "",
    html_url: "",
    number: 42,
    title: "Test issue",
    body: "Test body",
    state: "open",
    labels: [{ name: "ready-for-agent" }],
    created_at: "2024-01-15T10:00:00Z",
    updated_at: "2024-01-15T10:00:00Z",
    closed_at: null,
    milestone: null,
    user: { login: "test", id: 1 },
    assignee: null,
    assignees: [],
    comments: 0,
    pull_request: undefined,
    locked: false,
    author_association: "NONE",
    active_lock_reason: null,
    ...overrides,
  };
}

describe("GitHubIssueProvider listCandidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("paginates Octokit issues.listForRepo with ready-for-agent label and open state", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([]);

    const provider = new GitHubIssueProvider(client);
    await provider.listCandidates();

    expect(client.octokit.paginate).toHaveBeenCalledWith(
      client.octokit.rest.issues.listForRepo,
      {
        owner: "test-owner",
        repo: "test-repo",
        state: "open",
        labels: "ready-for-agent",
        per_page: 100,
      }
    );
  });

  it("returns mapped IssueData from Octokit output", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([
      makeRawIssue({
        number: 1,
        title: "First issue",
        created_at: "2024-01-10T00:00:00Z",
      }),
      makeRawIssue({
        number: 2,
        title: "Second issue",
        created_at: "2024-01-12T00:00:00Z",
      }),
    ]);

    const provider = new GitHubIssueProvider(client);
    const candidates = await provider.listCandidates();

    expect(candidates).toHaveLength(2);
    expect(candidates[0].number).toBe(1);
    expect(candidates[0].title).toBe("First issue");
    expect(candidates[0].body).toBe("Test body");
    expect(candidates[0].state).toBe("open");
    expect(candidates[0].labels).toEqual(["ready-for-agent"]);
    expect(candidates[0].comments).toEqual([]);
    expect(candidates[0].createdAt).toEqual(new Date("2024-01-10T00:00:00Z"));
  });

  it("returns empty array when no issues match", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([]);

    const provider = new GitHubIssueProvider(client);
    const candidates = await provider.listCandidates();

    expect(candidates).toHaveLength(0);
  });

  it("handles null body gracefully", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([
      makeRawIssue({ body: null }),
    ]);

    const provider = new GitHubIssueProvider(client);
    const candidates = await provider.listCandidates();

    expect(candidates[0].body).toBe("");
  });

  it("uses custom ready-for-agent label when configured", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([]);

    const provider = new GitHubIssueProvider(client, {
      readyForAgentLabel: "afk-ready",
    });
    await provider.listCandidates();

    expect(client.octokit.paginate).toHaveBeenCalledWith(
      client.octokit.rest.issues.listForRepo,
      expect.objectContaining({ labels: "afk-ready" })
    );
  });

  it("propagates error when Octokit call fails", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockRejectedValue(
      new Error("API error")
    );

    const provider = new GitHubIssueProvider(client);

    await expect(provider.listCandidates()).rejects.toThrow("API error");
  });

  it("paginates when issueListLimit exceeds single page max", async () => {
    const client = makeClient();
    const issues = Array.from({ length: 150 }, (_, i) =>
      makeRawIssue({
        number: i + 1,
        title: `Issue ${i + 1}`,
      })
    );
    vi.mocked(client.octokit.paginate).mockResolvedValue(issues);

    const provider = new GitHubIssueProvider(client, {
      issueListLimit: 120,
    });
    const candidates = await provider.listCandidates();

    expect(candidates).toHaveLength(120);
    expect(client.octokit.paginate).toHaveBeenCalledWith(
      client.octokit.rest.issues.listForRepo,
      expect.objectContaining({ per_page: 100 })
    );
  });
});

describe("GitHubIssueProvider getComments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns comment bodies from Octokit paginated output", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([
      { body: "First" },
      { body: "Second" },
    ]);

    const provider = new GitHubIssueProvider(client);

    await expect(provider.getComments(42)).resolves.toEqual([
      "First",
      "Second",
    ]);

    expect(client.octokit.paginate).toHaveBeenCalledWith(
      client.octokit.rest.issues.listComments,
      {
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 42,
      }
    );
  });

  it("paginates comments beyond a single page", async () => {
    const client = makeClient();
    const comments = Array.from({ length: 150 }, (_, i) => ({
      body: `Comment ${i + 1}`,
    }));
    vi.mocked(client.octokit.paginate).mockResolvedValue(comments);

    const provider = new GitHubIssueProvider(client);
    const result = await provider.getComments(42);

    expect(result).toHaveLength(150);
    expect(result[0]).toBe("Comment 1");
    expect(result[149]).toBe("Comment 150");
  });
});

describe("GitHubIssueProvider listBlockedIssues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("paginates Octokit issues.listForRepo with blocked label and open state", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([]);

    const provider = new GitHubIssueProvider(client);
    await provider.listBlockedIssues();

    expect(client.octokit.paginate).toHaveBeenCalledWith(
      client.octokit.rest.issues.listForRepo,
      {
        owner: "test-owner",
        repo: "test-repo",
        state: "open",
        labels: "blocked",
        per_page: 100,
      }
    );
  });

  it("returns mapped BlockedIssue from Octokit output", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([
      makeRawIssue({
        number: 5,
        title: "Blocked issue",
        body: "## Blocked by\n- #3",
        labels: [{ name: "blocked" }, { name: "type:feature" }],
      }),
    ]);

    const provider = new GitHubIssueProvider(client);
    const issues = await provider.listBlockedIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      number: 5,
      body: "## Blocked by\n- #3",
      labels: [{ name: "blocked" }, { name: "type:feature" }],
    });
  });

  it("handles null body gracefully", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([
      makeRawIssue({
        number: 6,
        title: "No body",
        body: null,
        labels: [{ name: "blocked" }],
      }),
    ]);

    const provider = new GitHubIssueProvider(client);
    const issues = await provider.listBlockedIssues();

    expect(issues[0].body).toBeNull();
  });

  it("uses custom blocked label when configured", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([]);

    const provider = new GitHubIssueProvider(client, {
      blockedLabel: "custom-blocked",
    });
    await provider.listBlockedIssues();

    expect(client.octokit.paginate).toHaveBeenCalledWith(
      client.octokit.rest.issues.listForRepo,
      expect.objectContaining({ labels: "custom-blocked" })
    );
  });

  it("returns empty array when no blocked issues exist", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([]);

    const provider = new GitHubIssueProvider(client);
    const issues = await provider.listBlockedIssues();

    expect(issues).toHaveLength(0);
  });

  it("honors default issueListLimit of 50", async () => {
    const client = makeClient();
    const issues = Array.from({ length: 100 }, (_, i) =>
      makeRawIssue({
        number: i + 1,
        title: `Blocked ${i + 1}`,
        labels: [{ name: "blocked" }],
      })
    );
    vi.mocked(client.octokit.paginate).mockResolvedValue(issues);

    const provider = new GitHubIssueProvider(client);
    const blocked = await provider.listBlockedIssues();

    expect(blocked).toHaveLength(50);
  });

  it("paginates and slices when issueListLimit exceeds single page", async () => {
    const client = makeClient();
    const issues = Array.from({ length: 150 }, (_, i) =>
      makeRawIssue({
        number: i + 1,
        title: `Blocked ${i + 1}`,
        labels: [{ name: "blocked" }],
      })
    );
    vi.mocked(client.octokit.paginate).mockResolvedValue(issues);

    const provider = new GitHubIssueProvider(client, {
      issueListLimit: 120,
    });
    const blocked = await provider.listBlockedIssues();

    expect(blocked).toHaveLength(120);
    expect(client.octokit.paginate).toHaveBeenCalledWith(
      client.octokit.rest.issues.listForRepo,
      expect.objectContaining({ per_page: 100 })
    );
  });
});

describe("GitHubIssueProvider listRelatedIssues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores matches beyond issueListLimit", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([
      makeRawIssue({
        number: 1,
        title: "Unrelated issue",
        body: "## Parent\n\nPRD-001 (#1)",
      }),
      makeRawIssue({
        number: 2,
        title: "Another unrelated",
        body: "## Parent\n\nPRD-001 (#2)",
      }),
      makeRawIssue({
        number: 3,
        title: "PRD-002 / I-01: Third child",
        body: "## Parent\n\nPRD-002 (#99)",
      }),
    ]);

    const provider = new GitHubIssueProvider(client, {
      issueListLimit: 2,
    });
    const related = await provider.listRelatedIssues("PRD-002");

    expect(related).toHaveLength(0);
  });

  it("finds matches within issueListLimit when limit exceeds single page", async () => {
    const client = makeClient();
    const count = 150;
    const issues = Array.from({ length: count }, (_, i) =>
      makeRawIssue({
        number: i + 1,
        title: i < count - 1 ? `Issue ${i + 1}` : "PRD-002 / I-01: Match",
        body: i < count - 1 ? "Unrelated body" : "## Parent\n\nPRD-002 (#99)",
      })
    );
    vi.mocked(client.octokit.paginate).mockResolvedValue(issues);

    const provider = new GitHubIssueProvider(client, {
      issueListLimit: 150,
    });
    const related = await provider.listRelatedIssues("PRD-002");

    expect(related).toHaveLength(1);
    expect(related[0].number).toBe(count);
    expect(client.octokit.paginate).toHaveBeenCalledWith(
      client.octokit.rest.issues.listForRepo,
      expect.objectContaining({ per_page: 100 })
    );
  });

  it("paginates all issues with enough metadata to resolve siblings", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([]);

    const provider = new GitHubIssueProvider(client);
    await provider.listRelatedIssues("PRD-002");

    expect(client.octokit.paginate).toHaveBeenCalledWith(
      client.octokit.rest.issues.listForRepo,
      {
        owner: "test-owner",
        repo: "test-repo",
        state: "all",
        per_page: 100,
      }
    );
  });

  it("matches related issues by body parent metadata", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([
      makeRawIssue({
        number: 11,
        title: "PRD-002 / I-01: First child",
        body: "## Parent\n\nPRD-002 (#99)",
        state: "closed",
      }),
      makeRawIssue({
        number: 12,
        title: "PRD-003 / I-01: Different child",
        body: "## Parent\n\nPRD-003 (#100)",
      }),
    ]);

    const provider = new GitHubIssueProvider(client);
    const related = await provider.listRelatedIssues("PRD-002");

    expect(related).toEqual([expect.objectContaining({ number: 11 })]);
  });

  it("falls back to the child title convention when the body has no parent section", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([
      makeRawIssue({
        number: 11,
        title: "PRD-002 / I-01: First child",
        body: "No parent section here",
        state: "closed",
      }),
      makeRawIssue({
        number: 12,
        title: "Standalone issue",
        body: "No parent section here",
      }),
    ]);

    const provider = new GitHubIssueProvider(client);
    const related = await provider.listRelatedIssues("PRD-002");

    expect(related).toEqual([expect.objectContaining({ number: 11 })]);
  });
});

describe("GitHubIssueProvider resolveIssueByCanonicalRef", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns matching PRD issue when title starts with canonical ref", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([
      makeRawIssue({
        number: 99,
        title: "PRD-038: Canonical closing-ref policy for Pourkit-managed PRs",
        state: "open",
      }),
      makeRawIssue({
        number: 11,
        title: "PRD-038 / I-01: First child",
        body: "## Parent\n\nPRD-038 (#99)",
        state: "closed",
      }),
      makeRawIssue({
        number: 42,
        title: "Unrelated issue mentioning PRD-038 in body",
        body: "See PRD-038 for context",
        state: "open",
      }),
    ]);

    const provider = new GitHubIssueProvider(client);
    const parent = await provider.resolveIssueByCanonicalRef("PRD-038");

    expect(parent).toEqual(
      expect.objectContaining({
        number: 99,
        title: "PRD-038: Canonical closing-ref policy for Pourkit-managed PRs",
      })
    );
  });

  it("returns null when no issue title starts with the canonical ref", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([
      makeRawIssue({
        number: 11,
        title: "PRD-002 / I-01: Some child",
        body: "## Parent\n\nPRD-002 (#99)",
      }),
    ]);

    const provider = new GitHubIssueProvider(client);
    const parent = await provider.resolveIssueByCanonicalRef("PRD-002");

    expect(parent).toBeNull();
  });

  it("ignores matches beyond issueListLimit", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([
      makeRawIssue({
        number: 1,
        title: "PRD-001: First unrelated PRD",
      }),
      makeRawIssue({
        number: 2,
        title: "PRD-002: Second unrelated PRD",
      }),
      makeRawIssue({
        number: 3,
        title: "PRD-003: Third unrelated PRD",
      }),
      makeRawIssue({
        number: 99,
        title: "PRD-038: Canonical closing-ref policy",
      }),
    ]);

    const provider = new GitHubIssueProvider(client, {
      issueListLimit: 3,
    });
    const parent = await provider.resolveIssueByCanonicalRef("PRD-038");

    expect(parent).toBeNull();
  });

  it("finds matches within issueListLimit when limit exceeds single page", async () => {
    const client = makeClient();
    const count = 200;
    const issues = Array.from({ length: count }, (_, i) =>
      makeRawIssue({
        number: i + 1,
        title:
          i === count - 1
            ? "PRD-038: Canonical closing-ref policy"
            : `Issue ${i + 1}`,
      })
    );
    vi.mocked(client.octokit.paginate).mockResolvedValue(issues);

    const provider = new GitHubIssueProvider(client, {
      issueListLimit: 200,
    });
    const parent = await provider.resolveIssueByCanonicalRef("PRD-038");

    expect(parent).toEqual(
      expect.objectContaining({
        number: count,
        title: "PRD-038: Canonical closing-ref policy",
      })
    );
    expect(client.octokit.paginate).toHaveBeenCalledWith(
      client.octokit.rest.issues.listForRepo,
      expect.objectContaining({ per_page: 100 })
    );
  });

  it("paginates all issues with state all", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.paginate).mockResolvedValue([]);

    const provider = new GitHubIssueProvider(client);
    await provider.resolveIssueByCanonicalRef("PRD-038");

    expect(client.octokit.paginate).toHaveBeenCalledWith(
      client.octokit.rest.issues.listForRepo,
      expect.objectContaining({ state: "all" })
    );
  });
});

describe("GitHubIssueProvider closeIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("closes the issue via Octokit issues.update with state_reason completed", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.issues.get).mockResolvedValue({
      data: { number: 42, pull_request: undefined },
    } as never);
    vi.mocked(client.octokit.rest.issues.update).mockResolvedValue({
      data: {},
    } as never);

    const provider = new GitHubIssueProvider(client);
    await provider.closeIssue(42);

    expect(client.octokit.rest.issues.get).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      issue_number: 42,
    });
    expect(client.octokit.rest.issues.update).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      issue_number: 42,
      state: "closed",
      state_reason: "completed",
    });
  });

  it("skips close when issue number refers to a pull request", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.issues.get).mockResolvedValue({
      data: { number: 42, pull_request: { url: "pr-url" } },
    } as never);

    const provider = new GitHubIssueProvider(client);
    await provider.closeIssue(42);

    expect(client.octokit.rest.issues.update).not.toHaveBeenCalled();
  });

  it("propagates error when issues.get guard fails", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.issues.get).mockRejectedValue(
      new Error("not found")
    );

    const provider = new GitHubIssueProvider(client);

    await expect(provider.closeIssue(42)).rejects.toThrow("not found");
    expect(client.octokit.rest.issues.update).not.toHaveBeenCalled();
  });

  it("retries close after HTTP 503 transient error and resolves on second attempt", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.issues.get).mockResolvedValue({
      data: { number: 42, pull_request: undefined },
    } as never);
    vi.mocked(client.octokit.rest.issues.update)
      .mockRejectedValueOnce(new Error("HTTP 502 Bad Gateway"))
      .mockResolvedValueOnce({ data: {} } as never);

    const provider = new GitHubIssueProvider(client);
    await provider.closeIssue(42);

    expect(client.octokit.rest.issues.update).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient close error", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.issues.get).mockResolvedValue({
      data: { number: 42, pull_request: undefined },
    } as never);
    vi.mocked(client.octokit.rest.issues.update).mockRejectedValue(
      new Error("validation failed")
    );

    const provider = new GitHubIssueProvider(client);

    await expect(provider.closeIssue(42)).rejects.toThrow("validation failed");
    expect(client.octokit.rest.issues.update).toHaveBeenCalledTimes(1);
  });

  it("retries close on Octokit error with status 503", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.issues.get).mockResolvedValue({
      data: { number: 42, pull_request: undefined },
    } as never);
    const octokitError = Object.assign(new Error("Server Error"), {
      status: 503,
    });
    vi.mocked(client.octokit.rest.issues.update)
      .mockRejectedValueOnce(octokitError)
      .mockResolvedValueOnce({ data: {} } as never);

    const provider = new GitHubIssueProvider(client);
    await provider.closeIssue(42);

    expect(client.octokit.rest.issues.update).toHaveBeenCalledTimes(2);
  });
});

describe("GitHubIssueProvider fetchIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches issue details and paginated comments", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.issues.get).mockResolvedValue({
      data: {
        number: 1,
        title: "Test issue",
        body: "Test body",
        state: "open",
        labels: [{ name: "bug" }],
      },
    } as never);
    vi.mocked(client.octokit.paginate).mockResolvedValue([
      { body: "Comment 1" },
      { body: "Comment 2" },
    ]);

    const provider = new GitHubIssueProvider(client);
    const issue = await provider.fetchIssue(1);

    expect(issue.number).toBe(1);
    expect(issue.title).toBe("Test issue");
    expect(issue.body).toBe("Test body");
    expect(issue.state).toBe("open");
    expect(issue.labels).toEqual(["bug"]);
    expect(issue.comments).toEqual(["Comment 1", "Comment 2"]);
  });
});

describe("GitHubIssueProvider addLabels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds labels to an issue", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.issues.addLabels).mockResolvedValue({
      data: {},
    } as never);

    const provider = new GitHubIssueProvider(client);
    await provider.addLabels(1, ["label1", "label2"]);

    expect(client.octokit.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      issue_number: 1,
      labels: ["label1", "label2"],
    });
  });

  it("skips addLabels when labels array is empty", async () => {
    const client = makeClient();
    const provider = new GitHubIssueProvider(client);
    await provider.addLabels(1, []);

    expect(client.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
  });
});

describe("GitHubIssueProvider removeLabel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes a label from an issue", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.issues.removeLabel).mockResolvedValue({
      data: {},
    } as never);

    const provider = new GitHubIssueProvider(client);
    await provider.removeLabel(1, "blocked");

    expect(client.octokit.rest.issues.removeLabel).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      issue_number: 1,
      name: "blocked",
    });
  });
});

describe("GitHubIssueProvider commentIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a comment on an issue", async () => {
    const client = makeClient();
    vi.mocked(client.octokit.rest.issues.createComment).mockResolvedValue({
      data: {},
    } as never);

    const provider = new GitHubIssueProvider(client);
    await provider.commentIssue(1, "This is a comment");

    expect(client.octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      issue_number: 1,
      body: "This is a comment",
    });
  });
});
