import path from "node:path";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import type {
  ExecutionProvider,
  ExecutionProviderOptions,
  ExecutionResult,
} from "../../execution/execution-provider";
import type {
  BranchStatus,
  CheckStatus,
  EnableAutoMergeOptions,
  MergePrOptions,
  PRProvider,
  PullRequest,
  WaitForPrChecksOptions,
} from "../../providers/pr-provider";
import {
  execCapture,
  parseWorktreeListPorcelain,
  type PourkitLogger,
} from "../../shared/common";
import type { GitHubClient } from "../../providers/github-client";

export interface E2EResources {
  targetBranch?: string;
  issueNumber?: number;
  issueUrl?: string;
  agentBranch?: string;
  prNumber?: number;
  prUrl?: string;
}

type ReviewVerdict = "PASS" | "PASS_WITH_NOTES" | "NEEDS_REFACTOR" | "FAIL";

export interface LabelAssertionOptions {
  present?: string[];
  absent?: string[];
}

export interface ExecutionFailureInjection {
  error?: string;
  throwMessage?: string;
}

export interface ReviewerInjection extends ExecutionFailureInjection {
  verdicts?: ReviewVerdict[];
  invalidProtocol?: boolean;
}

export interface RefactorInjection extends ExecutionFailureInjection {
  failIterations?: number[];
  commits?: string[];
}

export interface FinalizerInjection extends ExecutionFailureInjection {
  invalidProtocol?: boolean;
  title?: string;
  body?: string;
}

export interface ScenarioExecutionInjections {
  builder?: ExecutionFailureInjection;
  reviewer?: ReviewerInjection;
  refactor?: RefactorInjection;
  finalizer?: FinalizerInjection;
}

export interface ScenarioPrInjections {
  branchStatuses?: BranchStatus[];
  waitForChecksDelayMs?: number;
  waitForChecksError?: string;
  waitForChecksResult?: CheckStatus[];
  requireWaitForChecksBeforeMerge?: boolean;
  expectLabelBeforeMerge?: {
    issueNumber: number;
    label: string;
  };
}

function makeSyntheticExecutionResult(
  options: ExecutionProviderOptions,
  success: boolean,
  commits: string[] = [],
  error?: string
): ExecutionResult {
  return {
    success,
    branch: options.branchName,
    worktreePath: options.worktreePath ?? "",
    commits,
    logPath: null,
    ...(error ? { error } : {}),
  };
}

async function maybeThrowInjectedFailure(
  injection: ExecutionFailureInjection | undefined
): Promise<void> {
  if (injection?.throwMessage) {
    throw new Error(injection.throwMessage);
  }
}

async function writeScenarioArtifact(
  worktreePath: string,
  artifactPath: string,
  content: string
): Promise<void> {
  const filePath = path.join(worktreePath, artifactPath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf-8");
}

export class ScenarioExecutionProvider implements ExecutionProvider {
  readonly stageCalls: string[] = [];
  readonly reviewIterations: number[] = [];
  readonly refactorIterations: number[] = [];

  constructor(
    private readonly baseProvider: ExecutionProvider,
    readonly injections: ScenarioExecutionInjections = {}
  ) {}

  resetRunTracking(): void {
    this.stageCalls.length = 0;
    this.reviewIterations.length = 0;
    this.refactorIterations.length = 0;
  }

  async execute(options: ExecutionProviderOptions): Promise<ExecutionResult> {
    this.stageCalls.push(options.stage);

    if (options.stage === "builder") {
      await maybeThrowInjectedFailure(this.injections.builder);
      if (this.injections.builder?.error) {
        return makeSyntheticExecutionResult(
          options,
          false,
          [],
          this.injections.builder.error
        );
      }
      return this.baseProvider.execute(options);
    }

    if (options.stage === "reviewer") {
      await maybeThrowInjectedFailure(this.injections.reviewer);
      if (this.injections.reviewer?.error) {
        return makeSyntheticExecutionResult(
          options,
          false,
          [],
          this.injections.reviewer.error
        );
      }

      this.reviewIterations.push(options.iteration ?? 1);
      const verdicts = this.injections.reviewer?.verdicts ?? ["PASS"];
      const verdict =
        verdicts[
          Math.min(this.reviewIterations.length - 1, verdicts.length - 1)
        ];
      const artifactPath =
        options.artifactPath ?? ".pourkit/.tmp/reviewers/iteration-1.md";
      const content = this.injections.reviewer?.invalidProtocol
        ? "invalid reviewer artifact"
        : [
            "## Findings",
            "",
            "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
            "|----|------------|----------|-----------|-------|----------------|",
            "| none | n/a | n/a | n/a | No findings. | n/a |",
            "",
            `<verdict>${verdict}</verdict>`,
          ].join("\n");

      await writeScenarioArtifact(
        options.worktreePath ?? "",
        artifactPath,
        content
      );
      return makeSyntheticExecutionResult(options, true);
    }

    if (options.stage === "refactor") {
      await maybeThrowInjectedFailure(this.injections.refactor);
      this.refactorIterations.push(options.iteration ?? 1);
      if (
        this.injections.refactor?.error &&
        this.injections.refactor.failIterations?.includes(
          options.iteration ?? 1
        )
      ) {
        return makeSyntheticExecutionResult(
          options,
          false,
          [],
          this.injections.refactor.error
        );
      }

      return makeSyntheticExecutionResult(
        options,
        true,
        this.injections.refactor?.commits ?? [
          `synthetic-refactor-${options.iteration ?? 1}`,
        ]
      );
    }

    await maybeThrowInjectedFailure(this.injections.finalizer);
    if (this.injections.finalizer?.error) {
      return makeSyntheticExecutionResult(
        options,
        false,
        [],
        this.injections.finalizer.error
      );
    }

    const artifactPath =
      options.artifactPath ?? ".pourkit/.tmp/finalizer/agent-output.md";
    const title = this.injections.finalizer?.title ?? "Generated PR Title";
    const body = this.injections.finalizer?.body ?? "Generated PR body content";
    const content = this.injections.finalizer?.invalidProtocol
      ? "invalid finalizer artifact"
      : `## PR Title\n\n${title}\n\n## PR Body\n\n${body}`;

    await writeScenarioArtifact(
      options.worktreePath ?? "",
      artifactPath,
      content
    );
    return makeSyntheticExecutionResult(options, true);
  }
}

export class ScenarioPrProvider implements PRProvider {
  waitForPrChecksCalls = 0;
  mergeCalls = 0;
  branchStatusCalls = 0;

  constructor(
    private readonly baseProvider: PRProvider,
    private readonly client: GitHubClient,
    private readonly injections: ScenarioPrInjections = {}
  ) {}

  setExpectedLabelBeforeMerge(issueNumber: number, label: string): void {
    this.injections.expectLabelBeforeMerge = { issueNumber, label };
  }

  createPr(options: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<PullRequest> {
    return this.baseProvider.createPr(options);
  }

  getPr(branchName: string): Promise<PullRequest | null> {
    return this.baseProvider.getPr(branchName);
  }

  getCheckStatus(prNumber: number): Promise<CheckStatus[]> {
    return this.baseProvider.getCheckStatus(prNumber);
  }

  async enableAutoMerge(
    _pr: PullRequest,
    _options?: EnableAutoMergeOptions
  ): Promise<void> {
    return this.baseProvider.enableAutoMerge(_pr, _options);
  }

  async mergePr(prNumber: number, options?: MergePrOptions): Promise<void> {
    this.mergeCalls++;
    if (
      this.injections.requireWaitForChecksBeforeMerge &&
      this.waitForPrChecksCalls === 0
    ) {
      throw new Error("mergePr called before waitForPrChecks");
    }

    if (this.injections.expectLabelBeforeMerge) {
      await assertIssueLabels(
        this.injections.expectLabelBeforeMerge.issueNumber,
        {
          present: [this.injections.expectLabelBeforeMerge.label],
        },
        this.client
      );
    }

    await this.baseProvider.mergePr(prNumber, options);
  }

  async waitForPrChecks(
    prNumber: number,
    options?: WaitForPrChecksOptions
  ): Promise<CheckStatus[]> {
    this.waitForPrChecksCalls++;

    if (this.injections.waitForChecksDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.injections.waitForChecksDelayMs)
      );
    }

    if (this.injections.waitForChecksError) {
      throw new Error(this.injections.waitForChecksError);
    }

    if (this.injections.waitForChecksResult) {
      return this.injections.waitForChecksResult;
    }

    return this.baseProvider.waitForPrChecks(prNumber, options);
  }

  async getBranchStatus(branchName: string): Promise<BranchStatus> {
    this.branchStatusCalls++;
    const statuses = this.injections.branchStatuses;
    if (statuses && statuses.length > 0) {
      return statuses[
        Math.min(this.branchStatusCalls - 1, statuses.length - 1)
      ];
    }
    return this.baseProvider.getBranchStatus(branchName);
  }
}

interface E2EStateFile extends E2EResources {
  runId: string;
}

export const E2E_STATE_DIR = path.join(".pourkit", ".tmp", "e2e-runs");

export function stateFilePath(root: string, runId: string): string {
  return path.join(root, E2E_STATE_DIR, `${runId}.json`);
}

export async function persistResources(
  root: string,
  runId: string,
  resources: E2EResources
): Promise<void> {
  const filePath = stateFilePath(root, runId);
  await mkdir(path.dirname(filePath), { recursive: true });
  const state: E2EStateFile = { runId, ...resources };
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

export async function localBranchExists(branchName: string): Promise<boolean> {
  try {
    await execCapture("git", [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branchName}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function removeWorktreeForBranch(
  branchName: string,
  logger: PourkitLogger
): Promise<boolean> {
  try {
    const result = await execCapture("git", [
      "worktree",
      "list",
      "--porcelain",
    ]);
    const worktreePath = parseWorktreeListPorcelain(result.stdout, branchName);

    if (!worktreePath) {
      return true;
    }

    logger.step("cleanup", `Removing worktree for branch: ${branchName}...`);
    await execCapture("git", ["worktree", "remove", "--force", worktreePath]);
    return true;
  } catch (error) {
    logger.step(
      "warn",
      `Failed to remove worktree for branch: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

export async function worktreeExistsForBranch(
  branchName: string
): Promise<boolean> {
  try {
    const result = await execCapture("git", [
      "worktree",
      "list",
      "--porcelain",
    ]);
    const worktreePath = parseWorktreeListPorcelain(result.stdout, branchName);
    return worktreePath !== null;
  } catch {
    return false;
  }
}

export async function worktreePathForBranch(
  branchName: string
): Promise<string | null> {
  try {
    const result = await execCapture("git", [
      "worktree",
      "list",
      "--porcelain",
    ]);
    return parseWorktreeListPorcelain(result.stdout, branchName);
  } catch {
    return null;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function deleteLocalBranch(
  branchName: string,
  logger: PourkitLogger
): Promise<boolean> {
  if (!(await localBranchExists(branchName))) {
    return true;
  }

  if (!(await removeWorktreeForBranch(branchName, logger))) {
    return false;
  }

  try {
    logger.step("cleanup", `Deleting local branch: ${branchName}...`);
    await execCapture("git", ["branch", "-D", branchName]);
    return true;
  } catch (error) {
    logger.step(
      "warn",
      `Failed to delete local branch: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

async function deleteRemoteBranch(
  branchName: string,
  logger: PourkitLogger
): Promise<boolean> {
  if (!(await remoteBranchExists(branchName))) {
    return true;
  }

  try {
    logger.step("cleanup", `Deleting remote branch: ${branchName}...`);
    await execCapture("git", ["push", "origin", "--delete", branchName]);
    return true;
  } catch (error) {
    logger.step(
      "warn",
      `Failed to delete remote branch: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

export async function createE2EIssue(
  runId: string,
  targetBranch: string,
  logger: PourkitLogger,
  client: GitHubClient,
  title = `E2E Test Issue ${runId}`
): Promise<{ number: number; url: string }> {
  const body = [
    `This is an automatically created E2E test issue for run ${runId}.`,
    "",
    `Target branch: ${targetBranch}`,
    "",
    "This issue should be processed by the deterministic agent and cleaned up after the test completes.",
  ].join("\n");

  logger.step("issue", `Creating GitHub issue: "${title}"`);

  const { data } = await client.octokit.rest.issues.create({
    owner: client.owner,
    repo: client.repo,
    title,
    body,
    labels: ["ready-for-agent", "type:infra", "pourkit-e2e"],
  });

  logger.line(`Created issue #${data.number}`);
  return { number: data.number, url: data.html_url };
}

export async function createLiveTargetBranch(
  runId: string,
  logger: PourkitLogger
): Promise<string> {
  const targetBranch = `pourkit-e2e-target/${runId}`;
  logger.step("git", `Creating target branch: ${targetBranch}`);
  await execCapture("git", ["branch", "--force", targetBranch, "origin/e2e"]);
  await execCapture("git", [
    "push",
    "--no-verify",
    "-u",
    "origin",
    targetBranch,
  ]);
  return targetBranch;
}

export async function fetchIssueLabels(
  issueNumber: number,
  client: GitHubClient
): Promise<string[]> {
  const { data } = await client.octokit.rest.issues.get({
    owner: client.owner,
    repo: client.repo,
    issue_number: issueNumber,
  });

  return data.labels.map((l) => (typeof l === "string" ? l : (l.name ?? "")));
}

export async function assertIssueLabels(
  issueNumber: number,
  options: LabelAssertionOptions,
  client: GitHubClient
): Promise<void> {
  const labels = await fetchIssueLabels(issueNumber, client);
  const missing = (options.present ?? []).filter(
    (label) => !labels.includes(label)
  );
  const unexpected = (options.absent ?? []).filter((label) =>
    labels.includes(label)
  );

  if (missing.length === 0 && unexpected.length === 0) {
    return;
  }

  const messages: string[] = [];
  if (missing.length > 0) {
    messages.push(`missing labels: ${missing.join(", ")}`);
  }
  if (unexpected.length > 0) {
    messages.push(`unexpected labels: ${unexpected.join(", ")}`);
  }

  throw new Error(
    `Issue #${issueNumber} label assertion failed (${messages.join("; ")}). Current labels: ${labels.join(", ")}`
  );
}

export async function lookupPrByBranch(
  branchName: string,
  client: GitHubClient
): Promise<PullRequest | null> {
  const { data } = await client.octokit.rest.pulls.list({
    owner: client.owner,
    repo: client.repo,
    head: `${client.owner}:${branchName}`,
    state: "all",
    per_page: 1,
  });

  if (data.length === 0) return null;

  const pr = data[0];
  return {
    number: pr.number,
    nodeId: pr.node_id,
    url: pr.html_url,
    title: pr.title,
    body: pr.body ?? "",
    headRefName: pr.head.ref,
    baseRefName: pr.base.ref,
    state:
      pr.state === "closed" ? (pr.merged_at ? "MERGED" : "CLOSED") : "OPEN",
    headRefOid: pr.head.sha,
  };
}

export async function remoteBranchExists(branchName: string): Promise<boolean> {
  const result = await execCapture("git", [
    "ls-remote",
    "--heads",
    "origin",
    branchName,
  ]);
  return result.stdout.trim().length > 0;
}

export async function countRemoteBranchCommits(
  branchName: string
): Promise<number> {
  await execCapture("git", ["fetch", "origin", branchName]);
  const result = await execCapture("git", [
    "rev-list",
    "--count",
    `origin/${branchName}`,
  ]);
  return Number(result.stdout.trim());
}

export async function getTargetBranchStatus(
  prProvider: PRProvider,
  targetBranch: string
): Promise<BranchStatus> {
  return prProvider.getBranchStatus(targetBranch);
}

async function recoverStateFile(
  filePath: string,
  logger: PourkitLogger
): Promise<boolean> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const state = JSON.parse(raw) as E2EStateFile;
    let cleanupSucceeded = true;

    if (state.agentBranch) {
      cleanupSucceeded =
        (await deleteLocalBranch(state.agentBranch, logger)) &&
        cleanupSucceeded;
      cleanupSucceeded =
        (await deleteRemoteBranch(state.agentBranch, logger)) &&
        cleanupSucceeded;
    }

    if (state.targetBranch) {
      cleanupSucceeded =
        (await deleteLocalBranch(state.targetBranch, logger)) &&
        cleanupSucceeded;
      cleanupSucceeded =
        (await deleteRemoteBranch(state.targetBranch, logger)) &&
        cleanupSucceeded;
    }

    if (cleanupSucceeded) {
      await rm(filePath, { force: true });
      return true;
    }

    logger.step(
      "warn",
      `Preserving stale E2E state ${path.basename(filePath)} for cleanup retry`
    );
    return false;
  } catch (error) {
    logger.step(
      "warn",
      `Failed to recover stale E2E state ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

export async function recoverStaleRuns(
  root: string,
  logger: PourkitLogger
): Promise<void> {
  const dir = path.join(root, E2E_STATE_DIR);

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      await recoverStateFile(path.join(dir, entry.name), logger);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.step(
        "warn",
        `Failed to scan stale E2E state: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

export async function cleanupResources(
  resources: E2EResources,
  root: string,
  runId: string,
  keep: boolean,
  logger: PourkitLogger,
  client: GitHubClient
): Promise<void> {
  if (keep) {
    logger.line("--keep flag set, preserving E2E resources:");
    if (resources.issueNumber)
      logger.line(`  Issue: #${resources.issueNumber}`);
    if (resources.issueUrl) logger.line(`  Issue URL: ${resources.issueUrl}`);
    if (resources.targetBranch)
      logger.line(`  Target branch: ${resources.targetBranch}`);
    if (resources.agentBranch)
      logger.line(`  Agent branch: ${resources.agentBranch}`);
    if (resources.prNumber)
      logger.line(`  PR: #${resources.prNumber} (${resources.prUrl})`);
    return;
  }

  logger.line("Cleaning up E2E resources...");
  let cleanupSucceeded = true;

  if (resources.prNumber) {
    try {
      const { data } = await client.octokit.rest.pulls.get({
        owner: client.owner,
        repo: client.repo,
        pull_number: resources.prNumber,
      });
      if (data.merged) {
        logger.step(
          "cleanup",
          `PR #${resources.prNumber} is merged, skipping close`
        );
      } else {
        logger.step("cleanup", `Closing PR #${resources.prNumber}...`);
        await client.octokit.rest.pulls.update({
          owner: client.owner,
          repo: client.repo,
          pull_number: resources.prNumber,
          state: "closed",
        });
      }
    } catch (error) {
      logger.step(
        "warn",
        `Failed to close PR: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (resources.issueNumber) {
    try {
      logger.step("cleanup", `Closing issue #${resources.issueNumber}...`);
      await client.octokit.rest.issues.update({
        owner: client.owner,
        repo: client.repo,
        issue_number: resources.issueNumber,
        state: "closed",
        state_reason: "completed",
      });
    } catch (error) {
      logger.step(
        "warn",
        `Failed to close issue: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (resources.agentBranch) {
    cleanupSucceeded =
      (await deleteLocalBranch(resources.agentBranch, logger)) &&
      cleanupSucceeded;
    cleanupSucceeded =
      (await deleteRemoteBranch(resources.agentBranch, logger)) &&
      cleanupSucceeded;
  }

  if (resources.targetBranch) {
    cleanupSucceeded =
      (await deleteLocalBranch(resources.targetBranch, logger)) &&
      cleanupSucceeded;
    cleanupSucceeded =
      (await deleteRemoteBranch(resources.targetBranch, logger)) &&
      cleanupSucceeded;
  }

  if (cleanupSucceeded) {
    await rm(stateFilePath(root, runId), { force: true });
  } else {
    logger.step("warn", "Preserving E2E state for retry after cleanup failure");
  }

  logger.line("Cleanup complete.");
}

export interface QueueLoopCleanupIssue {
  issueNumber: number;
  agentBranch?: string;
  prNumber?: number;
}

export interface QueueLoopCleanupResources {
  targetBranch: string;
  issues: QueueLoopCleanupIssue[];
}

export async function cleanupQueueLoopResources(
  resources: QueueLoopCleanupResources,
  root: string,
  runId: string,
  logger: PourkitLogger,
  client: GitHubClient
): Promise<string[]> {
  const errors: string[] = [];

  logger.line("Cleaning up Queue Loop E2E resources...");

  for (const issue of resources.issues) {
    let prNumber = issue.prNumber;

    if (!prNumber && issue.agentBranch) {
      try {
        const pr = await lookupPrByBranch(issue.agentBranch, client);
        if (pr) {
          prNumber = pr.number;
        }
      } catch {}
    }

    if (prNumber) {
      try {
        const { data } = await client.octokit.rest.pulls.get({
          owner: client.owner,
          repo: client.repo,
          pull_number: prNumber,
        });
        if (!data.merged) {
          logger.step("cleanup", `Closing PR #${prNumber}...`);
          await client.octokit.rest.pulls.update({
            owner: client.owner,
            repo: client.repo,
            pull_number: prNumber,
            state: "closed",
          });
        }
      } catch (error) {
        errors.push(`Failed to close PR #${prNumber}`);
        logger.step(
          "warn",
          `Failed to close PR #${prNumber}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  for (const issue of resources.issues) {
    try {
      logger.step("cleanup", `Closing issue #${issue.issueNumber}...`);
      await client.octokit.rest.issues.update({
        owner: client.owner,
        repo: client.repo,
        issue_number: issue.issueNumber,
        state: "closed",
        state_reason: "completed",
      });
    } catch (error) {
      errors.push(`Failed to close issue #${issue.issueNumber}`);
      logger.step(
        "warn",
        `Failed to close issue #${issue.issueNumber}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  for (const issue of resources.issues) {
    if (issue.agentBranch) {
      if (!(await deleteLocalBranch(issue.agentBranch, logger))) {
        errors.push(`Failed to delete local branch ${issue.agentBranch}`);
      }
      if (!(await deleteRemoteBranch(issue.agentBranch, logger))) {
        errors.push(`Failed to delete remote branch ${issue.agentBranch}`);
      }
    }
  }

  if (!(await deleteLocalBranch(resources.targetBranch, logger))) {
    errors.push(
      `Failed to delete local target branch ${resources.targetBranch}`
    );
  }
  if (!(await deleteRemoteBranch(resources.targetBranch, logger))) {
    errors.push(
      `Failed to delete remote target branch ${resources.targetBranch}`
    );
  }

  try {
    await rm(stateFilePath(root, runId), { force: true });
  } catch (error) {
    errors.push("Failed to remove state file");
  }

  logger.line("Queue Loop cleanup complete.");
  return errors;
}

export async function runCleanupOnly(
  root: string,
  logger: PourkitLogger,
  client: GitHubClient
): Promise<void> {
  logger.line("Running cleanup-only mode: deleting stale e2e branches...");

  const result = await execCapture("git", ["ls-remote", "--heads", "origin"]);
  const lines = result.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0);

  const e2eBranchPattern =
    /refs\/heads\/(pourkit-e2e-target\/|pourkit\/\d+\/(e2e-test-issue-|test-live-e2e-))/;
  const branchesToDelete = lines
    .map((line) => {
      const parts = line.split(/\s+/);
      return parts[1];
    })
    .filter((ref) => e2eBranchPattern.test(ref))
    .map((ref) => ref.replace("refs/heads/", ""));

  let deletedCount = 0;
  let failedCount = 0;

  for (const branch of branchesToDelete) {
    const localOk = await deleteLocalBranch(branch, logger);
    const remoteOk = await deleteRemoteBranch(branch, logger);
    if (localOk && remoteOk) {
      deletedCount++;
    } else {
      failedCount++;
    }
  }

  const issueLabel = "pourkit-e2e";
  let closedIssueCount = 0;
  let failedIssueCount = 0;

  const openIssues = await client.octokit.paginate(
    client.octokit.rest.issues.listForRepo,
    {
      owner: client.owner,
      repo: client.repo,
      state: "open",
      labels: issueLabel,
      per_page: 100,
    }
  );

  const issues = openIssues.filter((issue) => !issue.pull_request);

  for (const issue of issues) {
    try {
      logger.step("cleanup", `Closing e2e issue #${issue.number}...`);
      await client.octokit.rest.issues.update({
        owner: client.owner,
        repo: client.repo,
        issue_number: issue.number,
        state: "closed",
        state_reason: "completed",
      });
      closedIssueCount++;
    } catch (error) {
      failedIssueCount++;
      logger.step(
        "warn",
        `Failed to close e2e issue #${issue.number}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const stateDir = path.join(root, E2E_STATE_DIR);
  try {
    const entries = await readdir(stateDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(stateDir, entry.name);
      await rm(filePath, { force: true });
      logger.step("cleanup", `Removed state file: ${entry.name}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.step(
        "warn",
        `Failed to scan state directory: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  logger.line(
    `Cleanup-only complete: ${deletedCount} branch(es) deleted, ${closedIssueCount} issue(s) closed, ${failedCount + failedIssueCount} failure(s)`
  );
}
