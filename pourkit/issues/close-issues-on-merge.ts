import { fileURLToPath } from "node:url";

import {
  createLogger,
  ensureDir,
  repoRelative,
  repoRoot,
} from "../shared/common";
import { TYPE_LABELS } from "../shared/common";
import type { GitHubClient } from "../providers/github-client";
import { requireGitHubClient } from "../providers/github-client";
import {
  parseBlockedBy,
  reconcileBlockedIssues,
  type BlockedIssue,
} from "./blocked-issue";
import {
  createIssueTransitions,
  type IssueTransitionDeps,
} from "./issue-transitions";

type Issue = {
  number: number;
  id: number;
  state: string;
  pull_request?: unknown;
  title: string;
  body: string | null;
};

type RunContext = {
  client: GitHubClient;
  prNumber: number;
  prTitle: string;
  prBody: string;
};

const ROOT = repoRoot();
process.chdir(ROOT);

const LOG_DIR = repoRelative(ROOT, "pourkit", "logs");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_PATH = repoRelative(
  ROOT,
  "pourkit",
  "logs",
  `close-issues-on-merge-${RUN_ID}.log`
);
const logger = createLogger("close-issues-on-merge", LOG_PATH);
const __filename = fileURLToPath(import.meta.url);

async function main() {
  try {
    await ensureDir(LOG_DIR);
    logger.status("starting");
    const client = await requireGitHubClient();
    const context = readContext(client);
    logger.kv("POURKIT_PR_NUMBER", String(context.prNumber));
    logger.kv("POURKIT_PR_TITLE", context.prTitle);
    await closeIssuesOnMerge(context);
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

async function closeIssuesOnMerge(context: RunContext) {
  const issueNumbers = parseClosingIssueNumbers(context.prBody);

  if (issueNumbers.length === 0) {
    logger.step(
      "skip",
      "No issues referenced with closing keywords. Skipping."
    );
    return;
  }

  logger.kv("closing_issue_count", String(issueNumbers.length));

  for (const issueNumber of issueNumbers) {
    try {
      await processIssue(context, issueNumber);
    } catch (error) {
      logger.step(
        "error",
        `Error processing issue #${issueNumber}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

async function processIssue(context: RunContext, issueNumber: number) {
  const issue = await getIssue(context, issueNumber);

  if (issue.pull_request) {
    logger.step(
      "skip",
      `#${issueNumber} is a pull request, not an issue. Skipping.`
    );
    return;
  }

  if (issue.state === "open") {
    await commentOnClosedIssue(context, issueNumber);
    await closeIssue(context, issueNumber);
    logger.step("close", `Closed issue #${issueNumber}`);
  } else {
    logger.step("skip", `Issue #${issueNumber} is already closed.`);
  }

  const blockedIssues = await listIssuesBlockedBy(context, issueNumber);

  if (blockedIssues.length === 0) {
    logger.step(
      "skip",
      `Issue #${issueNumber} was not blocking any other issues.`
    );
    return;
  }

  logger.step(
    "unblock",
    `Issue #${issueNumber} was blocking ${blockedIssues.length} issue(s).`
  );

  const getIssueState = async (blockedIssueNumber: number) => {
    const { data } = await context.client.octokit.rest.issues.get({
      owner: context.client.owner,
      repo: context.client.repo,
      issue_number: blockedIssueNumber,
    });
    return (data.state as string).toUpperCase();
  };

  const transitionDeps: IssueTransitionDeps = {
    fetchIssue: async (issueNumber) => {
      const { data } = await context.client.octokit.rest.issues.get({
        owner: context.client.owner,
        repo: context.client.repo,
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
        context.client.octokit.rest.issues.addLabels({
          owner: context.client.owner,
          repo: context.client.repo,
          issue_number: issueNumber,
          labels,
        })
      );
    },
    removeLabel: async (issueNumber, label) => {
      try {
        await withRetryOnTransient(() =>
          context.client.octokit.rest.issues.removeLabel({
            owner: context.client.owner,
            repo: context.client.repo,
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
            context.client.octokit.rest.issues.removeLabel({
              owner: context.client.owner,
              repo: context.client.repo,
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
          context.client.octokit.rest.issues.addLabels({
            owner: context.client.owner,
            repo: context.client.repo,
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

  for (const blockedIssue of blockedIssues) {
    try {
      const [reconcileEntry] = await reconcileBlockedIssues([blockedIssue], {
        getIssueState,
        transitions,
        typeLabels: TYPE_LABELS,
        readyLabel: "ready-for-agent",
      });

      if (reconcileEntry.result === "still-blocked") {
        logger.step(
          "skip",
          `Issue #${blockedIssue.number} is still blocked by another issue.`
        );
        continue;
      }

      try {
        await commentOnUnblockedIssue(
          context,
          blockedIssue.number,
          issueNumber
        );

        logger.step("unblocked", `Unblocked issue #${blockedIssue.number}.`);
      } catch (error) {
        logger.step(
          "error",
          `Failed to unblock issue #${blockedIssue.number} from #${issueNumber}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } catch (error) {
      logger.step(
        "error",
        `Failed to check blockers for issue #${blockedIssue.number}.`
      );
    }
  }
}

async function getIssue(
  context: RunContext,
  issueNumber: number
): Promise<Issue> {
  const { data } = await context.client.octokit.rest.issues.get({
    owner: context.client.owner,
    repo: context.client.repo,
    issue_number: issueNumber,
  });
  return {
    number: data.number,
    id: data.id,
    state: data.state,
    pull_request: data.pull_request,
    title: data.title,
    body: data.body ?? null,
  };
}

async function closeIssue(context: RunContext, issueNumber: number) {
  const maxRetries = 3;
  const backoffMs = 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await context.client.octokit.rest.issues.update({
        owner: context.client.owner,
        repo: context.client.repo,
        issue_number: issueNumber,
        state: "closed",
        state_reason: "completed",
      });
      return;
    } catch (error) {
      const isTransient =
        error instanceof Error && /HTTP (502|503|504)\b/.test(error.message);
      const isOctokitTransient =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        (error.status === 502 || error.status === 503 || error.status === 504);
      if ((!isTransient && !isOctokitTransient) || attempt === maxRetries) {
        throw error;
      }
      await new Promise((r) =>
        setTimeout(r, backoffMs * Math.pow(2, attempt - 1))
      );
    }
  }
}

async function commentOnClosedIssue(context: RunContext, issueNumber: number) {
  await context.client.octokit.rest.issues.createComment({
    owner: context.client.owner,
    repo: context.client.repo,
    issue_number: issueNumber,
    body: `Closed automatically because PR #${context.prNumber} (${context.prTitle}) merged into \`next\`.`,
  });
}

async function listIssuesBlockedBy(
  context: RunContext,
  blockingIssueNumber: number
): Promise<BlockedIssue[]> {
  const { data } = await context.client.octokit.rest.issues.listForRepo({
    owner: context.client.owner,
    repo: context.client.repo,
    state: "open",
    labels: "blocked",
    per_page: 100,
  });

  const allIssues = data
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      body: issue.body ?? null,
      labels: issue.labels.map((l: string | { name?: string | null }) => ({
        name: typeof l === "string" ? l : (l.name ?? ""),
      })),
    }));

  const matching: BlockedIssue[] = [];
  for (const issue of allIssues) {
    const blockers = parseBlockedBy(issue.body);
    if (blockers.includes(blockingIssueNumber)) {
      matching.push({
        number: issue.number,
        body: issue.body,
        labels: issue.labels,
      });
    }
  }
  return matching;
}

async function commentOnUnblockedIssue(
  context: RunContext,
  blockedIssueNumber: number,
  issueNumber: number
) {
  await context.client.octokit.rest.issues.createComment({
    owner: context.client.owner,
    repo: context.client.repo,
    issue_number: blockedIssueNumber,
    body: `Unblocked automatically because #${issueNumber} was closed by PR #${context.prNumber}.`,
  });
}

function readContext(client: GitHubClient): RunContext {
  const prNumber = Number(process.env.POURKIT_PR_NUMBER);
  const prTitle = process.env.POURKIT_PR_TITLE?.trim();
  const prBody = process.env.POURKIT_PR_BODY ?? "";

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("POURKIT_PR_NUMBER is required");
  }

  if (!prTitle) {
    throw new Error("POURKIT_PR_TITLE is required");
  }

  return { client, prNumber, prTitle, prBody };
}

export function parseClosingIssueNumbers(body: string | null) {
  if (!body) return [];

  const regex =
    /(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s*:?\s*#(\d+)/gi;
  const issueNumbers = new Set<number>();
  let match: RegExpExecArray | null;

  while ((match = regex.exec(body)) !== null) {
    issueNumbers.add(Number.parseInt(match[1], 10));
  }

  return [...issueNumbers];
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

if (process.argv[1] === __filename) {
  void main();
}

export { main };
