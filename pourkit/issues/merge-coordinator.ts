import type {
  MergePrOptions,
  PRProvider,
  PullRequest,
  WaitForPrChecksOptions,
} from "../providers/pr-provider";
import type { PourkitLogger } from "../shared/common";
import { waitForBranchChecks } from "./target-green";

export interface MergeCoordinatorOptions {
  prProvider: PRProvider;
  logger: PourkitLogger;
  prNumber: number;
  targetBranch: string;
  matchHeadCommit: string;
  checkWaitOptions: WaitForPrChecksOptions;
  autoMerge?: boolean;
  pr?: PullRequest;
  method?: MergePrOptions["method"];
  waitForTargetGreen?: boolean;
}

export type MergeCoordinatorResult =
  | { stage: "completed"; merged: true }
  | { stage: "merge"; merged: false; error: Error }
  | { stage: "target-green"; merged: true; error: Error };

export async function runMergeCoordinator(
  options: MergeCoordinatorOptions
): Promise<MergeCoordinatorResult> {
  const {
    prProvider,
    logger,
    prNumber,
    targetBranch,
    matchHeadCommit,
    checkWaitOptions,
  } = options;
  const method = options.method ?? "squash";
  const waitForTargetGreen = options.waitForTargetGreen ?? true;

  try {
    await prProvider.waitForPrChecks(prNumber, checkWaitOptions);
  } catch (error) {
    return {
      stage: "merge" as const,
      merged: false as const,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  try {
    await prProvider.mergePr(prNumber, {
      method,
      matchHeadCommit,
    });
  } catch (error) {
    return {
      stage: "merge" as const,
      merged: false as const,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  if (waitForTargetGreen) {
    try {
      await waitForBranchChecks(prProvider, logger, {
        branchName: targetBranch,
        checksFoundTimeoutMs: checkWaitOptions.checksFoundTimeoutMs,
        checksCompletionTimeoutMs: checkWaitOptions.checksCompletionTimeoutMs,
        pollIntervalMs: checkWaitOptions.pollIntervalMs,
      });
    } catch (error) {
      return {
        stage: "target-green" as const,
        merged: true as const,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  return { stage: "completed" as const, merged: true as const };
}
