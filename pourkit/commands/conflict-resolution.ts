import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { PourkitConfig, IssueData, Target } from "../shared/config";
import { resolvePromptTemplatePath } from "../shared/config";
import type { ExecutionProvider } from "../execution/execution-provider";
import { execCapture, type PourkitLogger } from "../shared/common";
import {
  buildRunContextArtifact,
  RUN_CONTEXT_PATH_IN_WORKTREE,
  STAGE_SECTIONS,
} from "../shared/run-context";
import {
  ConflictResolutionArtifactProtocolError,
  parseConflictResolutionArtifact,
} from "../conflicts/conflict-resolution-artifact";

export type ConflictResolutionRunResult =
  | { status: "resolved"; artifactPath: string; files: string[] }
  | { status: "ambiguous"; artifactPath: string; message: string }
  | { status: "failed"; artifactPath?: string; message: string };

export interface RunConflictResolutionOnceOptions {
  executionProvider: ExecutionProvider;
  config: PourkitConfig;
  target: Target;
  issue: IssueData;
  branchName: string;
  worktreePath: string;
  repoRoot: string;
  conflictedPaths: string[];
  attempt: number;
  logger: PourkitLogger;
}

function loadConflictResolutionPrompt(
  repoRoot: string,
  promptTemplate: string,
  artifactPath: string
): string {
  const promptPath = resolvePromptTemplatePath(repoRoot, promptTemplate);
  const promptBody = existsSync(promptPath)
    ? readFileSync(promptPath, "utf-8")
    : promptTemplate;

  return `${promptBody}

## Shared Run Context

Read the selected issue requirements, comments, branch context, verification commands, and artifact paths from: ${RUN_CONTEXT_PATH_IN_WORKTREE}

## Output

Write your resolution to: ${artifactPath}

Do not provide a separate chat response. The runner only reads the file above.`;
}

export async function runConflictResolutionOnce(
  options: RunConflictResolutionOnceOptions
): Promise<ConflictResolutionRunResult> {
  const {
    executionProvider,
    config,
    target,
    issue,
    branchName,
    worktreePath,
    repoRoot,
    conflictedPaths,
    attempt,
    logger,
  } = options;

  const strategyCr = target.strategy.conflictResolution;
  if (!strategyCr) {
    return { status: "failed", message: "No conflictResolution configured" };
  }

  const artifactPath = `.pourkit/.tmp/conflict-resolution/attempt-${attempt}.md`;

  const prompt = loadConflictResolutionPrompt(
    repoRoot,
    strategyCr.promptTemplate,
    artifactPath
  );

  const runContextArtifact = buildRunContextArtifact({
    issue,
    target,
    branchName,
    sections: STAGE_SECTIONS.conflictResolution,
  });

  const executionResult = await executionProvider.execute({
    stage: "conflictResolution",
    agent: strategyCr.agent,
    model: strategyCr.model,
    prompt,
    target,
    repoRoot,
    branchName,
    sandbox: config.sandbox,
    autoApprove: true,
    worktreePath,
    artifactPath,
    artifacts: [runContextArtifact],
    logger,
  });

  if (!executionResult.success) {
    return {
      status: "failed",
      message:
        executionResult.error ?? "Conflict resolution agent execution failed",
    };
  }

  const fullArtifactPath = join(worktreePath, artifactPath);
  if (!existsSync(fullArtifactPath)) {
    return {
      status: "failed",
      artifactPath,
      message: "Conflict resolution agent completed but did not write artifact",
    };
  }

  let artifactContent: string;
  try {
    artifactContent = readFileSync(fullArtifactPath, "utf-8");
  } catch (error) {
    return {
      status: "failed",
      artifactPath,
      message: `Failed to read conflict resolution artifact: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let parsed;
  try {
    parsed = parseConflictResolutionArtifact(artifactContent);
  } catch (error) {
    if (error instanceof ConflictResolutionArtifactProtocolError) {
      return {
        status: "failed",
        artifactPath,
        message: `Invalid conflict resolution artifact: ${error.message}`,
      };
    }
    throw error;
  }

  if (parsed.status === "ambiguous") {
    return {
      status: "ambiguous",
      artifactPath,
      message: parsed.summary,
    };
  }

  return {
    status: "resolved",
    artifactPath,
    files: parsed.files,
  };
}

const CONFLICT_MARKER_PATTERN = /<<<<<<<|=======|>>>>>>>/m;

export async function hasUnresolvedConflictMarkers(
  worktreePath: string,
  files: string[]
): Promise<boolean> {
  for (const file of files) {
    const filePath = join(worktreePath, file);
    try {
      const content = readFileSync(filePath, "utf-8");
      if (CONFLICT_MARKER_PATTERN.test(content)) {
        return true;
      }
    } catch {
      // File not found or unreadable — skip
    }
  }
  return false;
}

export type ConflictResolutionLoopResult =
  | { status: "completed"; attempts: number }
  | { status: "ambiguous"; attempts: number; message: string }
  | { status: "failed"; attempts: number; message: string }
  | { status: "exhausted"; attempts: number; message: string };

export async function runConflictResolutionLoop(
  options: Omit<
    RunConflictResolutionOnceOptions,
    "conflictedPaths" | "attempt"
  > & {
    maxAttempts: number;
    initialConflictedPaths: string[];
  }
): Promise<ConflictResolutionLoopResult> {
  const { worktreePath, maxAttempts, logger, initialConflictedPaths } = options;
  let attempt = 0;
  let conflictedPaths = initialConflictedPaths;

  while (attempt < maxAttempts && conflictedPaths.length > 0) {
    attempt++;

    const crResult = await runConflictResolutionOnce({
      ...options,
      conflictedPaths,
      attempt,
    });

    if (crResult.status !== "resolved") {
      const message =
        crResult.status === "ambiguous"
          ? crResult.message
          : (crResult.message ?? "Conflict resolution agent execution failed");
      return { status: crResult.status, attempts: attempt, message };
    }

    const markersRemain = await hasUnresolvedConflictMarkers(
      worktreePath,
      conflictedPaths
    );
    if (markersRemain) {
      return {
        status: "ambiguous",
        attempts: attempt,
        message:
          "Conflict resolution agent resolved artifact but conflict markers remain in files",
      };
    }

    await execCapture("git", ["add", ...conflictedPaths], {
      cwd: worktreePath,
      logger,
      label: "git add conflicted paths",
    });

    try {
      await execCapture("git", ["rebase", "--continue"], {
        cwd: worktreePath,
        logger,
        label: "git rebase --continue",
      });
      conflictedPaths = [];
    } catch (error) {
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

      if (conflictedPaths.length === 0) {
        const rebaseErrorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          status: "failed",
          attempts: attempt,
          message: `git rebase --continue failed with no remaining conflicts: ${rebaseErrorMessage}`,
        };
      }
    }
  }

  if (conflictedPaths.length > 0) {
    return {
      status: "exhausted",
      attempts: attempt,
      message: `Conflict resolution maxAttempts (${maxAttempts}) exhausted with remaining conflicts`,
    };
  }

  return { status: "completed", attempts: attempt };
}
