import { execCapture, type PourkitLogger } from "../shared/common";
import type { WorktreeRunState } from "../shared/worktree-run-state";

export type BaseRefreshResult =
  | { status: "skipped-current" }
  | { status: "refreshed" }
  | { status: "conflicted"; message: string; conflictedPaths: string[] }
  | {
      status: "refused-published-history";
      prNumber: number;
      prState: "OPEN" | "CLOSED" | "MERGED";
    };

export interface RefreshStaleIssueBranchOptions {
  worktreePath: string;
  baseBranch: string;
  localGitBaseRef: string;
  logger: PourkitLogger;
  prNumber?: number;
  prState?: "OPEN" | "CLOSED" | "MERGED";
}

export async function isIssueBranchStale(
  worktreePath: string,
  baseBranch: string,
  logger: PourkitLogger
): Promise<boolean> {
  try {
    await execCapture(
      "git",
      ["merge-base", "--is-ancestor", baseBranch, "HEAD"],
      {
        cwd: worktreePath,
        logger,
        label: "git merge-base --is-ancestor",
      }
    );
    return false;
  } catch {
    return true;
  }
}

export async function refreshStaleIssueBranch(
  options: RefreshStaleIssueBranchOptions
): Promise<BaseRefreshResult> {
  const {
    worktreePath,
    baseBranch,
    localGitBaseRef,
    logger,
    prNumber,
    prState,
  } = options;

  const stale = await isIssueBranchStale(worktreePath, localGitBaseRef, logger);
  if (!stale) {
    return { status: "skipped-current" };
  }

  if (prNumber !== undefined && prState !== undefined) {
    return {
      status: "refused-published-history",
      prNumber,
      prState,
    };
  }

  try {
    await execCapture("git", ["rebase", "--autostash", localGitBaseRef], {
      cwd: worktreePath,
      logger,
      label: "git rebase --autostash",
    });
    return { status: "refreshed" };
  } catch (error) {
    let conflictedPaths: string[] = [];
    try {
      const statusResult = await execCapture("git", ["status", "--porcelain"], {
        cwd: worktreePath,
        logger,
        label: "git status",
      });
      conflictedPaths = statusResult.stdout
        .split("\n")
        .filter((line) => /^(AA|DD|UU|AU|UA|DU|UD)\s/.test(line))
        .map((line) => line.slice(3).trim())
        .filter(Boolean);
    } catch {
      // Not critical; leave empty if we can't read status
    }
    return {
      status: "conflicted",
      message: error instanceof Error ? error.message : String(error),
      conflictedPaths,
    };
  }
}

export function invalidateAfterBaseRefresh(
  state: WorktreeRunState
): WorktreeRunState {
  return {
    issueNumber: state.issueNumber,
    targetName: state.targetName,
    branchName: state.branchName,
    baseBranch: state.baseBranch,
    createdAt: state.createdAt,
    updatedAt: new Date().toISOString(),
    completedStages: {
      builder: state.completedStages.builder,
    },
    review: {
      lifetimeIterations: 0,
    },
  };
}
