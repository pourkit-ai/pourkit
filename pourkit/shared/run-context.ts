import type { PourkitStage } from "../execution/execution-provider";
import { getVerificationCommands, type IssueData, type Target } from "./config";

export const RUN_CONTEXT_PATH_IN_WORKTREE = ".pourkit/.tmp/run-context.md";

export type RunContextSection =
  | "issue"
  | "comments"
  | "branch"
  | "verification-commands"
  | "review-criteria"
  | "artifacts";

export const ALL_RUN_CONTEXT_SECTIONS: RunContextSection[] = [
  "issue",
  "comments",
  "branch",
  "verification-commands",
  "review-criteria",
  "artifacts",
];

export const STAGE_SECTIONS: Record<PourkitStage, RunContextSection[]> = {
  builder: [
    "issue",
    "comments",
    "branch",
    "verification-commands",
    "artifacts",
  ],
  reviewer: [
    "issue",
    "comments",
    "branch",
    "verification-commands",
    "review-criteria",
    "artifacts",
  ],
  refactor: [
    "issue",
    "comments",
    "branch",
    "verification-commands",
    "review-criteria",
    "artifacts",
  ],
  finalizer: [
    "issue",
    "comments",
    "branch",
    "verification-commands",
    "review-criteria",
    "artifacts",
  ],
  conflictResolution: [
    "issue",
    "comments",
    "branch",
    "verification-commands",
    "artifacts",
  ],
};

export interface RunContextOptions {
  issue: IssueData;
  target: Target;
  branchName: string;
  reviewerCriteria?: string[];
  sections?: RunContextSection[];
}

export interface ExecutionArtifact {
  path: string;
  content: string;
}

export function buildRunContextArtifact(
  options: RunContextOptions
): ExecutionArtifact {
  return {
    path: RUN_CONTEXT_PATH_IN_WORKTREE,
    content: buildRunContextMarkdown(options),
  };
}

export function buildRunContextMarkdown(options: RunContextOptions): string {
  const {
    issue,
    target,
    branchName,
    reviewerCriteria = [],
    sections = ALL_RUN_CONTEXT_SECTIONS,
  } = options;

  const parts: string[] = ["# Pourkit Run Context", ""];

  if (sections.includes("issue")) {
    parts.push(
      "## Issue",
      "",
      `- Number: #${issue.number}`,
      `- Title: ${issue.title}`,
      "",
      "### Body",
      "",
      issue.body.trim() || "(empty issue body)",
      ""
    );
  }

  if (sections.includes("comments")) {
    parts.push("## Comments", "");

    if (issue.comments.length === 0) {
      parts.push("(none)", "");
    } else {
      parts.push(
        ...issue.comments.flatMap((comment, index) => [
          `### Comment ${index + 1}`,
          "",
          comment.trim() || "(empty comment)",
          "",
        ])
      );
    }
  }

  if (sections.includes("branch")) {
    parts.push(
      "## Branch",
      "",
      `- Base: ${target.baseBranch}`,
      `- Working Branch: ${branchName}`,
      ""
    );
  }

  if (sections.includes("verification-commands")) {
    parts.push(
      ...renderCommandList(
        getVerificationCommands(target),
        "Verification Commands"
      )
    );
  }

  if (sections.includes("review-criteria")) {
    parts.push(...renderCriteria(reviewerCriteria));
  }

  if (sections.includes("artifacts")) {
    parts.push(
      "## Artifacts",
      "",
      "- Shared run context: `.pourkit/.tmp/run-context.md`",
      "- Reviewer outputs dir: `.pourkit/.tmp/reviewers/`",
      "- Refactor outputs dir: `.pourkit/.tmp/refactors/`",
      "- Finalizer output: `.pourkit/.tmp/finalizer/agent-output.md`",
      ""
    );
  }

  return parts.join("\n");
}

function renderCommandList(
  commands: ReturnType<typeof getVerificationCommands>,
  heading: string
) {
  if (commands.length === 0) {
    return [`## ${heading}`, "", "(none)", ""];
  }

  return [
    `## ${heading}`,
    "",
    "Run these commands from the repository root exactly as written. Do not substitute equivalent scripts from nested package.json files.",
    "",
    ...commands.map((command) => `- ${command.label}: \`${command.command}\``),
    "",
  ];
}

function renderCriteria(criteria: string[]) {
  if (criteria.length === 0) {
    return [];
  }

  return [
    "## Review Criteria",
    "",
    ...criteria.map((criterion) => `- ${criterion}`),
    "",
  ];
}
