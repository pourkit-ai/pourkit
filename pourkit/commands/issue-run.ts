import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type {
  PourkitConfig,
  IssueData,
  ResolvedTarget,
} from "../shared/config";
import { resolvePromptTemplatePath, resolveTarget } from "../shared/config";
import { renderBranchName } from "../pr/templates";
import type { IssueProvider } from "../providers/issue-provider";
import type { PRProvider } from "../providers/pr-provider";
import type {
  ExecutionProvider,
  ExecutionResult,
} from "../execution/execution-provider";
import {
  execCapture,
  readMaybeEnvInt,
  parseWorktreeListPorcelain,
  type PourkitLogger,
} from "../shared/common";
import {
  buildRunContextArtifact,
  RUN_CONTEXT_PATH_IN_WORKTREE,
  STAGE_SECTIONS,
} from "../shared/run-context";
import { appendProtectedWorkGuidance } from "../shared/prompt-guidance";
import {
  readWorktreeRunState,
  writeWorktreeRunState,
  updateWorktreeRunState,
  type WorktreeRunState,
} from "../shared/worktree-run-state";
import {
  refreshStaleIssueBranch,
  invalidateAfterBaseRefresh,
} from "./base-refresh";
import { runConflictResolutionLoop } from "./conflict-resolution";
import { runFinalizerAgent } from "./pr-description-agent";
import { ensureClosingRefs } from "../pr/pr-body";
import {
  ensureConventionalPrTitle,
  parsePrDescription,
} from "../pr/pr-description";
import { runMergeCoordinator } from "../issues/merge-coordinator";
import { waitForBranchChecks } from "../issues/target-green";
import {
  runReviewWithRefactorLoop,
  type ReviewLoopResult,
  type RunReviewLoopOptions,
} from "./review";
import {
  createIssueTransitions,
  type IssueTransitionsContract,
} from "../issues/issue-transitions";
import { parseStackedIssue } from "../issues/stacked-issue";
const EXECUTION_TIMEOUT_MS =
  readMaybeEnvInt(process.env.POURKIT_TIMEOUT_SECONDS, 30 * 60) * 1000;

export type IssueWorktreeResolution =
  | {
      mode: "new";
      branchName: string;
      baseRef: string;
      worktreePath?: undefined;
    }
  | {
      mode: "existing-worktree";
      branchName: string;
      baseRef: string;
      worktreePath: string;
    }
  | {
      mode: "existing-branch";
      branchName: string;
      baseRef: string;
      worktreePath: string;
    };

export interface StartIssueRunOptions {
  issueNumber: number;
  targetName?: string;
  config: PourkitConfig;
  issueProvider: IssueProvider;
  prProvider: PRProvider;
  executionProvider: ExecutionProvider;
  force: boolean;
  resetWorktree?: boolean;
  logger: PourkitLogger;
  repoRoot: string;
}

export interface IssueGates {
  isOpen: boolean;
  isReadyForAgent: boolean;
  isNotBlocked: boolean;
  isNotInProgress: boolean;
}

export interface IssueGateResult {
  allowed: boolean;
  gates: IssueGates;
  reason?: string;
}

export function checkIssueGates(
  issue: IssueData,
  config: PourkitConfig,
  force: boolean
): IssueGateResult {
  const gates: IssueGates = {
    isOpen: issue.state === "open",
    isReadyForAgent: issue.labels.includes(config.labels.readyForAgent),
    isNotBlocked: !issue.labels.includes(config.labels.blocked),
    isNotInProgress: !issue.labels.includes(config.labels.agentInProgress),
  };

  if (force) {
    return { allowed: true, gates };
  }

  const failed: string[] = [];

  if (!gates.isOpen) {
    failed.push(`issue ${issue.number} is not open`);
  }

  if (!gates.isReadyForAgent) {
    failed.push(
      `issue ${issue.number} is not labeled ${config.labels.readyForAgent}`
    );
  }

  if (!gates.isNotBlocked) {
    failed.push(`issue ${issue.number} is labeled ${config.labels.blocked}`);
  }

  if (!gates.isNotInProgress) {
    failed.push(
      `issue ${issue.number} is already labeled ${config.labels.agentInProgress}`
    );
  }

  if (failed.length > 0) {
    return {
      allowed: false,
      gates,
      reason: failed.join("; "),
    };
  }

  return { allowed: true, gates };
}

export interface IssueRunStartResult {
  issue: IssueData;
  target: ResolvedTarget;
  branchName: string;
  worktreeState: WorktreeRunState | null;
  executionResult: ExecutionResult;
}

export interface RunIssueResult {
  branchName: string;
  target: ResolvedTarget;
  issue: IssueData;
  prNumber?: number;
  prUrl?: string;
  prTitle?: string;
  prBody?: string;
  noOp: boolean;
}

export interface CompleteIssueRunOptions extends StartIssueRunOptions {
  startResult: IssueRunStartResult;
  reviewArtifactPath?: string;
}

export interface FailIssueRunOptions {
  issueProvider: IssueProvider;
  issueNumber: number;
  config: PourkitConfig;
  logger: PourkitLogger;
  error: Error | string;
}

export async function startIssueRun(
  options: StartIssueRunOptions
): Promise<IssueRunStartResult> {
  const {
    issueNumber,
    targetName,
    config,
    issueProvider,
    prProvider,
    executionProvider,
    force,
    logger,
  } = options;
  const ROOT = options.repoRoot;

  const issue = await issueProvider.fetchIssue(issueNumber);

  const gateResult = checkIssueGates(issue, config, force);
  if (!gateResult.allowed) {
    throw new Error(`Issue gates failed: ${gateResult.reason}`);
  }

  const target = resolveTarget(config, targetName);
  const branchName = renderBranchName(target.branchTemplate, issue);
  const strategy = target.strategy;

  if (options.resetWorktree) {
    const existingPr = await prProvider.getPr(branchName);
    if (existingPr && existingPr.state === "OPEN") {
      throw new Error(
        `Cannot reset worktree: open PR #${existingPr.number} exists for branch ${branchName}. Close the PR first or omit --reset-worktree.`
      );
    }
    await resetLocalBranchState(ROOT, branchName, logger);
    await syncTargetBranch(ROOT, target.baseBranch, logger);
  }

  const prompt = loadBuilderPrompt(
    ROOT,
    strategy.implement.builder.promptTemplate
  );

  const resolution = await resolveIssueWorktree(
    ROOT,
    branchName,
    target.baseBranch,
    logger
  );

  const worktreeState = resolution.worktreePath
    ? readWorktreeRunState(resolution.worktreePath)
    : null;

  if (resolution.mode !== "new") {
    const existingPr = await prProvider.getPr(branchName);

    const refreshResult = await refreshStaleIssueBranch({
      worktreePath: resolution.worktreePath!,
      baseBranch: target.baseBranch,
      localGitBaseRef: resolution.baseRef,
      logger,
      prNumber: existingPr?.number,
      prState: existingPr?.state,
    });
    if (refreshResult.status === "refreshed") {
      if (worktreeState?.completedStages.builder) {
        const invalidatedState = invalidateAfterBaseRefresh(worktreeState);
        writeWorktreeRunState(resolution.worktreePath!, invalidatedState);
      }
    } else if (refreshResult.status === "conflicted") {
      if (strategy.conflictResolution && resolution.worktreePath) {
        const crLoopResult = await runConflictResolutionLoop({
          executionProvider,
          config,
          target,
          issue,
          branchName,
          worktreePath: resolution.worktreePath,
          repoRoot: ROOT,
          initialConflictedPaths: refreshResult.conflictedPaths,
          maxAttempts: strategy.conflictResolution.maxAttempts,
          logger,
        });

        if (crLoopResult.status === "completed") {
          if (strategy.verify?.commands) {
            for (const cmd of strategy.verify.commands) {
              await execCapture("bash", ["-lc", cmd.command], {
                cwd: resolution.worktreePath,
                logger,
                label: `verify ${cmd.label}`,
              });
            }
          }
          if (worktreeState?.completedStages.builder) {
            const invalidatedState = invalidateAfterBaseRefresh(worktreeState);
            writeWorktreeRunState(resolution.worktreePath, invalidatedState);
          }
        } else {
          const failureMessage =
            crLoopResult.status === "ambiguous"
              ? `Conflict resolution ambiguous: ${crLoopResult.message}`
              : crLoopResult.status === "exhausted"
                ? `Conflict resolution maxAttempts (${strategy.conflictResolution.maxAttempts}) exhausted: ${crLoopResult.message}`
                : `Conflict resolution failed: ${crLoopResult.message}`;
          const failureStage = "conflictResolution" as const;

          if (worktreeState) {
            updateWorktreeRunState(resolution.worktreePath, {
              lastFailure: {
                stage: failureStage,
                message: failureMessage,
              },
            });
          } else {
            writeWorktreeRunState(resolution.worktreePath, {
              issueNumber,
              targetName: target.name,
              branchName,
              baseBranch: target.baseBranch,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedStages: {},
              review: { lifetimeIterations: 0 },
              lastFailure: {
                stage: failureStage,
                message: failureMessage,
              },
            });
          }

          await transitionIssueToFailureState(
            issueProvider,
            issueNumber,
            config,
            failureMessage,
            logger
          );
          throw new Error(failureMessage);
        }
      } else {
        if (resolution.worktreePath) {
          if (worktreeState) {
            updateWorktreeRunState(resolution.worktreePath, {
              lastFailure: {
                stage: "baseRefresh",
                message: `Base refresh conflict detected. Handing off to human: ${refreshResult.message}`,
              },
            });
          } else {
            writeWorktreeRunState(resolution.worktreePath, {
              issueNumber,
              targetName: target.name,
              branchName,
              baseBranch: target.baseBranch,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedStages: {},
              review: { lifetimeIterations: 0 },
              lastFailure: {
                stage: "baseRefresh",
                message: `Base refresh conflict detected. Handing off to human: ${refreshResult.message}`,
              },
            });
          }
        }
        await transitionIssueToFailureState(
          issueProvider,
          issueNumber,
          config,
          `Base refresh conflicted: ${refreshResult.message}. Worktree preserved at ${resolution.worktreePath}.`,
          logger
        );
        throw new Error(`Base refresh conflicted: ${refreshResult.message}`);
      }
    } else if (refreshResult.status === "refused-published-history") {
      throw new Error(
        `Cannot auto-refresh published history: PR #${refreshResult.prNumber} (${refreshResult.prState}) exists for branch ${branchName}`
      );
    }
  }

  const runContextArtifact = buildRunContextArtifact({
    issue,
    target,
    branchName,
    reviewerCriteria: strategy.review.reviewer.criteria,
    sections: STAGE_SECTIONS.builder,
  });

  await issueProvider.addLabels(issueNumber, [config.labels.agentInProgress]);
  await issueProvider.removeLabel(issueNumber, config.labels.readyForAgent);

  let executionResult: ExecutionResult;

  const shouldRunBuilder =
    resolution.mode === "new"
      ? true
      : worktreeState === null || !worktreeState.completedStages.builder;

  if (shouldRunBuilder) {
    executionResult = await executionProvider.execute({
      stage: "builder",
      agent: strategy.implement.builder.agent,
      model: strategy.implement.builder.model,
      prompt,
      target,
      repoRoot: ROOT,
      branchName,
      ...(resolution.mode === "new" ? { baseRef: resolution.baseRef } : {}),
      sandbox: config.sandbox,
      autoApprove: true,
      timeoutMs: EXECUTION_TIMEOUT_MS,
      ...(resolution.worktreePath
        ? { worktreePath: resolution.worktreePath }
        : {}),
      artifacts: [runContextArtifact],
      logger,
    });

    if (!executionResult.success) {
      throw new Error(`Sandcastle failed: ${executionResult.error}`);
    }
  } else {
    executionResult = {
      success: true,
      branch: branchName,
      worktreePath: resolution.worktreePath!,
      commits: [],
      logPath: null,
    };
  }

  if (executionResult.worktreePath) {
    if (worktreeState) {
      updateWorktreeRunState(executionResult.worktreePath, {
        completedStages: { builder: true },
      });
    } else {
      writeWorktreeRunState(executionResult.worktreePath, {
        issueNumber,
        targetName: target.name,
        branchName,
        baseBranch: target.baseBranch,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedStages: { builder: true },
        review: { lifetimeIterations: 0 },
      });
    }
  }

  const finalWorktreeState = executionResult.worktreePath
    ? readWorktreeRunState(executionResult.worktreePath)
    : worktreeState;

  return {
    issue,
    target,
    branchName,
    worktreeState: finalWorktreeState,
    executionResult,
  };
}

export async function advanceIssueRunReview(
  options: RunReviewLoopOptions
): Promise<ReviewLoopResult> {
  const accumulatedRefactorPaths: string[] = [];

  const reviewResult = await runReviewWithRefactorLoop({
    ...options,
    onRefactorProgress: async (progress) => {
      if (progress.refactorArtifactPath) {
        accumulatedRefactorPaths.push(progress.refactorArtifactPath);
      }
      updateWorktreeRunState(options.worktreePath, {
        review: {
          lifetimeIterations: progress.lifetimeIterations,
          lastVerdict: progress.lastVerdict,
          lastArtifactPath: progress.lastArtifactPath,
          refactorCompletedForLastReview: true,
        },
      });
    },
  });

  updateWorktreeRunState(options.worktreePath, {
    review: {
      lifetimeIterations: reviewResult.lifetimeIterations,
      lastVerdict: reviewResult.verdict,
      lastArtifactPath: reviewResult.artifactPath,
      refactorCompletedForLastReview:
        reviewResult.refactorCompletedForLastReview,
      exhaustedPreviousRun:
        reviewResult.exhaustedMaxIterations ||
        reviewResult.verdict === "FAIL" ||
        undefined,
      refactorArtifactPaths:
        accumulatedRefactorPaths.length > 0
          ? accumulatedRefactorPaths
          : undefined,
    },
  });

  return reviewResult;
}

export async function completeIssueRun(
  options: CompleteIssueRunOptions
): Promise<RunIssueResult> {
  const {
    issueNumber,
    config,
    issueProvider,
    prProvider,
    executionProvider,
    logger,
    startResult,
    reviewArtifactPath,
  } = options;
  const ROOT = options.repoRoot;
  const { issue, target, branchName, worktreeState, executionResult } =
    startResult;
  const checkWaitOptions = {
    checksFoundTimeoutMs: config.checks.checksFoundTimeoutSeconds * 1000,
    checksCompletionTimeoutMs:
      config.checks.checksCompletionTimeoutSeconds * 1000,
    pollIntervalMs: config.checks.pollIntervalSeconds * 1000,
  };

  let mergeCompleted = false;

  try {
    if (
      executionResult.worktreePath &&
      !worktreeState?.finalCommit?.completed &&
      !worktreeState?.pr?.created &&
      !(await hasWorktreeChanges(
        executionResult.worktreePath,
        `origin/${target.baseBranch}`,
        logger
      ))
    ) {
      logger.step(
        "info",
        "No worktree changes detected after review - closing issue"
      );
      await closeNoOpIssue(issueProvider, issueNumber, config, logger);
      return {
        branchName,
        target,
        issue,
        noOp: true,
      };
    }

    let prTitle = issue.title;
    let prBody: string | undefined;
    let finalizerResult:
      | Awaited<ReturnType<typeof runFinalizerAgent>>
      | undefined;

    const finalizerFromState = worktreeState?.finalizer?.completed
      ? worktreeState.finalizer
      : null;
    if (finalizerFromState) {
      if (finalizerFromState.title && finalizerFromState.body) {
        prTitle = finalizerFromState.title;
        prBody = finalizerFromState.body;
      } else if (finalizerFromState.artifactPath) {
        if (!existsSync(finalizerFromState.artifactPath)) {
          throw new Error(
            `Finalizer artifact missing at ${finalizerFromState.artifactPath}`
          );
        }
        const artifactContent = readFileSync(
          finalizerFromState.artifactPath,
          "utf-8"
        );
        const parsed = parsePrDescription(artifactContent);
        prTitle = parsed.title;
        prBody = parsed.body;
      } else {
        throw new Error(
          "Finalizer state is incomplete: missing title, body, and artifactPath"
        );
      }
    } else {
      finalizerResult = await runFinalizerAgent({
        executionProvider,
        config,
        target,
        issue,
        builderBranch: branchName,
        worktreePath: executionResult.worktreePath,
        reviewArtifactPath,
        repoRoot: ROOT,
        logger,
      });
      prTitle = finalizerResult.title;
      prBody = finalizerResult.body;
    }

    prTitle = ensureConventionalPrTitle(
      prTitle,
      executionResult.commits.join("\n")
    );

    const finalBody = ensureClosingRefs(
      prBody ?? `Closes #${issue.number}`,
      issue.number
    );

    if (!finalizerFromState && executionResult.worktreePath) {
      updateWorktreeRunState(executionResult.worktreePath, {
        finalizer: {
          completed: true,
          artifactPath: finalizerResult!.artifactPath,
          title: prTitle,
          body: prBody,
        },
      });
    }

    const finalCommitFromState = worktreeState?.finalCommit?.completed;
    if (!finalCommitFromState) {
      await finalizeWorktreeCommit({
        worktreePath: executionResult.worktreePath,
        baseRef: `origin/${target.baseBranch}`,
        title: prTitle,
        body: finalBody,
        logger,
      });

      if (executionResult.worktreePath) {
        const revParse = await execCapture("git", ["rev-parse", "HEAD"], {
          cwd: executionResult.worktreePath,
          logger,
          label: "git rev-parse HEAD",
        });
        updateWorktreeRunState(executionResult.worktreePath, {
          finalCommit: {
            completed: true,
            sha: revParse.stdout.trim(),
          },
        });
      }
    }

    let pr: Awaited<ReturnType<PRProvider["createPr"]>>;

    if (worktreeState?.pr?.merged) {
      mergeCompleted = true;
      pr = {
        number: worktreeState.pr.number!,
        nodeId: "",
        url: worktreeState.pr.url!,
        title: prTitle,
        body: finalBody,
        headRefName: branchName,
        baseRefName: target.baseBranch,
        state: "MERGED",
        headRefOid: worktreeState.finalCommit?.sha ?? "",
      };
    } else {
      const prFromState =
        worktreeState?.pr?.created || finalCommitFromState
          ? await prProvider.getPr(branchName)
          : null;

      if (prFromState && prFromState.state === "OPEN") {
        pr = prFromState;
      } else {
        await execCapture("git", ["push", "-u", "origin", branchName], {
          cwd: executionResult.worktreePath,
          logger,
          label: "git push",
        });

        pr = await prProvider.createPr({
          title: prTitle,
          body: finalBody,
          head: branchName,
          base: target.baseBranch,
        });

        if (executionResult.worktreePath) {
          updateWorktreeRunState(executionResult.worktreePath, {
            pr: {
              created: true,
              number: pr.number,
              url: pr.url,
            },
          });
        }
      }

      if (target.autoMerge === false) {
        await prProvider.waitForPrChecks(pr.number, checkWaitOptions);
        const transitions = makeIssueTransitions(issueProvider, config);
        await transitions.moveToReadyForHuman(issueNumber);
        return {
          branchName,
          target,
          issue,
          prNumber: pr.number,
          prUrl: pr.url,
          prTitle,
          prBody: finalBody,
          noOp: false,
        };
      }

      await issueProvider.addLabels(issueNumber, [
        config.labels.prOpenAwaitingMerge,
      ]);
      const coordinatorResult = await runMergeCoordinator({
        prProvider,
        logger,
        prNumber: pr.number,
        targetBranch: target.baseBranch,
        matchHeadCommit: pr.headRefOid,
        checkWaitOptions,
        autoMerge: true,
        pr,
      });

      if (coordinatorResult.stage === "merge") {
        throw coordinatorResult.error;
      }

      if (coordinatorResult.stage === "target-green") {
        try {
          await issueProvider.removeLabel(
            issueNumber,
            config.labels.prOpenAwaitingMerge
          );
        } catch (labelError) {
          logger.step(
            "warn",
            `Failed to remove ${config.labels.prOpenAwaitingMerge} label (cleanup): ${labelError instanceof Error ? labelError.message : String(labelError)}`
          );
        }
        throw coordinatorResult.error;
      }

      mergeCompleted = true;

      if (executionResult.worktreePath) {
        updateWorktreeRunState(executionResult.worktreePath, {
          pr: { merged: true, created: true },
        });
      }
    }

    if (worktreeState?.pr?.merged) {
      await waitForBranchChecks(prProvider, logger, {
        branchName: target.baseBranch,
        checksFoundTimeoutMs: checkWaitOptions.checksFoundTimeoutMs,
        checksCompletionTimeoutMs: checkWaitOptions.checksCompletionTimeoutMs,
        pollIntervalMs: checkWaitOptions.pollIntervalMs,
      });
    }

    await issueProvider.removeLabel(issueNumber, config.labels.agentInProgress);
    await issueProvider.removeLabel(
      issueNumber,
      config.labels.prOpenAwaitingMerge
    );

    let childCloseSucceeded = false;
    try {
      await issueProvider.closeIssue(issueNumber);
      childCloseSucceeded = true;
    } catch (error) {
      logger.step(
        "warn",
        `Issue #${issueNumber} could not be closed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (childCloseSucceeded) {
      await maybeCloseParentAfterChildCompletion(
        issueProvider,
        issueNumber,
        logger
      );
    }

    return {
      branchName,
      target,
      issue,
      prNumber: pr.number,
      prUrl: pr.url,
      prTitle,
      prBody: finalBody,
      noOp: false,
    };
  } catch (error) {
    if (mergeCompleted) {
      try {
        await issueProvider.removeLabel(
          issueNumber,
          config.labels.prOpenAwaitingMerge
        );
      } catch {
        // Ignore cleanup errors when removing label after merge
      }
    }
    throw error;
  }
}

export async function failIssueRun(
  options: FailIssueRunOptions
): Promise<void> {
  const { issueProvider, issueNumber, config, logger, error } = options;
  await transitionIssueToFailureState(
    issueProvider,
    issueNumber,
    config,
    typeof error === "string" ? error : error.message,
    logger
  );
}

export interface HumanHandoffOptions {
  issueProvider: IssueProvider;
  issueNumber: number;
  config: PourkitConfig;
  logger: PourkitLogger;
  reviewResult: ReviewLoopResult;
}

export async function transitionIssueToHumanHandoff(
  options: HumanHandoffOptions
): Promise<void> {
  const { issueProvider, issueNumber, config, logger, reviewResult } = options;

  const transitions = makeIssueTransitions(issueProvider, config);
  await transitions.moveToReadyForHuman(issueNumber);

  const summary = extractHumanHandoffSummary(reviewResult.output);
  const refactorDir = getRefactorArtifactDir(reviewResult.artifactPath);

  const comment = [
    "Pourkit stopped the review/refactor loop because human input is needed.",
    "",
    summary,
    "",
    "Artifacts:",
    `- Review: ${reviewResult.artifactPath}`,
    `- Refactors: ${refactorDir}`,
  ].join("\n");

  await issueProvider.commentIssue(issueNumber, comment);

  logger.step("info", `Issue ${issueNumber} transitioned to human handoff`);
}

function extractHumanHandoffSummary(artifactContent: string): string {
  const lines = artifactContent.split("\n");
  let inSummary = false;
  const summaryLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("## Human Handoff Summary")) {
      inSummary = true;
      continue;
    }
    if (inSummary) {
      if (line.startsWith("## ")) {
        break;
      }
      summaryLines.push(line);
    }
  }
  return (
    summaryLines.join("\n").trim() || "(No Human Handoff Summary provided)"
  );
}

function getRefactorArtifactDir(artifactPath: string): string {
  return artifactPath
    .replace(/\/reviewers\//, "/refactors/")
    .replace(/\/[^/]+$/, "");
}

async function finalizeWorktreeCommit(options: {
  worktreePath: string;
  baseRef: string;
  title: string;
  body: string;
  logger: PourkitLogger;
}) {
  const { worktreePath, baseRef, title, body, logger } = options;

  await syncRemoteBaseRef(worktreePath, baseRef, logger);

  try {
    await execCapture("git", ["merge-base", "--is-ancestor", baseRef, "HEAD"], {
      cwd: worktreePath,
      logger,
      label: "git merge-base --is-ancestor",
    });
  } catch {
    throw new Error(
      `Cannot finalize stale worktree: ${baseRef} is not an ancestor of HEAD. Refresh the branch onto the latest target base before creating the final commit.`
    );
  }

  await execCapture("git", ["reset", "--soft", baseRef], {
    cwd: worktreePath,
    logger,
    label: "git reset",
  });

  await execCapture("git", ["add", "-A"], {
    cwd: worktreePath,
    logger,
    label: "git add",
  });

  await execCapture("git", ["commit", "--no-verify", "-m", title, "-m", body], {
    cwd: worktreePath,
    logger,
    label: "git commit",
  });
}

async function syncRemoteBaseRef(
  worktreePath: string,
  baseRef: string,
  logger: PourkitLogger
) {
  const remoteBase = parseRemoteBaseRef(baseRef);
  if (!remoteBase) {
    return;
  }

  await execCapture("git", ["fetch", remoteBase.remote, remoteBase.branch], {
    cwd: worktreePath,
    logger,
    label: "git fetch target",
  });
}

function parseRemoteBaseRef(baseRef: string): {
  remote: string;
  branch: string;
} | null {
  const [remote, ...branchParts] = baseRef.split("/");
  const branch = branchParts.join("/");
  if (!remote || !branch) {
    return null;
  }
  return { remote, branch };
}

function makeIssueTransitions(
  provider: IssueProvider,
  config: PourkitConfig
): IssueTransitionsContract {
  return createIssueTransitions(
    {
      fetchIssue: provider.fetchIssue.bind(provider),
      addLabels: provider.addLabels.bind(provider),
      removeLabel: provider.removeLabel.bind(provider),
      closeIssue: provider.closeIssue.bind(provider),
    },
    {
      blocked: config.labels.blocked,
      readyForAgent: config.labels.readyForAgent,
      needsTriage: config.labels.needsTriage,
      agentInProgress: config.labels.agentInProgress,
      readyForHuman: config.labels.readyForHuman,
      prOpenAwaitingMerge: config.labels.prOpenAwaitingMerge,
    }
  );
}

async function transitionIssueToFailureState(
  provider: IssueProvider,
  issueNumber: number,
  config: PourkitConfig,
  errorMessage: string,
  logger: PourkitLogger
) {
  const transitions = makeIssueTransitions(provider, config);
  await transitions.moveToReadyForHuman(issueNumber);

  logger.step(
    "error",
    `Issue ${issueNumber} transitioned to ${config.labels.readyForHuman}: ${errorMessage}`
  );
}

async function hasWorktreeChanges(
  worktreePath: string,
  baseRef: string,
  logger: PourkitLogger
): Promise<boolean> {
  const diffResult = await execCapture(
    "git",
    ["diff", "--name-only", baseRef, "--"],
    {
      cwd: worktreePath,
      logger,
      label: "git diff --name-only",
    }
  );
  if (diffResult.stdout.trim().length > 0) {
    return true;
  }

  const statusResult = await execCapture(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    {
      cwd: worktreePath,
      logger,
      label: "git status --porcelain",
    }
  );
  return statusResult.stdout.trim().length > 0;
}

async function closeNoOpIssue(
  provider: IssueProvider,
  issueNumber: number,
  config: PourkitConfig,
  logger: PourkitLogger
): Promise<void> {
  const transitions = makeIssueTransitions(provider, config);

  let closeSucceeded = false;
  try {
    await transitions.closeCompleted(issueNumber);
    closeSucceeded = true;
    logger.step("info", `Issue #${issueNumber} closed (no changes required)`);
  } catch (error) {
    logger.step(
      "warn",
      `Issue #${issueNumber} could not be closed: ${error instanceof Error ? error.message : String(error)}`
    );
    logger.step(
      "info",
      `Issue #${issueNumber} completed with no changes required`
    );
  }

  if (closeSucceeded) {
    await maybeCloseParentAfterChildCompletion(provider, issueNumber, logger);
  }
}

async function maybeCloseParentAfterChildCompletion(
  provider: IssueProvider,
  issueNumber: number,
  logger: PourkitLogger
): Promise<void> {
  try {
    const issue = await provider.fetchIssue(issueNumber);
    const parsed = parseStackedIssue(issue.title, issue.body);
    if (!parsed.parentRef) return;
    if (parsed.warnings.length > 0) return;

    const parent = await provider.resolveIssueByCanonicalRef(parsed.parentRef);
    if (!parent) return;
    if (parent.state !== "open") return;

    const siblings = await provider.listRelatedIssues(parsed.parentRef);
    const openSiblings = siblings.filter(
      (s) => s.number !== issueNumber && s.state === "open"
    );
    if (openSiblings.length > 0) return;

    await provider.closeIssue(parent.number);
    logger.step(
      "info",
      `Parent PRD #${parent.number} closed (last child completed)`
    );
  } catch (error) {
    logger.step(
      "warn",
      `Parent completion check failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function resetLocalBranchState(
  root: string,
  branchName: string,
  logger: PourkitLogger
): Promise<void> {
  const worktreeList = await execCapture(
    "git",
    ["worktree", "list", "--porcelain"],
    { cwd: root, logger, label: "git worktree list" }
  );

  const existingWorktreePath = resolveRegisteredIssueWorktreePath(
    worktreeList.stdout,
    root,
    branchName
  );

  if (existingWorktreePath) {
    logger.step("git", `removing existing worktree: ${existingWorktreePath}`);
    await execCapture(
      "git",
      ["worktree", "remove", "--force", existingWorktreePath],
      {
        cwd: root,
        logger,
        label: "git worktree remove",
      }
    );
  }

  let branchExists = false;
  try {
    await execCapture(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
      { cwd: root, logger, label: "git branch exists" }
    );
    branchExists = true;
  } catch {
    // No local branch to delete.
  }

  if (branchExists) {
    logger.step("git", `deleting local branch: ${branchName}`);
    await execCapture("git", ["branch", "-D", branchName], {
      cwd: root,
      logger,
      label: "git branch -D",
    });
  }
}

async function resolveIssueWorktree(
  root: string,
  branchName: string,
  baseBranch: string,
  logger: PourkitLogger
): Promise<IssueWorktreeResolution> {
  const worktreeList = await execCapture(
    "git",
    ["worktree", "list", "--porcelain"],
    {
      cwd: root,
      logger,
      label: "git worktree list",
    }
  );

  const existingWorktreePath = resolveRegisteredIssueWorktreePath(
    worktreeList.stdout,
    root,
    branchName
  );

  if (existingWorktreePath) {
    const baseRef = await syncTargetBranch(root, baseBranch, logger);
    return {
      mode: "existing-worktree",
      branchName,
      baseRef,
      worktreePath: existingWorktreePath,
    };
  }

  let branchExists = false;
  try {
    await execCapture(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
      {
        cwd: root,
        logger,
        label: "git branch exists",
      }
    );
    branchExists = true;
  } catch {
    // No local branch to resume from.
  }

  if (branchExists) {
    const worktreePath = issueWorktreePath(root, branchName);
    await execCapture("git", ["worktree", "add", worktreePath, branchName], {
      cwd: root,
      logger,
      label: "git worktree add",
    });
    const baseRef = await syncTargetBranch(root, baseBranch, logger);
    return {
      mode: "existing-branch",
      branchName,
      baseRef,
      worktreePath,
    };
  }

  const baseRef = await syncTargetBranch(root, baseBranch, logger);
  return { mode: "new", branchName, baseRef };
}

function issueWorktreePath(root: string, branchName: string): string {
  return join(root, ".sandcastle", "worktrees", branchName.replace(/\//g, "-"));
}

function resolveRegisteredIssueWorktreePath(
  worktreeListPorcelain: string,
  root: string,
  branchName: string
): string | null {
  const branchWorktreePath = parseWorktreeListPorcelain(
    worktreeListPorcelain,
    branchName
  );
  if (branchWorktreePath) return branchWorktreePath;

  const expectedWorktreePath = issueWorktreePath(root, branchName);
  const entries = worktreeListPorcelain.trim().split("\n\n");
  for (const entry of entries) {
    if (
      entry
        .trim()
        .split("\n")
        .some((line) => line === `worktree ${expectedWorktreePath}`)
    ) {
      return expectedWorktreePath;
    }
  }

  return null;
}

async function syncTargetBranch(
  root: string,
  baseBranch: string,
  logger: PourkitLogger
): Promise<string> {
  logger.step("git", `syncing target branch: ${baseBranch}`);
  await execCapture("git", ["fetch", "origin", baseBranch], {
    cwd: root,
    logger,
    label: "git fetch target",
  });
  return `origin/${baseBranch}`;
}

function loadBuilderPrompt(repoRoot: string, promptTemplate: string): string {
  const promptPath = resolvePromptTemplatePath(repoRoot, promptTemplate);
  const promptBody = existsSync(promptPath)
    ? readFileSync(promptPath, "utf-8")
    : promptTemplate;

  return appendProtectedWorkGuidance(`${promptBody}

## Shared Run Context

Read the selected issue requirements, comments, branch context, validation commands, and artifact paths from: ${RUN_CONTEXT_PATH_IN_WORKTREE}`);
}
