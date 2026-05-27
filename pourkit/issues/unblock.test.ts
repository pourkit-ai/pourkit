import { describe, it, expect, vi, afterEach } from "vitest";

const testRoot = vi.hoisted(() => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pourkit-unblock-"))
  );
  fs.mkdirSync(path.join(root, "pourkit", "logs"), { recursive: true });
  return root;
});

const mockOctokit = vi.hoisted(() => {
  const mockFn = () => vi.fn();
  const issues = {
    get: mockFn(),
    addLabels: mockFn(),
    removeLabel: mockFn(),
    listForRepo: mockFn(),
  };
  return {
    rest: { issues },
  };
});

const mocks = vi.hoisted(() => {
  const requireGitHubClient = vi.fn();
  return { requireGitHubClient };
});

vi.mock("../shared/common", () => {
  const path = require("node:path");
  const root = testRoot;

  return {
    repoRoot: () => root,
    repoRelative: (r: string, ...seg: string[]) => path.join(r, ...seg),
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

import * as unblock from "./unblock";

describe("unblock dependency sync", () => {
  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
  });

  function mockClient() {
    mocks.requireGitHubClient.mockResolvedValue({
      octokit: mockOctokit,
      owner: "pourkit",
      repo: "pourkit",
    });
  }

  function setupIssueGet(
    labelsForIssue: Record<
      number,
      { state?: string; labels?: { name: string }[] }
    >
  ) {
    mockOctokit.rest.issues.get.mockImplementation(
      async ({ issue_number }: { issue_number: number }) => {
        const config = labelsForIssue[issue_number] ?? {};
        return {
          data: {
            number: issue_number,
            state: config.state ?? "open",
            labels: config.labels ?? [],
            title: "",
            body: null,
          },
        };
      }
    );
  }

  it("removes blocked and adds ready-for-agent when all blockers are closed", async () => {
    mockClient();

    mockOctokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 8,
          title: "Blocked issue",
          body: "## Blocked by\n- #1\n- #2",
          labels: [{ name: "blocked" }, { name: "type:feature" }],
          pull_request: false,
          state: "open",
        },
      ],
    });

    setupIssueGet({
      8: { labels: [{ name: "blocked" }, { name: "type:feature" }] },
      1: { state: "CLOSED" },
      2: { state: "CLOSED" },
    });

    mockOctokit.rest.issues.addLabels.mockResolvedValue({ data: {} });
    mockOctokit.rest.issues.removeLabel.mockResolvedValue({ data: {} });

    await expect(unblock.main()).resolves.toBeUndefined();

    expect(mockOctokit.rest.issues.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 8,
        name: "blocked",
      })
    );

    expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 8,
        labels: expect.arrayContaining(["ready-for-agent"]),
      })
    );
  });

  it("leaves issue blocked when any blocker is still open", async () => {
    mockClient();

    mockOctokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 9,
          title: "Still blocked issue",
          body: "## Blocked by\n- #1\n- #2",
          labels: [{ name: "blocked" }, { name: "type:feature" }],
          pull_request: false,
          state: "open",
        },
      ],
    });

    setupIssueGet({
      1: { state: "CLOSED" },
      2: { state: "OPEN" },
    });

    await expect(unblock.main()).resolves.toBeUndefined();

    expect(mockOctokit.rest.issues.removeLabel).not.toHaveBeenCalled();
    expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
  });

  it("does not add ready-for-agent when it is already present", async () => {
    mockClient();

    mockOctokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 10,
          title: "Already ready issue",
          body: "## Blocked by\n- #1",
          labels: [
            { name: "blocked" },
            { name: "ready-for-agent" },
            { name: "type:feature" },
          ],
          pull_request: false,
          state: "open",
        },
      ],
    });

    setupIssueGet({
      10: {
        labels: [
          { name: "blocked" },
          { name: "ready-for-agent" },
          { name: "type:feature" },
        ],
      },
      1: { state: "CLOSED" },
    });

    mockOctokit.rest.issues.addLabels.mockResolvedValue({ data: {} });
    mockOctokit.rest.issues.removeLabel.mockResolvedValue({ data: {} });

    await expect(unblock.main()).resolves.toBeUndefined();

    const addLabelsCalls = mockOctokit.rest.issues.addLabels.mock.calls.filter(
      (call) => call[0].issue_number === 10
    );
    expect(addLabelsCalls).toHaveLength(0);

    expect(mockOctokit.rest.issues.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 10,
        name: "blocked",
      })
    );
  });

  it("moves malformed blocked issues back to needs-triage", async () => {
    mockClient();

    mockOctokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 7,
          title: "Blocked issue with no section",
          body: "This issue should be blocked but has no dependency section.",
          labels: [{ name: "blocked" }, { name: "type:feature" }],
          pull_request: false,
          state: "open",
        },
      ],
    });

    setupIssueGet({});

    mockOctokit.rest.issues.addLabels.mockResolvedValue({ data: {} });
    mockOctokit.rest.issues.removeLabel.mockResolvedValue({ data: {} });

    await expect(unblock.main()).resolves.toBeUndefined();

    expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 7,
        labels: expect.arrayContaining(["needs-triage"]),
      })
    );

    expect(mockOctokit.rest.issues.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 7,
        name: "blocked",
      })
    );
  });

  it("moves unblocked issues without a type label to needs-triage", async () => {
    mockClient();

    mockOctokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 11,
          title: "No type label",
          body: "## Blocked by\n- #1",
          labels: [{ name: "blocked" }],
          pull_request: false,
          state: "open",
        },
      ],
    });

    setupIssueGet({
      1: { state: "CLOSED" },
    });

    mockOctokit.rest.issues.addLabels.mockResolvedValue({ data: {} });
    mockOctokit.rest.issues.removeLabel.mockResolvedValue({ data: {} });

    await expect(unblock.main()).resolves.toBeUndefined();

    expect(mockOctokit.rest.issues.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 11,
        name: "blocked",
      })
    );

    expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 11,
        labels: expect.arrayContaining(["needs-triage"]),
      })
    );
  });

  it("moves unblocked issues with multiple type labels to needs-triage", async () => {
    mockClient();

    mockOctokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 12,
          title: "Conflicting type labels",
          body: "## Blocked by\n- #1",
          labels: [
            { name: "blocked" },
            { name: "type:feature" },
            { name: "type:bugfix" },
          ],
          pull_request: false,
          state: "open",
        },
      ],
    });

    setupIssueGet({
      1: { state: "CLOSED" },
    });

    mockOctokit.rest.issues.addLabels.mockResolvedValue({ data: {} });
    mockOctokit.rest.issues.removeLabel.mockResolvedValue({ data: {} });

    await expect(unblock.main()).resolves.toBeUndefined();

    expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 12,
        labels: expect.arrayContaining(["needs-triage"]),
      })
    );
  });

  it("sets failure exit code when a reconciliation dependency rejects", async () => {
    mockClient();

    mockOctokit.rest.issues.listForRepo.mockRejectedValue(
      new Error("Octokit call failed")
    );

    await unblock.main();
    expect(process.exitCode).toBe(1);
  });

  it("reports failure when removeLabel fails with non-404 error", async () => {
    mockClient();

    mockOctokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 8,
          title: "Blocked issue",
          body: "## Blocked by\n- #1\n- #2",
          labels: [{ name: "blocked" }, { name: "type:feature" }],
          pull_request: false,
          state: "open",
        },
      ],
    });

    setupIssueGet({
      8: { labels: [{ name: "blocked" }, { name: "type:feature" }] },
      1: { state: "CLOSED" },
      2: { state: "CLOSED" },
    });

    const serverError = new Error("Internal Server Error");
    (serverError as any).status = 500;
    mockOctokit.rest.issues.removeLabel.mockRejectedValue(serverError);
    mockOctokit.rest.issues.addLabels.mockResolvedValue({ data: {} });

    await unblock.main();
    expect(process.exitCode).toBe(1);
    expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
  });

  it("retries removeLabel on transient 502 Octokit error and succeeds", async () => {
    mockClient();

    mockOctokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 13,
          title: "Retry test issue",
          body: "## Blocked by\n- #1",
          labels: [{ name: "blocked" }, { name: "type:feature" }],
          pull_request: false,
          state: "open",
        },
      ],
    });

    setupIssueGet({
      13: { labels: [{ name: "blocked" }, { name: "type:feature" }] },
      1: { state: "CLOSED" },
    });

    const serverError = Object.assign(new Error("Server Error"), {
      status: 502,
    });
    mockOctokit.rest.issues.removeLabel
      .mockRejectedValueOnce(serverError)
      .mockResolvedValue({ data: {} });

    mockOctokit.rest.issues.addLabels.mockResolvedValue({ data: {} });

    await expect(unblock.main()).resolves.toBeUndefined();

    expect(mockOctokit.rest.issues.removeLabel).toHaveBeenCalledTimes(2);
    expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 13,
        labels: expect.arrayContaining(["ready-for-agent"]),
      })
    );
  });

  it("retries addLabels on transient 503 Octokit error and succeeds", async () => {
    mockClient();

    mockOctokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 14,
          title: "Retry test addLabels",
          body: "## Blocked by\n- #1",
          labels: [{ name: "blocked" }, { name: "type:feature" }],
          pull_request: false,
          state: "open",
        },
      ],
    });

    setupIssueGet({
      14: { labels: [{ name: "blocked" }, { name: "type:feature" }] },
      1: { state: "CLOSED" },
    });

    mockOctokit.rest.issues.removeLabel.mockResolvedValue({ data: {} });

    const serverError = Object.assign(new Error("Server Error"), {
      status: 503,
    });
    mockOctokit.rest.issues.addLabels
      .mockRejectedValueOnce(serverError)
      .mockResolvedValue({ data: {} });

    await expect(unblock.main()).resolves.toBeUndefined();

    expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledTimes(2);
  });
});
