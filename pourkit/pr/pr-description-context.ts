import { join } from "path";
import { readFile } from "node:fs/promises";
import { execCapture, type PourkitLogger } from "../shared/common";
import { RUN_CONTEXT_PATH_IN_WORKTREE } from "../shared/run-context";

export interface FinalizerContext {
  commits: string;
  reviewArtifact: string;
  targetBase: string;
  branchName: string;
}

export interface CollectContextOptions {
  targetBase: string;
  branchName: string;
  worktreePath: string;
  reviewArtifactPath?: string;
  logger: PourkitLogger;
}

export async function collectFinalizerContext(
  options: CollectContextOptions
): Promise<FinalizerContext> {
  const { targetBase, branchName, worktreePath, reviewArtifactPath, logger } =
    options;

  const commits = await collectCommitRange(
    targetBase,
    branchName,
    worktreePath,
    logger
  );
  const reviewArtifact = reviewArtifactPath
    ? await readReviewArtifact(reviewArtifactPath)
    : "(no review artifact provided)";

  return {
    commits,
    reviewArtifact,
    targetBase,
    branchName,
  };
}

async function collectCommitRange(
  targetBase: string,
  branchName: string,
  worktreePath: string,
  logger: PourkitLogger
): Promise<string> {
  const result = await execCapture(
    "git",
    [
      "log",
      `${remoteTargetBase(targetBase)}..${branchName}`,
      "--oneline",
      "--no-decorate",
    ],
    { cwd: worktreePath, logger, label: "git log" }
  );

  const commits = result.stdout.trim();
  if (!commits) {
    logger.step(
      "warn",
      `No commits found between ${targetBase} and ${branchName}, proceeding with empty commit range`
    );
  }
  return commits;
}

function remoteTargetBase(targetBase: string): string {
  return targetBase.includes("/") ? targetBase : `origin/${targetBase}`;
}

async function readReviewArtifact(artifactPath: string): Promise<string> {
  let content: string;
  try {
    content = await readFile(artifactPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Review artifact not found at ${artifactPath}. Ensure the review stage completed before running finalizer generation.`
      );
    }
    throw error;
  }

  if (!content.trim()) {
    throw new Error(
      `Review artifact at ${artifactPath} is empty. Ensure the review stage produced output before running finalizer generation.`
    );
  }

  return content;
}

export function buildFinalizerPrompt(
  context: FinalizerContext,
  promptTemplate: string
): string {
  const artifactPathInWorktree = join(
    ".pourkit",
    ".tmp",
    "finalizer",
    "agent-output.md"
  );

  return `${promptTemplate}

## Shared Run Context

Read the selected issue requirements, branch context, validation commands, and artifact paths from: ${RUN_CONTEXT_PATH_IN_WORKTREE}

## Branch Context

**Target Base**: ${context.targetBase}
**Branch**: ${context.branchName}

## Commits

${context.commits || "(no commits in range)"}

## Review Artifact

${context.reviewArtifact}

## Output

Generate a PR title and body that accurately summarize the changes for this issue.
Format your output with "## PR Title" and "## PR Body" sections.

Inside "## PR Body", use the following canonical structure:

## Summary

- Why this branch exists.
- What outcome this branch delivers.

## Changes

- Final net change 1.
- Final net change 2.

Rules:
- Use bullet points only inside both inner sections (no prose paragraphs or commit lists).
- Use final-state wording (describe what the code does after this PR, not what changed during development).
- Do not include commit chronology or a list of commit messages.
- Closing policy: For Issue-backed runs, publish exactly one closing reference for the current Issue (e.g. "Closes #123"). Never close parent PRDs, sibling Issues, or unrelated Issues. Omit the closing footer when no Issue is attached.

Write your finalizer output to: ${artifactPathInWorktree}`;
}
