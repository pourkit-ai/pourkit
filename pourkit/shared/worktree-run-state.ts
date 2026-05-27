import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export const WORKTREE_RUN_STATE_PATH = ".pourkit/state.json";

export type WorktreeRunStage =
  | "builder"
  | "verification"
  | "review"
  | "refactor"
  | "finalizer"
  | "finalCommit"
  | "pr"
  | "baseRefresh"
  | "conflictResolution";

export interface WorktreeRunState {
  issueNumber: number;
  targetName: string;
  branchName: string;
  baseBranch: string;
  createdAt: string;
  updatedAt: string;
  completedStages: {
    builder?: boolean;
    initialVerification?: boolean;
  };
  review: {
    lifetimeIterations: number;
    lastVerdict?:
      | "PASS"
      | "PASS_WITH_NOTES"
      | "NEEDS_REFACTOR"
      | "FAIL"
      | "NEEDS_HUMAN";
    lastArtifactPath?: string;
    refactorArtifactPaths?: string[];
    refactorCompletedForLastReview?: boolean;
    exhaustedPreviousRun?: boolean;
  };
  finalizer?: {
    completed: boolean;
    artifactPath?: string;
    title?: string;
    body?: string;
  };
  finalCommit?: {
    completed: boolean;
    sha?: string;
  };
  pr?: {
    created: boolean;
    number?: number;
    url?: string;
    merged?: boolean;
  };
  lastFailure?: {
    stage: WorktreeRunStage;
    message: string;
  };
}

export function readWorktreeRunState(
  worktreePath: string
): WorktreeRunState | null {
  const statePath = join(worktreePath, WORKTREE_RUN_STATE_PATH);
  if (!existsSync(statePath)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf-8"));
    if (isValidWorktreeRunState(raw)) {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

function isValidWorktreeRunState(raw: unknown): raw is WorktreeRunState {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.completedStages !== "object" || obj.completedStages === null)
    return false;
  if (typeof obj.review !== "object" || obj.review === null) return false;
  const review = obj.review as Record<string, unknown>;
  if (typeof review.lifetimeIterations !== "number") return false;
  return true;
}

export function writeWorktreeRunState(
  worktreePath: string,
  state: WorktreeRunState
): void {
  const statePath = join(worktreePath, WORKTREE_RUN_STATE_PATH);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

export function updateWorktreeRunState(
  worktreePath: string,
  update: Partial<WorktreeRunState>
): void {
  const existing =
    readWorktreeRunState(worktreePath) ?? ({} as WorktreeRunState);
  const merged: WorktreeRunState = {
    ...existing,
    ...update,
    updatedAt: new Date().toISOString(),
    completedStages: {
      ...existing.completedStages,
      ...(update.completedStages ?? {}),
    },
    review: {
      ...existing.review,
      ...(update.review ?? {}),
    },
    finalizer:
      update.finalizer !== undefined
        ? { ...existing.finalizer, ...update.finalizer }
        : existing.finalizer,
    finalCommit:
      update.finalCommit !== undefined
        ? { ...existing.finalCommit, ...update.finalCommit }
        : existing.finalCommit,
    pr:
      update.pr !== undefined ? { ...existing.pr, ...update.pr } : existing.pr,
  };
  writeWorktreeRunState(worktreePath, merged);
}
