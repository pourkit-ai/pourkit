import type { PourkitConfig } from "../shared/config";
import type { IssueProvider } from "../providers/issue-provider";
import type { PRProvider } from "../providers/pr-provider";
import type {
  ExecutionProvider,
  ExecutionSession,
} from "../execution/execution-provider";
import type { PourkitLogger } from "../shared/common";
import {
  startIssueRun,
  advanceIssueRunReview,
  completeIssueRun,
  failIssueRun,
  transitionIssueToHumanHandoff,
  type IssueRunStartResult,
  type RunIssueResult,
} from "./issue-run";

class HumanHandoffStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanHandoffStop";
  }
}

export interface RunIssueOptions {
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

export type { RunIssueResult };

export async function runIssueCommand(
  options: RunIssueOptions
): Promise<RunIssueResult> {
  const {
    issueNumber,
    config,
    issueProvider,
    prProvider,
    executionProvider,
    logger,
  } = options;

  const ROOT = options.repoRoot;

  let executionSession: ExecutionSession | undefined;

  try {
    executionSession = await executionProvider.createSession?.();
    const runOptions = executionSession
      ? { ...options, executionProvider: executionSession }
      : options;

    const startResult: IssueRunStartResult = await startIssueRun(runOptions);
    const { issue, target, branchName, worktreeState, executionResult } =
      startResult;

    let reviewArtifactPath: string | undefined;

    const reviewAlreadyPassed =
      worktreeState?.review.lastVerdict &&
      ["PASS", "PASS_WITH_NOTES"].includes(worktreeState.review.lastVerdict) &&
      !worktreeState.review.exhaustedPreviousRun;

    if (reviewAlreadyPassed) {
      reviewArtifactPath = worktreeState.review.lastArtifactPath;
    } else {
      const lifetimeIterationsFromState =
        worktreeState?.review.lifetimeIterations ?? 0;
      const humanHandoffResolved =
        worktreeState?.review.lastVerdict === "NEEDS_HUMAN";
      const reviewResult = await advanceIssueRunReview({
        executionProvider: runOptions.executionProvider,
        config,
        target,
        issue,
        builderBranch: branchName,
        worktreePath: executionResult.worktreePath,
        repoRoot: ROOT,
        logger,
        startingLifetimeIteration: lifetimeIterationsFromState,
        humanHandoffResolved,
        serena: startResult.serena,
      });

      if (reviewResult.exhaustedMaxIterations) {
        throw new Error(
          `Max review iterations (${reviewResult.iterations}) exhausted`
        );
      }

      if (reviewResult.verdict === "FAIL") {
        throw new Error(`Review failed with FAIL verdict`);
      }

      if (reviewResult.verdict === "NEEDS_HUMAN") {
        await transitionIssueToHumanHandoff({
          issueProvider,
          issueNumber,
          config,
          logger,
          reviewResult,
        });
        throw new HumanHandoffStop(
          `Review requires human handoff: NEEDS_HUMAN verdict`
        );
      }

      reviewArtifactPath = reviewResult.artifactPath;
    }

    return await completeIssueRun({
      ...runOptions,
      startResult,
      reviewArtifactPath,
    });
  } catch (error) {
    if (!(error instanceof HumanHandoffStop)) {
      await failIssueRun({
        issueProvider,
        issueNumber,
        config,
        logger,
        error: error instanceof Error ? error : String(error),
      });
    }
    throw error;
  } finally {
    await executionSession?.close();
  }
}
