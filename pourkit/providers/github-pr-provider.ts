import type {
  PRProvider,
  PullRequest,
  CreatePrOptions,
  CheckStatus,
  EnableAutoMergeOptions,
  MergePrOptions,
  WaitForPrChecksOptions,
  BranchStatus,
} from "./pr-provider";
import { sleep } from "../shared/common";
import type { PourkitLogger } from "../shared/common";
import type { GitHubClient } from "./github-client";

const TERMINAL_FAILURE_STATES = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
  "STALE",
]);

const GREEN_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

export class GitHubPRProvider implements PRProvider {
  private client: GitHubClient;
  private logger: PourkitLogger;

  constructor(client: GitHubClient, logger: PourkitLogger) {
    this.client = client;
    this.logger = logger;
  }

  async createPr(options: CreatePrOptions): Promise<PullRequest> {
    this.logger.step("pr", `creating PR "${options.title}"`);

    const { data } = await this.client.octokit.rest.pulls.create({
      owner: this.client.owner,
      repo: this.client.repo,
      title: options.title,
      body: options.body,
      head: options.head,
      base: options.base,
    });

    const pr = mapOctokitPr(data);

    this.logger.kv("PR_NUMBER", String(pr.number));
    this.logger.kv("PR_URL", pr.url);

    return pr;
  }

  async getPr(branchName: string): Promise<PullRequest | null> {
    try {
      const { data } = await this.client.octokit.rest.pulls.list({
        owner: this.client.owner,
        repo: this.client.repo,
        head: `${this.client.owner}:${branchName}`,
        state: "all",
        per_page: 1,
      });

      if (data.length === 0) {
        return null;
      }

      return mapOctokitPr(data[0]);
    } catch {
      return null;
    }
  }

  async getPrByNumber(prNumber: number): Promise<PullRequest | null> {
    try {
      const { data } = await this.client.octokit.rest.pulls.get({
        owner: this.client.owner,
        repo: this.client.repo,
        pull_number: prNumber,
      });

      return mapOctokitPr(data);
    } catch {
      return null;
    }
  }

  async getCheckStatus(prNumber: number): Promise<CheckStatus[]> {
    try {
      const { data: pr } = await this.client.octokit.rest.pulls.get({
        owner: this.client.owner,
        repo: this.client.repo,
        pull_number: prNumber,
      });

      const headSha = pr.head.sha;

      const [checkRuns, combinedStatusResponse] = await Promise.all([
        this.client.octokit.paginate(
          this.client.octokit.rest.checks.listForRef,
          {
            owner: this.client.owner,
            repo: this.client.repo,
            ref: headSha,
          }
        ),
        this.client.octokit.rest.repos.getCombinedStatusForRef({
          owner: this.client.owner,
          repo: this.client.repo,
          ref: headSha,
        }),
      ]);

      const checks: CheckStatus[] = [];

      for (const run of checkRuns) {
        checks.push({
          name: run.name,
          conclusion: mapCheckConclusion(run.conclusion),
          status: mapCheckRunStatus(run.status),
        });
      }

      for (const status of combinedStatusResponse.data.statuses) {
        checks.push(
          mapCommitStatus({ context: status.context, state: status.state })
        );
      }

      return checks;
    } catch (error) {
      this.logger.step(
        "warn",
        `Failed to get check status for PR #${prNumber}: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }

  async enableAutoMerge(
    pr: PullRequest,
    options?: EnableAutoMergeOptions
  ): Promise<void> {
    const method = (options?.method ?? "squash").toUpperCase();

    await this.client.octokit.graphql(
      `mutation enablePullRequestAutoMerge(
        $pullRequestId: ID!
        $mergeMethod: PullRequestMergeMethod
        $expectedHeadOid: GitObjectID
      ) {
        enablePullRequestAutoMerge(input: {
          pullRequestId: $pullRequestId
          mergeMethod: $mergeMethod
          expectedHeadOid: $expectedHeadOid
        }) {
          pullRequest {
            id
            number
          }
        }
      }`,
      {
        pullRequestId: pr.nodeId,
        mergeMethod: method,
        expectedHeadOid: options?.expectedHeadOid,
      }
    );
  }

  async mergePr(prNumber: number, options?: MergePrOptions): Promise<void> {
    const method = options?.method ?? "squash";
    this.logger.step("pr", `merging PR #${prNumber} with ${method} merge`);

    await this.client.octokit.rest.pulls.merge({
      owner: this.client.owner,
      repo: this.client.repo,
      pull_number: prNumber,
      merge_method: method,
      sha: options?.matchHeadCommit,
    });
  }

  async waitForPrChecks(
    prNumber: number,
    options?: WaitForPrChecksOptions
  ): Promise<CheckStatus[]> {
    const checksFoundTimeoutMs = options?.checksFoundTimeoutMs ?? 60 * 1000;
    const checksCompletionTimeoutMs =
      options?.checksCompletionTimeoutMs ?? 30 * 60 * 1000;
    const pollIntervalMs = options?.pollIntervalMs ?? 15 * 1000;
    const requiredChecks = options?.requiredChecks ?? [];

    const discoveredDeadline = Date.now() + checksFoundTimeoutMs;
    let completionDeadline = 0;
    let checksDiscovered = false;
    this.logger.step("pr", `waiting for checks on PR #${prNumber}`);

    while (true) {
      const observedAt = Date.now();
      const checks = await this.getCheckStatus(prNumber);

      if (!hasRequiredChecks(checks, requiredChecks)) {
        if (Date.now() >= discoveredDeadline) {
          if (requiredChecks.length === 0) {
            this.logger.step(
              "info",
              "No checks appeared within grace period, treating as passed"
            );
            return [];
          }

          throw new Error(
            `Timeout waiting for required checks on PR #${prNumber}: ${requiredChecks.join(", ")}`
          );
        }

        this.logger.step(
          "info",
          requiredChecks.length === 0
            ? `No checks found, waiting... (${secondsRemaining(discoveredDeadline, observedAt)}s remaining)`
            : `Waiting for required checks to appear: ${requiredChecks.join(", ")} (${secondsRemaining(discoveredDeadline, observedAt)}s remaining)`
        );
        await sleep(pollIntervalMs);
        continue;
      }

      const filteredChecks = filterChecks(checks, requiredChecks);

      if (!checksDiscovered) {
        checksDiscovered = true;
        completionDeadline = observedAt + checksCompletionTimeoutMs;
      }

      this.logger.step("info", `Checks: ${formatChecks(filteredChecks)}`);

      const evaluation = evaluateChecks(filteredChecks);
      if (evaluation.complete && evaluation.failed.length === 0) {
        this.logger.step("success", "All checks passed");
        return checks;
      }

      if (evaluation.complete) {
        throw new Error(`Checks failed: ${formatChecks(evaluation.failed)}`);
      }

      if (Date.now() >= completionDeadline) {
        throw new Error(`Timeout waiting for checks on PR #${prNumber}`);
      }

      this.logger.step(
        "info",
        `Checks still pending, waiting... (${secondsRemaining(completionDeadline, observedAt)}s remaining)`
      );
      await sleep(pollIntervalMs);
    }
  }

  async getBranchStatus(branchName: string): Promise<BranchStatus> {
    this.logger.step("pr", `getting branch status for ${branchName}`);

    try {
      const targetStatus = await this.getTargetBranchStatus(branchName);

      let state: BranchStatus["state"] = "pending";

      if (targetStatus.checks.length > 0) {
        const hasFailure = targetStatus.checks.some(
          (check) =>
            check.conclusion !== null &&
            TERMINAL_FAILURE_STATES.has(check.conclusion)
        );
        const allComplete = targetStatus.checks.every(
          (check) => check.status === "COMPLETED"
        );
        const allGreen = targetStatus.checks.every(
          (check) =>
            check.conclusion !== null &&
            GREEN_CHECK_CONCLUSIONS.has(check.conclusion)
        );

        if (hasFailure) {
          state = "red";
        } else if (allComplete && allGreen) {
          state = "green";
        }
      }

      return {
        headSha: targetStatus.headSha,
        state,
        checks: targetStatus.checks,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to get branch status for ${branchName}: ${message}`
      );
    }
  }

  private async getTargetBranchStatus(
    branchName: string
  ): Promise<{ branchName: string; headSha: string; checks: CheckStatus[] }> {
    const { data: branch } = await this.client.octokit.rest.repos.getBranch({
      owner: this.client.owner,
      repo: this.client.repo,
      branch: branchName,
    });

    const headSha = branch.commit.sha;

    const [checkRuns, combinedStatusResponse] = await Promise.all([
      this.client.octokit.paginate(this.client.octokit.rest.checks.listForRef, {
        owner: this.client.owner,
        repo: this.client.repo,
        ref: headSha,
      }),
      this.client.octokit.rest.repos.getCombinedStatusForRef({
        owner: this.client.owner,
        repo: this.client.repo,
        ref: headSha,
      }),
    ]);

    return {
      branchName,
      headSha,
      checks: [
        ...checkRuns.map((check) => ({
          name: check.name,
          status: mapCheckRunStatus(check.status),
          conclusion: mapCheckConclusion(check.conclusion),
        })),
        ...combinedStatusResponse.data.statuses.map((status) =>
          mapCommitStatus(status)
        ),
      ],
    };
  }
}

function mapOctokitPr(data: {
  number: number;
  node_id: string;
  html_url: string;
  title: string;
  body: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  state: string;
  merged?: boolean;
  draft?: boolean;
}): PullRequest {
  return {
    number: data.number,
    nodeId: data.node_id,
    url: data.html_url,
    title: data.title,
    body: data.body ?? "",
    headRefName: data.head.ref,
    baseRefName: data.base.ref,
    state:
      data.state === "closed" ? (data.merged ? "MERGED" : "CLOSED") : "OPEN",
    headRefOid: data.head.sha,
  };
}

function mapCheckRunStatus(status: string): CheckStatus["status"] {
  const normalized = status.toUpperCase();

  if (
    normalized === "QUEUED" ||
    normalized === "IN_PROGRESS" ||
    normalized === "COMPLETED" ||
    normalized === "WAITING" ||
    normalized === "PENDING" ||
    normalized === "REQUESTED"
  ) {
    return normalized as CheckStatus["status"];
  }

  return null;
}

function mapCheckConclusion(
  conclusion: string | null
): CheckStatus["conclusion"] {
  const normalized = conclusion?.toUpperCase();

  if (
    normalized === "SUCCESS" ||
    normalized === "FAILURE" ||
    normalized === "NEUTRAL" ||
    normalized === "SKIPPED" ||
    normalized === "STALE" ||
    normalized === "STARTUP_FAILURE" ||
    normalized === "CANCELLED" ||
    normalized === "TIMED_OUT" ||
    normalized === "ACTION_REQUIRED"
  ) {
    return normalized as CheckStatus["conclusion"];
  }

  return null;
}

function mapCommitStatus(status: {
  context: string;
  state: string;
}): CheckStatus {
  const normalized = status.state.toUpperCase();

  if (normalized === "SUCCESS") {
    return { name: status.context, status: "COMPLETED", conclusion: "SUCCESS" };
  }

  if (normalized === "PENDING") {
    return { name: status.context, status: "PENDING", conclusion: null };
  }

  return { name: status.context, status: "COMPLETED", conclusion: "FAILURE" };
}

function filterChecks(checks: CheckStatus[], requiredChecks: string[]) {
  return requiredChecks.length > 0
    ? checks.filter((check) => requiredChecks.includes(check.name))
    : checks;
}

function hasRequiredChecks(checks: CheckStatus[], requiredChecks: string[]) {
  return requiredChecks.length === 0
    ? checks.length > 0
    : requiredChecks.every((name) =>
        checks.some((check) => check.name === name)
      );
}

function secondsRemaining(deadline: number, observedAt: number) {
  return Math.max(0, Math.ceil((deadline - observedAt) / 1000));
}

function evaluateChecks(checks: CheckStatus[]) {
  const failed = checks.filter(
    (check) =>
      check.status === "COMPLETED" &&
      check.conclusion !== null &&
      !isSuccessfulConclusion(check.conclusion)
  );

  return {
    complete: checks.every((check) => check.status === "COMPLETED"),
    failed,
  };
}

function isSuccessfulConclusion(
  conclusion: NonNullable<CheckStatus["conclusion"]>
) {
  return (
    conclusion === "SUCCESS" ||
    conclusion === "NEUTRAL" ||
    conclusion === "SKIPPED"
  );
}

function formatChecks(checks: CheckStatus[]) {
  return checks
    .map((check) => `${check.name}=${check.conclusion ?? check.status}`)
    .join(", ");
}
