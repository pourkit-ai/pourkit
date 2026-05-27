import { afterEach, describe, expect, it, vi } from "vitest";

const testRoot = vi.hoisted(() => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pourkit-close-issues-"))
  );
  fs.mkdirSync(path.join(root, "pourkit", "logs"), { recursive: true });
  return root;
});

const mockOctokit = vi.hoisted(() => {
  const mockFn = () => vi.fn();
  const issues = {
    get: mockFn(),
    update: mockFn(),
    addLabels: mockFn(),
    removeLabel: mockFn(),
    createComment: mockFn(),
    listForRepo: mockFn(),
  };
  return {
    rest: { issues },
    paginate: vi.fn(),
  };
});

const mocks = vi.hoisted(() => {
  const ensureDir = vi.fn();
  const requireGitHubClient = vi.fn();
  return { ensureDir, requireGitHubClient };
});

vi.mock("../shared/common", () => {
  const path = require("node:path");
  const root = testRoot;

  return {
    repoRoot: () => root,
    repoRelative: (r: string, ...seg: string[]) => path.join(r, ...seg),
    ensureDir: mocks.ensureDir,
    createLogger: () => ({
      line: vi.fn(),
      raw: vi.fn(),
      step: vi.fn(),
      status: vi.fn(),
      kv: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    TYPE_LABELS: [
      "type:bugfix",
      "type:infra",
      "type:feature",
      "type:polish",
      "type:refactor",
    ],
  };
});

vi.mock("../providers/github-client", () => ({
  requireGitHubClient: mocks.requireGitHubClient,
}));

import * as closeIssuesOnMerge from "./close-issues-on-merge";

describe("close issues on merge", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.POURKIT_PR_NUMBER;
    delete process.env.POURKIT_PR_TITLE;
    delete process.env.POURKIT_PR_BODY;
    process.exitCode = 0;
  });

  function setContext(body: string) {
    process.env.POURKIT_PR_NUMBER = "123";
    process.env.POURKIT_PR_TITLE = "Fix issue sync";
    process.env.POURKIT_PR_BODY = body;
  }

  function mockClient() {
    mocks.requireGitHubClient.mockResolvedValue({
      octokit: mockOctokit,
      owner: "pourkit",
      repo: "pourkit",
    });
  }

  it("parses and dedupes closing refs", () => {
    expect(
      closeIssuesOnMerge.parseClosingIssueNumbers(
        "fixes #1, closes #1 and resolves: #2"
      )
    ).toEqual([1, 2]);
  });

  it("requires token and repository upfront", async () => {
    mocks.requireGitHubClient.mockRejectedValue(
      new Error("GitHub token is required")
    );

    setContext("Closes #1");

    await closeIssuesOnMerge.main();
    expect(process.exitCode).toBe(1);

    expect(closeIssuesOnMerge.parseClosingIssueNumbers("Closes #1")).toEqual([
      1,
    ]);
  });

  it("skips work when no closing refs are present", async () => {
    mockClient();
    setContext("No closing refs here.");

    await expect(closeIssuesOnMerge.main()).resolves.toBeUndefined();

    expect(mockOctokit.rest.issues.get).not.toHaveBeenCalled();
    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("closes issues and unblocks dependents", async () => {
    mockClient();
    setContext("Fixes #11");

    const issueStates: Record<number, string> = {};

    mockOctokit.rest.issues.get.mockImplementation(
      async ({ issue_number }: { issue_number: number }) => {
        if (issue_number === 22) {
          return {
            data: {
              number: 22,
              id: 222,
              state: "open",
              title: "Dependent issue",
              body: null,
              labels: [{ name: "blocked" }, { name: "type:feature" }],
            },
          };
        }
        const state = issueStates[issue_number] ?? "open";
        return {
          data: {
            number: issue_number,
            id: Number(`${issue_number}${issue_number}${issue_number}`),
            state,
            title: state === "open" ? "Blocking issue" : "Closed issue",
            body: null,
            labels: [],
          },
        };
      }
    );

    mockOctokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 22,
          body: "## Blocked by\n\n- PRD-005 / I-05 (#11)",
          labels: [{ name: "blocked" }, { name: "type:feature" }],
          pull_request: false,
          state: "open",
          title: "Dependent issue",
        },
      ],
    });

    mockOctokit.rest.issues.update.mockImplementation(
      async ({ issue_number }: { issue_number: number }) => {
        issueStates[issue_number] = "closed";
        return { data: {} };
      }
    );

    mockOctokit.rest.issues.addLabels.mockResolvedValue({ data: {} });
    const notFound = new Error("Not Found");
    (notFound as any).status = 404;
    mockOctokit.rest.issues.removeLabel.mockRejectedValue(notFound);
    mockOctokit.rest.issues.createComment.mockResolvedValue({ data: {} });

    await expect(closeIssuesOnMerge.main()).resolves.toBeUndefined();

    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 11,
        body: expect.stringContaining("Closed automatically"),
      })
    );

    expect(mockOctokit.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 11,
        state: "closed",
        state_reason: "completed",
      })
    );

    expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 22,
        labels: expect.arrayContaining(["ready-for-agent"]),
      })
    );
  });

  it("dedupes repeated closing refs", async () => {
    mockClient();
    setContext("Fixes #7 and closes #7");

    const issueStates: Record<number, string> = { 7: "closed" };

    mockOctokit.rest.issues.get.mockImplementation(
      async ({ issue_number }: { issue_number: number }) => {
        return {
          data: {
            number: issue_number,
            id: Number(`${issue_number}${issue_number}${issue_number}`),
            state: issueStates[issue_number] ?? "closed",
            title: "Done",
            body: null,
            labels: [],
          },
        };
      }
    );

    mockOctokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });

    mockOctokit.rest.issues.update.mockImplementation(
      async ({ issue_number }: { issue_number: number }) => {
        issueStates[issue_number] = "closed";
        return { data: {} };
      }
    );

    await expect(closeIssuesOnMerge.main()).resolves.toBeUndefined();

    expect(
      mockOctokit.rest.issues.get.mock.calls.filter(
        (call) => call[0].issue_number === 7
      )
    ).toHaveLength(1);
  });

  it("processes remaining dependents when reconciling one dependent fails", async () => {
    mockClient();
    setContext("Fixes #11");

    const issueStates: Record<number, string> = {};

    mockOctokit.rest.issues.get.mockImplementation(
      async ({ issue_number }: { issue_number: number }) => {
        const state = issueStates[issue_number] ?? "open";
        return {
          data: {
            number: issue_number,
            id: Number(`${issue_number}${issue_number}${issue_number}`),
            state,
            title: "Issue",
            body: null,
            labels: [],
          },
        };
      }
    );

    mockOctokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 22,
          body: "## Blocked by\n\n- PRD-005 / I-05 (#11)",
          labels: [{ name: "blocked" }, { name: "type:feature" }],
          pull_request: false,
          state: "open",
          title: "Dependent issue",
        },
        {
          number: 33,
          body: "## Blocked by\n\n- Some other task (#11)",
          labels: [{ name: "blocked" }, { name: "type:bugfix" }],
          pull_request: false,
          state: "open",
          title: "Another dependent",
        },
      ],
    });

    mockOctokit.rest.issues.update.mockImplementation(
      async ({ issue_number }: { issue_number: number }) => {
        issueStates[issue_number] = "closed";
        return { data: {} };
      }
    );

    mockOctokit.rest.issues.addLabels.mockImplementation(
      async ({ issue_number }: { issue_number: number }) => {
        if (issue_number === 22) {
          throw new Error("Edit failed for issue 22");
        }
        return { data: {} };
      }
    );
    mockOctokit.rest.issues.removeLabel.mockImplementation(
      async ({ issue_number }: { issue_number: number }) => {
        if (issue_number === 22) {
          const err = new Error("Not Found");
          (err as any).status = 404;
          throw err;
        }
        return { data: {} };
      }
    );
    mockOctokit.rest.issues.createComment.mockResolvedValue({ data: {} });

    await expect(closeIssuesOnMerge.main()).resolves.toBeUndefined();

    const addLabelsCalls22 =
      mockOctokit.rest.issues.addLabels.mock.calls.filter(
        (call) => call[0].issue_number === 22
      );
    const addLabelsCalls33 =
      mockOctokit.rest.issues.addLabels.mock.calls.filter(
        (call) => call[0].issue_number === 33
      );

    expect(addLabelsCalls22.length).toBeGreaterThan(0);
    expect(addLabelsCalls33.length).toBeGreaterThan(0);
  });

  it("moves dependent without type label to needs-triage via shared transitions", async () => {
    mockClient();
    setContext("Fixes #11");

    const issueStates: Record<number, string> = {};
    const issueLabels: Record<number, { name: string }[]> = {
      22: [{ name: "blocked" }],
    };

    mockOctokit.rest.issues.get.mockImplementation(
      async ({ issue_number }: { issue_number: number }) => {
        const state = issueStates[issue_number] ?? "open";
        const labels = issueLabels[issue_number] ?? [];
        if (issue_number === 11) {
          return {
            data: {
              number: 11,
              id: 111,
              state,
              title: "Blocking issue",
              body: null,
              labels: [],
            },
          };
        }
        return {
          data: {
            number: issue_number,
            id: Number(`${issue_number}${issue_number}${issue_number}`),
            state,
            title: "Issue",
            body: null,
            labels,
          },
        };
      }
    );

    mockOctokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 22,
          body: "## Blocked by\n\n- PRD-005 / I-05 (#11)",
          labels: [{ name: "blocked" }],
          pull_request: false,
          state: "open",
          title: "No type label",
        },
      ],
    });

    mockOctokit.rest.issues.update.mockImplementation(
      async ({ issue_number }: { issue_number: number }) => {
        issueStates[issue_number] = "closed";
        return { data: {} };
      }
    );

    mockOctokit.rest.issues.addLabels.mockResolvedValue({ data: {} });
    mockOctokit.rest.issues.removeLabel.mockResolvedValue({ data: {} });
    mockOctokit.rest.issues.createComment.mockResolvedValue({ data: {} });

    await expect(closeIssuesOnMerge.main()).resolves.toBeUndefined();

    expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 22,
        labels: expect.arrayContaining(["needs-triage"]),
      })
    );
  });

  it("skips referenced pull requests", async () => {
    mockClient();
    setContext("Fixes #8");

    mockOctokit.rest.issues.get.mockImplementation(
      async ({ issue_number }: { issue_number: number }) => {
        if (issue_number === 8) {
          return {
            data: {
              number: 8,
              id: 808,
              state: "open",
              title: "Actually a PR",
              body: null,
              pull_request: {},
              labels: [],
            },
          };
        }
        throw new Error(`unexpected issue: ${issue_number}`);
      }
    );

    await expect(closeIssuesOnMerge.main()).resolves.toBeUndefined();

    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("retries transient label mutation errors during blocked reconciliation", async () => {
    mockClient();
    setContext("Fixes #11");

    const issueStates: Record<number, string> = {};

    mockOctokit.rest.issues.get.mockImplementation(
      async ({ issue_number }: { issue_number: number }) => {
        if (issue_number === 22) {
          return {
            data: {
              number: 22,
              id: 222,
              state: "open",
              title: "Dependent issue",
              body: null,
              labels: [{ name: "blocked" }, { name: "type:feature" }],
            },
          };
        }
        const state = issueStates[issue_number] ?? "open";
        return {
          data: {
            number: issue_number,
            id: Number(`${issue_number}${issue_number}${issue_number}`),
            state,
            title: "Blocking issue",
            body: null,
            labels: [],
          },
        };
      }
    );

    mockOctokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 22,
          body: "## Blocked by\n\n- PRD-005 / I-05 (#11)",
          labels: [{ name: "blocked" }, { name: "type:feature" }],
          pull_request: false,
          state: "open",
          title: "Dependent issue",
        },
      ],
    });

    mockOctokit.rest.issues.update.mockImplementation(
      async ({ issue_number }: { issue_number: number }) => {
        issueStates[issue_number] = "closed";
        return { data: {} };
      }
    );

    let addLabelsAttempts = 0;
    mockOctokit.rest.issues.addLabels.mockImplementation(
      async ({ issue_number }: { issue_number: number }) => {
        if (issue_number === 22) {
          addLabelsAttempts++;
          if (addLabelsAttempts === 1) {
            const err = new Error("Server Error");
            (err as any).status = 503;
            throw err;
          }
        }
        return { data: {} };
      }
    );
    mockOctokit.rest.issues.removeLabel.mockRejectedValue({
      status: 404,
    } as any);
    mockOctokit.rest.issues.createComment.mockResolvedValue({ data: {} });

    await expect(closeIssuesOnMerge.main()).resolves.toBeUndefined();

    const addLabelsCalls22 =
      mockOctokit.rest.issues.addLabels.mock.calls.filter(
        (call) => call[0].issue_number === 22
      );
    expect(addLabelsCalls22.length).toBeGreaterThan(1);
  });

  it("reports blocked reconciliation error when removeLabel fails with non-404 error", async () => {
    mockClient();
    setContext("Fixes #11");

    const issueStates: Record<number, string> = {};

    mockOctokit.rest.issues.get.mockImplementation(
      async ({ issue_number }: { issue_number: number }) => {
        const state = issueStates[issue_number] ?? "open";
        return {
          data: {
            number: issue_number,
            id: Number(`${issue_number}${issue_number}${issue_number}`),
            state,
            title: "Issue",
            body: null,
            labels: [],
          },
        };
      }
    );

    mockOctokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 22,
          body: "## Blocked by\n\n- PRD-005 / I-05 (#11)",
          labels: [{ name: "blocked" }, { name: "type:feature" }],
          pull_request: false,
          state: "open",
          title: "Dependent issue",
        },
      ],
    });

    mockOctokit.rest.issues.update.mockImplementation(
      async ({ issue_number }: { issue_number: number }) => {
        issueStates[issue_number] = "closed";
        return { data: {} };
      }
    );

    const serverError = new Error("Server Error");
    (serverError as any).status = 500;
    mockOctokit.rest.issues.removeLabel.mockRejectedValue(serverError);
    mockOctokit.rest.issues.addLabels.mockResolvedValue({ data: {} });
    mockOctokit.rest.issues.createComment.mockResolvedValue({ data: {} });

    await expect(closeIssuesOnMerge.main()).resolves.toBeUndefined();

    const addLabelsCalls22 =
      mockOctokit.rest.issues.addLabels.mock.calls.filter(
        (call) => call[0].issue_number === 22
      );
    expect(addLabelsCalls22).toHaveLength(0);
  });
});
