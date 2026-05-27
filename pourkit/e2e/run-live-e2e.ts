import path from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { runIssueCommand } from "../commands/issue";
import {
  createLogger,
  execCapture,
  execJson,
  parseWorktreeListPorcelain,
  repoRoot,
  type PourkitLogger,
} from "../shared/common";
import {
  getVerificationCommands as getTargetVerificationCommands,
  loadRepoConfig,
  resolveTarget,
  type PourkitConfig,
} from "../shared/config";
import { renderBranchName } from "../pr/templates";
import { GitHubIssueProvider } from "../providers/github-provider";
import { GitHubPRProvider } from "../providers/github-pr-provider";
import {
  requireGitHubClient,
  type GitHubClient,
} from "../providers/github-client";
import type { PullRequest } from "../providers/pr-provider";
import { DeterministicExecutionProvider } from "../execution/deterministic-agent";
import {
  getVerificationCommands,
  composeFailureWithProfile,
  type E2EVerificationProfile,
} from "./profile";
import { waitForBranchChecks } from "../issues/target-green";
import {
  cleanupResources as harnessCleanupResources,
  createE2EIssue as harnessCreateE2EIssue,
  createLiveTargetBranch as harnessCreateLiveTargetBranch,
  fetchIssueLabels,
  persistResources as harnessPersistResources,
  recoverStaleRuns as harnessRecoverStaleRuns,
  runCleanupOnly as harnessRunCleanupOnly,
} from "./live/harness";

export interface E2EOptions {
  keep: boolean;
  fail: boolean;
  fullCheck: boolean;
  cleanupOnly: boolean;
  targetName?: string;
}

interface E2EResources {
  targetBranch?: string;
  issueNumber?: number;
  issueUrl?: string;
  agentBranch?: string;
  prNumber?: number;
  prUrl?: string;
}

interface E2EStateFile extends E2EResources {
  runId: string;
}

const E2E_STATE_DIR = path.join(".pourkit", ".tmp", "e2e-runs");

export function parseArgs(): E2EOptions {
  const args = process.argv.slice(2);
  let keep = false;
  let fail = false;
  let fullCheck = false;
  let cleanupOnly = false;
  let targetName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--keep") {
      keep = true;
    } else if (arg === "--fail") {
      fail = true;
    } else if (arg === "--full-check") {
      fullCheck = true;
    } else if (arg === "--cleanup-only") {
      cleanupOnly = true;
    } else if (arg === "--target" && args[i + 1]) {
      targetName = args[i + 1];
      i++;
    }
  }

  return { keep, fail, fullCheck, cleanupOnly, targetName };
}

export function resolveProfile(fullCheck: boolean): E2EVerificationProfile {
  return fullCheck ? "full-check" : "fast";
}

export function isExecutedAsScript(
  currentUrl = import.meta.url,
  entryPoint = process.argv[1]
): boolean {
  if (!entryPoint) {
    return false;
  }

  return currentUrl === pathToFileURL(path.resolve(entryPoint)).href;
}

export function resolveE2EConfigFile(root: string): string {
  const explicitConfig = process.env.POURKIT_CONFIG_FILE?.trim();
  if (explicitConfig) {
    return explicitConfig;
  }

  if (existsSync(path.join(root, "pourkit.config.ts"))) {
    return "pourkit.config.ts";
  }

  return "pourkit.config.example.ts";
}

function generateRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function stateFilePath(root: string, runId: string): string {
  return path.join(root, E2E_STATE_DIR, `${runId}.json`);
}

async function persistResources(
  root: string,
  runId: string,
  resources: E2EResources
): Promise<void> {
  const filePath = stateFilePath(root, runId);
  await mkdir(path.dirname(filePath), { recursive: true });
  const state: E2EStateFile = { runId, ...resources };
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

async function localBranchExists(branchName: string): Promise<boolean> {
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

async function remoteBranchExists(branchName: string): Promise<boolean> {
  const result = await execCapture("git", [
    "ls-remote",
    "--heads",
    "origin",
    branchName,
  ]);
  return result.stdout.trim().length > 0;
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

async function recoverStaleRuns(
  root: string,
  logger: PourkitLogger
): Promise<void> {
  const dir = path.join(root, E2E_STATE_DIR);

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

      const filePath = path.join(dir, entry.name);
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
        } else {
          logger.step(
            "warn",
            `Preserving stale E2E state ${entry.name} for cleanup retry`
          );
        }
      } catch (error) {
        logger.step(
          "warn",
          `Failed to recover stale E2E state ${entry.name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
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

export function makeE2EConfig(
  baseConfig: PourkitConfig,
  targetName: string | undefined,
  targetBranch: string,
  profile: E2EVerificationProfile
): PourkitConfig {
  const resolvedTargetName = targetName ?? "e2e";
  const target = resolveTarget(baseConfig, resolvedTargetName);
  const strategy = target.strategy;
  const verificationCommands = getVerificationCommands(
    getTargetVerificationCommands(target),
    profile
  );

  return {
    ...baseConfig,
    targets: [
      {
        ...target,
        baseBranch: targetBranch,
        strategy: {
          ...strategy,
          verify: { commands: verificationCommands },
        },
      },
    ],
  };
}

async function cleanup(
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

async function verifyAssertions(
  pr: PullRequest,
  issueNumber: number,
  targetBranch: string,
  expectedHead: string,
  expectedTitle: string,
  logger: PourkitLogger,
  client: GitHubClient
): Promise<void> {
  logger.raw("\n=== Running Assertions ===\n");

  const errors: string[] = [];

  if (pr.baseRefName !== targetBranch) {
    errors.push(`PR base is "${pr.baseRefName}", expected "${targetBranch}"`);
  } else {
    logger.raw(`[✓] PR base is target branch: ${targetBranch}`);
  }

  if (pr.headRefName !== expectedHead) {
    errors.push(`PR head is "${pr.headRefName}", expected "${expectedHead}"`);
  } else {
    logger.raw(`[✓] PR head is agent branch: ${expectedHead}`);
  }

  if (pr.title !== expectedTitle) {
    errors.push(`PR title is "${pr.title}", expected "${expectedTitle}"`);
  } else {
    logger.raw(`[✓] PR title matches template`);
  }

  if (
    pr.body !== undefined &&
    !new RegExp(`[Cc]loses\\s*#${issueNumber}`).test(pr.body)
  ) {
    errors.push(`PR body does not contain "Closes #${issueNumber}"`);
  } else {
    logger.raw(`[✓] PR body contains "Closes #${issueNumber}"`);
  }

  try {
    await execCapture("git", ["fetch", "origin", pr.headRefName]);
    const countResult = await execCapture("git", [
      "rev-list",
      "--count",
      `origin/${pr.headRefName}`,
    ]);
    const commitCount = Number(countResult.stdout.trim());
    if (!Number.isFinite(commitCount) || commitCount <= 0) {
      errors.push(`No commits found on the agent branch ${pr.headRefName}`);
    } else {
      logger.raw(`[✓] Commits exist on agent branch: ${commitCount} commit(s)`);
    }
  } catch (error) {
    errors.push(
      `Failed to verify commits: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    const labelNames = await fetchIssueLabels(issueNumber, client);

    if (labelNames.includes("pr-open-awaiting-merge")) {
      errors.push(
        `Issue #${issueNumber} still has "pr-open-awaiting-merge" label after merge. Labels: ${labelNames.join(", ")}`
      );
    } else {
      logger.raw(`[✓] Issue no longer has "pr-open-awaiting-merge"`);
    }

    if (labelNames.includes("ready-for-agent")) {
      errors.push(
        `Issue #${issueNumber} still has "ready-for-agent" label. Labels: ${labelNames.join(", ")}`
      );
    } else {
      logger.raw(`[✓] Issue no longer has "ready-for-agent"`);
    }

    if (labelNames.includes("agent-in-progress")) {
      errors.push(
        `Issue #${issueNumber} still has "agent-in-progress" label. Labels: ${labelNames.join(", ")}`
      );
    } else {
      logger.raw(`[✓] Issue no longer has "agent-in-progress"`);
    }

    if (pr.state !== "MERGED") {
      errors.push(`PR state is "${pr.state}", expected "MERGED"`);
    } else {
      logger.raw(`[✓] PR is merged`);
    }
  } catch (error) {
    errors.push(
      `Failed to verify issue labels: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (errors.length > 0) {
    logger.raw("\n=== Assertion Failures ===\n");
    for (const error of errors) {
      logger.raw(`[✗] ${error}`);
    }
    throw new Error(`${errors.length} assertion(s) failed`);
  }

  logger.raw("\n=== All Assertions Passed ===\n");
}

async function verifyFailureAssertions(
  issueNumber: number,
  logger: PourkitLogger,
  client: GitHubClient
): Promise<void> {
  logger.raw("\n=== Running Failure Assertions ===\n");

  const errors: string[] = [];

  try {
    const labelNames = await fetchIssueLabels(issueNumber, client);

    if (!labelNames.includes("ready-for-human")) {
      errors.push(
        `Issue #${issueNumber} does not have "ready-for-human" label. Labels: ${labelNames.join(", ")}`
      );
    } else {
      logger.raw(`[✓] Issue has "ready-for-human" label`);
    }

    if (labelNames.includes("agent-in-progress")) {
      errors.push(
        `Issue #${issueNumber} still has "agent-in-progress" label. Labels: ${labelNames.join(", ")}`
      );
    } else {
      logger.raw(`[✓] Issue no longer has "agent-in-progress"`);
    }
  } catch (error) {
    errors.push(
      `Failed to verify issue labels: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (errors.length > 0) {
    logger.raw("\n=== Assertion Failures ===\n");
    for (const error of errors) {
      logger.raw(`[✗] ${error}`);
    }
    throw new Error(`${errors.length} assertion(s) failed`);
  }

  logger.raw("\n=== All Failure Assertions Passed ===\n");
}

export function makeFailureE2EConfig(
  baseConfig: PourkitConfig,
  targetName: string | undefined,
  targetBranch: string,
  profile: E2EVerificationProfile
): PourkitConfig {
  const resolvedTargetName = targetName ?? "e2e";
  const target = resolveTarget(baseConfig, resolvedTargetName);
  const strategy = target.strategy;
  const verificationCommands = composeFailureWithProfile(
    getTargetVerificationCommands(target),
    profile
  );

  return {
    ...baseConfig,
    targets: [
      {
        ...target,
        baseBranch: targetBranch,
        strategy: {
          ...strategy,
          verify: { commands: verificationCommands },
        },
      },
    ],
  };
}

async function runCleanupOnly(
  root: string,
  logger: PourkitLogger
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
    `Cleanup-only complete: ${deletedCount} branch(es) deleted, ${failedCount} failure(s)`
  );
}

async function runE2E(): Promise<void> {
  const options = parseArgs();
  const runId = generateRunId();
  const root = repoRoot();
  const logPath = path.join(root, "pourkit", "logs", `e2e-${runId}.log`);
  const logger = createLogger("e2e", logPath);
  const client = await requireGitHubClient({ cwd: root });

  logger.line(`Starting E2E test run: ${runId}`);
  logger.line(`Keep resources: ${options.keep}`);
  logger.line(`Failure mode: ${options.fail}`);
  logger.line(`Verification profile: ${resolveProfile(options.fullCheck)}`);

  if (options.cleanupOnly) {
    await harnessRunCleanupOnly(root, logger, client);
    await logger.close();
    return;
  }

  await harnessRecoverStaleRuns(root, logger);

  if (options.fail) {
    await runFailureE2E(options, runId, root, logger);
  } else {
    await runSuccessE2E(options, runId, root, logger, client);
  }
}

async function runSuccessE2E(
  options: E2EOptions,
  runId: string,
  root: string,
  logger: PourkitLogger,
  client: GitHubClient
): Promise<void> {
  const issueProvider = new GitHubIssueProvider(client);
  const executionProvider = new DeterministicExecutionProvider();
  const prProvider = new GitHubPRProvider(client, logger);

  const resources: E2EResources = {};

  try {
    const targetBranch = await harnessCreateLiveTargetBranch(runId, logger);
    resources.targetBranch = targetBranch;
    if (!options.keep) {
      await harnessPersistResources(root, runId, resources);
    }

    const createdIssue = await harnessCreateE2EIssue(
      runId,
      targetBranch,
      logger,
      client
    );
    resources.issueNumber = createdIssue.number;
    resources.issueUrl = createdIssue.url;
    if (!options.keep) {
      await harnessPersistResources(root, runId, resources);
    }

    const baseConfig = await loadRepoConfig(root, resolveE2EConfigFile(root));
    const profile = resolveProfile(options.fullCheck);
    const config = makeE2EConfig(
      baseConfig,
      options.targetName,
      targetBranch,
      profile
    );
    const expectedIssue = await issueProvider.fetchIssue(createdIssue.number);
    const expectedTarget = resolveTarget(config, options.targetName);
    resources.agentBranch = renderBranchName(
      expectedTarget.branchTemplate,
      expectedIssue
    );
    if (!options.keep) {
      await harnessPersistResources(root, runId, resources);
    }

    logger.raw(`\nRunning issue command for #${createdIssue.number}...\n`);

    const result = await runIssueCommand({
      issueNumber: createdIssue.number,
      targetName: options.targetName,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: false,
      logger,
      repoRoot: root,
    });

    resources.agentBranch = result.branchName;
    resources.prNumber = result.prNumber;
    resources.prUrl = result.prUrl;
    if (!options.keep) {
      await harnessPersistResources(root, runId, resources);
    }

    logger.raw(`\nIssue command completed:`);
    logger.raw(`  Issue: #${createdIssue.number}`);
    logger.raw(`  Branch: ${result.branchName}`);
    logger.raw(`  PR: #${result.prNumber} (${result.prUrl})`);

    if (!result.prNumber) {
      throw new Error("Issue command did not return a PR number");
    }

    const pr = await execJson<PullRequest>("gh", [
      "pr",
      "view",
      String(result.prNumber),
      "--json",
      "number,nodeId,url,title,body,headRefName,baseRefName,state,headRefOid",
    ]);

    await verifyAssertions(
      pr,
      createdIssue.number,
      targetBranch,
      result.branchName,
      result.prTitle ?? result.issue.title,
      logger,
      client
    );

    logger.raw("\n=== Verifying Merge and Target-Green ===\n");

    if (pr.state !== "MERGED") {
      throw new Error(
        `PR #${result.prNumber} was not merged after issue command (state: ${pr.state})`
      );
    }
    logger.raw(`[✓] PR #${result.prNumber} is merged`);

    await waitForBranchChecks(prProvider, logger, {
      branchName: targetBranch,
      checksFoundTimeoutMs: config.checks.checksFoundTimeoutSeconds * 1000,
      checksCompletionTimeoutMs:
        config.checks.checksCompletionTimeoutSeconds * 1000,
      pollIntervalMs: config.checks.pollIntervalSeconds * 1000,
    });
    logger.raw(`[✓] Target branch ${targetBranch} is green after merge`);

    logger.raw("\n=== E2E Test Passed ===\n");
  } catch (error) {
    logger.step(
      "error",
      `E2E test failed: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  } finally {
    await harnessCleanupResources(
      resources,
      root,
      runId,
      options.keep,
      logger,
      client
    );
    await logger.close();
  }
}

async function runFailureE2E(
  options: E2EOptions,
  runId: string,
  root: string,
  logger: PourkitLogger
): Promise<void> {
  const client = await requireGitHubClient({ cwd: root });
  const issueProvider = new GitHubIssueProvider(client);
  const executionProvider = new DeterministicExecutionProvider();
  const prProvider = new GitHubPRProvider(client, logger);

  const resources: E2EResources = {};

  try {
    const targetBranch = await harnessCreateLiveTargetBranch(runId, logger);
    resources.targetBranch = targetBranch;
    if (!options.keep) {
      await harnessPersistResources(root, runId, resources);
    }

    const createdIssue = await harnessCreateE2EIssue(
      runId,
      targetBranch,
      logger,
      client
    );
    resources.issueNumber = createdIssue.number;
    resources.issueUrl = createdIssue.url;
    if (!options.keep) {
      await harnessPersistResources(root, runId, resources);
    }

    const baseConfig = await loadRepoConfig(root, resolveE2EConfigFile(root));
    const profile = resolveProfile(options.fullCheck);
    const config = makeFailureE2EConfig(
      baseConfig,
      options.targetName,
      targetBranch,
      profile
    );
    const expectedIssue = await issueProvider.fetchIssue(createdIssue.number);
    const expectedTarget = resolveTarget(config, options.targetName);
    resources.agentBranch = renderBranchName(
      expectedTarget.branchTemplate,
      expectedIssue
    );
    if (!options.keep) {
      await harnessPersistResources(root, runId, resources);
    }

    logger.raw(
      `\nRunning issue command for #${createdIssue.number} (failure mode)...\n`
    );

    await runIssueCommand({
      issueNumber: createdIssue.number,
      targetName: options.targetName,
      config,
      issueProvider,
      prProvider,
      executionProvider,
      force: false,
      logger,
      repoRoot: root,
    });

    if (!options.keep) {
      await harnessPersistResources(root, runId, resources);
    }

    throw new Error("Expected runIssueCommand to throw in failure mode");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Expected runIssueCommand to throw in failure mode") {
      throw error;
    }

    logger.raw(`\nIssue command failed as expected: ${message}`);

    await verifyFailureAssertions(resources.issueNumber ?? 0, logger, client);

    logger.raw("\n=== E2E Failure Test Passed ===\n");
  } finally {
    await cleanup(resources, root, runId, options.keep, logger, client);
    await logger.close();
  }
}

if (isExecutedAsScript()) {
  runE2E().catch((error) => {
    const msg = `Fatal: ${error instanceof Error ? error.message : String(error)}`;
    console.error(msg);
    process.exit(1);
  });
}
