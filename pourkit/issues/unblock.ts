import { repoRoot, repoRelative, createLogger } from "../shared/common";
import { fileURLToPath } from "node:url";
import { TYPE_LABELS } from "../shared/common";
import { reconcileBlockedIssues } from "./blocked-issue";
import { createIssueTransitions } from "./issue-transitions";
import type { IssueTransitionDeps } from "./issue-transitions";
import type { GitHubClient } from "../providers/github-client";
import { requireGitHubClient } from "../providers/github-client";

const ROOT = repoRoot();
process.chdir(ROOT);

const LOG_DIR = repoRelative(ROOT, "pourkit", "logs");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_PATH = repoRelative(LOG_DIR, `unblock-${RUN_ID}.log`);
const logger = createLogger("unblock", LOG_PATH);
const __filename = fileURLToPath(import.meta.url);

type Issue = {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
};

async function main() {
  try {
    logger.status("starting");
    const client = await requireGitHubClient();
    await unblock(client);
    logger.status("completed");
  } catch (error) {
    logger.status("failed");
    logger.line(
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    );
    process.exitCode = 1;
  } finally {
    await logger.close();
  }
}

async function withRetryOnTransient<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 2
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isTransient =
        (error instanceof Error &&
          /HTTP (502|503|504)\b/.test(error.message)) ||
        (typeof error === "object" &&
          error !== null &&
          "status" in error &&
          ((error as { status: number }).status === 502 ||
            (error as { status: number }).status === 503 ||
            (error as { status: number }).status === 504));
      if (!isTransient || attempt === maxAttempts) {
        throw error;
      }
      await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
    }
  }
  throw lastError as Error;
}

async function unblock(client: GitHubClient) {
  const issues = await listBlockedIssues(client);
  logger.kv("POURKIT_BLOCKED_COUNT", String(issues.length));

  const issueTitles = new Map(issues.map((i) => [i.number, i.title]));

  const transitionDeps: IssueTransitionDeps = {
    fetchIssue: async (issueNumber: number) => {
      const { data } = await client.octokit.rest.issues.get({
        owner: client.owner,
        repo: client.repo,
        issue_number: issueNumber,
      });
      return {
        labels: data.labels.map((l) =>
          typeof l === "string" ? l : (l.name ?? "")
        ),
      };
    },
    addLabels: async (issueNumber, labels) => {
      await withRetryOnTransient(() =>
        client.octokit.rest.issues.addLabels({
          owner: client.owner,
          repo: client.repo,
          issue_number: issueNumber,
          labels,
        })
      );
    },
    removeLabel: async (issueNumber, label) => {
      try {
        await withRetryOnTransient(() =>
          client.octokit.rest.issues.removeLabel({
            owner: client.owner,
            repo: client.repo,
            issue_number: issueNumber,
            name: label,
          })
        );
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          (error as { status: number }).status === 404
        ) {
          // Label may not exist
        } else {
          throw error;
        }
      }
    },
    updateLabels: async (issueNumber, removes, adds) => {
      for (const label of removes) {
        try {
          await withRetryOnTransient(() =>
            client.octokit.rest.issues.removeLabel({
              owner: client.owner,
              repo: client.repo,
              issue_number: issueNumber,
              name: label,
            })
          );
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "status" in error &&
            (error as { status: number }).status === 404
          ) {
            // Label may not exist
          } else {
            throw error;
          }
        }
      }
      if (adds.length > 0) {
        await withRetryOnTransient(() =>
          client.octokit.rest.issues.addLabels({
            owner: client.owner,
            repo: client.repo,
            issue_number: issueNumber,
            labels: adds,
          })
        );
      }
    },
  };

  const transitions = createIssueTransitions(transitionDeps, {
    blocked: "blocked",
    readyForAgent: "ready-for-agent",
    needsTriage: "needs-triage",
    agentInProgress: "agent-in-progress",
    readyForHuman: "ready-for-human",
    prOpenAwaitingMerge: "pr-open-awaiting-merge",
  });

  const results = await reconcileBlockedIssues(issues, {
    getIssueState: async (issueNumber: number) => {
      const { data } = await client.octokit.rest.issues.get({
        owner: client.owner,
        repo: client.repo,
        issue_number: issueNumber,
      });
      return (data.state as string).toUpperCase();
    },
    transitions,
    typeLabels: TYPE_LABELS,
    readyLabel: "ready-for-agent",
  });

  for (const { issueNumber, result } of results) {
    const title = issueTitles.get(issueNumber) ?? `#${issueNumber}`;
    logger.step("process", `#${issueNumber}: ${title}`);

    if (result === "still-blocked") {
      logger.step("skip", `#${issueNumber}: still blocked`);
      continue;
    }

    logger.step("unblock", `#${issueNumber}: all blockers resolved`);

    if (result === "unblocked") {
      logger.step("done", `#${issueNumber}: unblocked and ready`);
      continue;
    }

    logger.step(
      "needs_triage",
      `#${issueNumber}: moved to needs-triage (missing or conflicting type labels)`
    );
  }
}

async function listBlockedIssues(client: GitHubClient): Promise<Issue[]> {
  const { data } = await client.octokit.rest.issues.listForRepo({
    owner: client.owner,
    repo: client.repo,
    state: "open",
    per_page: 100,
    labels: "blocked",
  });

  return data
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      labels: issue.labels.map((l) => ({
        name: typeof l === "string" ? l : (l.name ?? ""),
      })),
    }));
}

if (process.argv[1] === __filename) {
  void main();
}

export { main };
