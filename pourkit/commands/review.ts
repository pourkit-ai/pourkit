import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import {
  type IssueData,
  type PourkitConfig,
  type Target,
  resolvePromptTemplatePath,
} from "../shared/config";
import type { ExecutionProvider } from "../execution/execution-provider";
import {
  parseReviewVerdict,
  type ReviewVerdict,
  ReviewVerdictProtocolError,
} from "../pr/review-verdict";
import { type PourkitLogger } from "../shared/common";
import {
  RUN_CONTEXT_PATH_IN_WORKTREE,
  buildRunContextArtifact,
  STAGE_SECTIONS,
} from "../shared/run-context";
import { appendProtectedWorkGuidance } from "../shared/prompt-guidance";
import type { SerenaExecutionContext } from "../execution/opencode-config";

export interface ReviewResult {
  verdict: ReviewVerdict;
  output: string;
  artifactPath: string;
}

export interface RunReviewOptions {
  executionProvider: ExecutionProvider;
  config: PourkitConfig;
  target: Target;
  issue: IssueData;
  builderBranch: string;
  worktreePath: string;
  repoRoot: string;
  logger: PourkitLogger;
  iteration?: number;
  reviewHistory?: string[];
  priorRefactorArtifacts?: string;
  humanHandoffResolved?: boolean;
  priorReviewerArtifacts?: string;
}

export class ReviewArtifactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewArtifactValidationError";
  }
}

export class RefactorArtifactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefactorArtifactValidationError";
  }
}

const ALLOWED_REFACTOR_CLASSIFICATIONS = [
  "accepted",
  "rejected",
  "deferred",
  "blocked",
];

function normalizeRefactorClassification(raw: string): string {
  const match = raw.match(/^`(accepted|rejected|deferred|blocked)`$/);
  return match?.[1] ?? raw;
}

export function extractLatestFindingIds(
  reviewOutput: string,
  iteration: number
): string[] {
  const findingsSection =
    reviewOutput.split("## Findings")[1]?.split("##")[0] ?? "";
  const currentIterationIdRegex = new RegExp(`^R${iteration}\\.F\\d+$`);
  const ids: string[] = [];

  const rows = findingsSection.split("\n");
  let isHeaderRow = true;
  for (const row of rows) {
    const trimmed = row.trim();
    if (!trimmed.startsWith("|")) continue;
    if (/^\|[\s-:|]+$/.test(trimmed)) {
      isHeaderRow = false;
      continue;
    }
    if (isHeaderRow) {
      isHeaderRow = false;
      continue;
    }
    const cells = trimmed
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c !== "");
    if (cells.length === 0) continue;
    if (cells[0].toLowerCase() === "none" || cells[0].toLowerCase() === "n/a")
      continue;
    if (currentIterationIdRegex.test(cells[0])) {
      ids.push(cells[0]);
    }
  }

  return ids;
}

export function validateRefactorArtifact(
  artifactPath: string,
  findingIds: string[]
): void {
  if (!existsSync(artifactPath)) {
    throw new RefactorArtifactValidationError(
      `Refactor artifact missing at ${artifactPath}`
    );
  }

  const content = readFileSync(artifactPath, "utf-8");

  if (!content.trim()) {
    throw new RefactorArtifactValidationError("Refactor artifact is empty");
  }

  const requiredSections = [
    "## Finding Responses",
    "## Verification",
    "## Open Blockers",
  ];
  for (const section of requiredSections) {
    const sectionRegex = new RegExp(`^${section}\\s*$`, "m");
    if (!sectionRegex.test(content)) {
      throw new RefactorArtifactValidationError(
        `Refactor artifact missing required section: ${section}`
      );
    }
  }

  if (findingIds.length === 0) return;

  const findingResponsesSection =
    content.split("## Finding Responses")[1]?.split("##")[0] ?? "";

  for (const findingId of findingIds) {
    const rows = findingResponsesSection.split("\n");
    let found = false;
    for (const row of rows) {
      const trimmed = row.trim();
      if (!trimmed.startsWith("|")) continue;
      if (/^\|[\s-:|]+$/.test(trimmed)) continue;

      const cells = trimmed
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c !== "");
      if (cells.length < 2) continue;

      if (cells[0] === findingId) {
        const classification = normalizeRefactorClassification(cells[1]);
        if (!ALLOWED_REFACTOR_CLASSIFICATIONS.includes(classification)) {
          throw new RefactorArtifactValidationError(
            `Invalid classification for finding ${findingId}: "${cells[1]}". Allowed: ${ALLOWED_REFACTOR_CLASSIFICATIONS.join(", ")}`
          );
        }
        found = true;
        break;
      }
    }

    if (!found) {
      throw new RefactorArtifactValidationError(
        `Refactor artifact missing response for finding: ${findingId}`
      );
    }
  }
}

export function validateReviewArtifact(
  output: string,
  verdict: ReviewVerdict,
  iteration: number,
  priorRefactorArtifactsProvided: boolean = false
): void {
  if (!output.includes("## Findings")) {
    throw new ReviewArtifactValidationError(
      "Reviewer output must include a ## Findings section"
    );
  }

  const findingsSection = output.split("## Findings")[1]?.split("##")[0] ?? "";

  if (!findingsSection.trim()) {
    throw new ReviewArtifactValidationError(
      "Findings section must contain a table with ID and Supersedes columns"
    );
  }

  const hasIdColumn = /^\|?\s*ID\s+\|/m.test(findingsSection);
  if (!hasIdColumn) {
    throw new ReviewArtifactValidationError(
      "Findings table must include an ID column"
    );
  }

  const hasSupersedesColumn = /^\|?\s*ID\s+\|\s*Supersedes\s+\|/m.test(
    findingsSection
  );
  if (!hasSupersedesColumn) {
    throw new ReviewArtifactValidationError(
      "Findings table must include a Supersedes column"
    );
  }

  const findingIdRegex = /^R\d+\.F\d+$/;
  const currentIterationIdRegex = new RegExp(`^R${iteration}\\.F\\d+$`);
  const supersedesIdRegex = /^R\d+\.F\d+$/;
  const rows = findingsSection.split("\n");
  let isHeaderRow = true;
  for (const row of rows) {
    const trimmed = row.trim();
    if (!trimmed.startsWith("|")) continue;
    if (/^\|[\s-:|]+$/.test(trimmed)) {
      isHeaderRow = false;
      continue;
    }
    if (isHeaderRow) {
      isHeaderRow = false;
      continue;
    }
    const cells = trimmed
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c !== "");
    if (cells.length === 0) continue;
    if (cells[0].toLowerCase() === "none" || cells[0].toLowerCase() === "n/a")
      continue;
    const idCell = cells[0];
    if (!currentIterationIdRegex.test(idCell)) {
      throw new ReviewArtifactValidationError(
        `Finding ID must match R${iteration}.F{number} format for iteration ${iteration}`
      );
    }
    const supersedesCell = cells[1];
    if (
      supersedesCell !== "-" &&
      supersedesCell !== "n/a" &&
      !supersedesIdRegex.test(supersedesCell)
    ) {
      throw new ReviewArtifactValidationError(
        `Supersedes must be a hyphen for new findings or a valid finding ID, got: ${supersedesCell}`
      );
    }
  }

  if (verdict === "NEEDS_HUMAN") {
    if (!output.includes("## Human Handoff Summary")) {
      throw new ReviewArtifactValidationError(
        "NEEDS_HUMAN verdict requires a Human Handoff Summary section"
      );
    }
    if (!output.includes("## Human Handoff Reason")) {
      throw new ReviewArtifactValidationError(
        "NEEDS_HUMAN verdict requires a Human Handoff Reason section"
      );
    }
  }

  if (priorRefactorArtifactsProvided) {
    if (!output.includes("## Prior Refactor Response Assessment")) {
      throw new ReviewArtifactValidationError(
        "Prior Refactor Artifacts were provided but the review is missing a ## Prior Refactor Response Assessment section"
      );
    }
  }
}

export async function runReviewCommand(
  options: RunReviewOptions
): Promise<ReviewResult> {
  const {
    executionProvider,
    config,
    target,
    issue,
    builderBranch,
    worktreePath,
    repoRoot,
    logger,
    iteration,
    reviewHistory,
    priorRefactorArtifacts,
    humanHandoffResolved,
    priorReviewerArtifacts,
  } = options;

  const reviewer = target.strategy.review.reviewer;
  if (!reviewer) {
    throw new Error("No reviewer config found");
  }

  const artifactPathInWorktree = join(
    ".pourkit",
    ".tmp",
    "reviewers",
    `iteration-${iteration ?? 1}.md`
  );
  const artifactPath = join(worktreePath, artifactPathInWorktree);

  prepareReviewArtifactPath(artifactPath);

  const prompt = buildReviewerPrompt(
    repoRoot,
    reviewer.promptTemplate,
    reviewer.criteria,
    artifactPathInWorktree,
    iteration ?? 1,
    reviewHistory,
    priorRefactorArtifacts,
    humanHandoffResolved,
    priorReviewerArtifacts
  );

  logger.step("info", "Running reviewer");

  const executionResult = await executionProvider.execute({
    stage: "reviewer",
    iteration,
    agent: reviewer.agent,
    model: reviewer.model,
    prompt,
    target,
    repoRoot,
    branchName: builderBranch,
    sandbox: config.sandbox,
    autoApprove: true,
    artifactPath: artifactPathInWorktree,
    worktreePath,
    artifacts: [
      buildRunContextArtifact({
        issue,
        target,
        branchName: builderBranch,
        reviewerCriteria: reviewer.criteria,
        sections: STAGE_SECTIONS.reviewer,
      }),
    ],
    logger,
  });

  if (!executionResult.success) {
    throw new Error(`Reviewer execution failed: ${executionResult.error}`);
  }

  const output = readReviewArtifact(artifactPath, executionResult.logPath);

  let verdict: ReviewVerdict;

  try {
    verdict = parseReviewVerdict(output);
  } catch (error) {
    if (error instanceof ReviewVerdictProtocolError) {
      throw new Error(`Review protocol error: ${error.message}`);
    }
    throw error;
  }

  logger.step("info", `Review verdict: ${verdict}`);

  validateReviewArtifact(
    output,
    verdict,
    iteration ?? 1,
    !!priorRefactorArtifacts
  );

  return { verdict, output, artifactPath };
}

function buildReviewerPrompt(
  repoRoot: string,
  promptTemplate: string,
  criteria: string[],
  artifactPathInWorktree: string,
  iteration: number,
  reviewHistory: string[] = [],
  priorRefactorArtifacts?: string,
  humanHandoffResolved?: boolean,
  priorReviewerArtifacts?: string
): string {
  const criteriaBlock = renderReviewCriteria(repoRoot, criteria);
  const { content: renderedTemplate, hasCriteriaPlaceholder } =
    loadReviewerPromptTemplate(repoRoot, promptTemplate, criteriaBlock);
  const priorRefactorBlock = priorRefactorArtifacts
    ? `${priorRefactorArtifacts}`
    : "";
  const priorReviewerBlock = priorReviewerArtifacts
    ? `${priorReviewerArtifacts}`
    : "";
  const humanHandoffBoundary = humanHandoffResolved
    ? `## Human-Resolved Handoff Boundary

A prior review emitted \`NEEDS_HUMAN\` and stopped the agent loop. The issue has since been moved back to \`ready-for-agent\`.

Before carrying forward old blockers, inspect newer issue comments and the current worktree. Treat prior Reviewer and Refactor Artifacts as historical context, not active findings unless they still apply.

`
    : "";
  return `${renderedTemplate}

## Shared Run Context

Read the selected issue requirements, branch context, validation commands, and artifact paths from: ${RUN_CONTEXT_PATH_IN_WORKTREE}

${
  hasCriteriaPlaceholder
    ? ""
    : `## Review Criteria

${criteriaBlock}

`
}${humanHandoffBoundary}${priorReviewerBlock}${renderReviewHistory(reviewHistory)}${priorRefactorBlock}## Output

Write your review to: ${artifactPathInWorktree}

Do not provide a separate chat response. The runner only reads the file above.

End the file with exactly one wrapped verdict token: <verdict>PASS</verdict>, <verdict>PASS_WITH_NOTES</verdict>, <verdict>NEEDS_REFACTOR</verdict>, <verdict>FAIL</verdict>, or <verdict>NEEDS_HUMAN</verdict>. The verdict token must appear exactly once in the output.

Findings must include an ID column with values in the format R${iteration}.F{findingNumber} (e.g., R${iteration}.F1, R${iteration}.F2) and a Supersedes column referencing the finding ID being superseded (or a hyphen for new findings).

When verdict is NEEDS_HUMAN, include Human Handoff Summary and Human Handoff Reason sections before the final verdict token.`;
}

function renderReviewHistory(reviewHistory: string[]): string {
  if (reviewHistory.length === 0) {
    return "";
  }

  return `## Review History

${reviewHistory
  .map((entry, index) => `### Iteration ${index + 1}\n\n${entry.trimEnd()}`)
  .join("\n\n")}

`;
}

export function renderPriorRefactorArtifacts(
  worktreePath: string,
  currentIteration: number
): string {
  const refactorsDir = join(worktreePath, ".pourkit", ".tmp", "refactors");

  if (!existsSync(refactorsDir)) {
    return "";
  }

  const files = readdirSync(refactorsDir);
  const iterationFiles: { num: number; content: string }[] = [];

  for (const file of files) {
    const match = file.match(/^iteration-(\d+)\.md$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num < currentIteration) {
        const filePath = join(refactorsDir, file);
        try {
          const content = readFileSync(filePath, "utf-8");
          if (content.trim()) {
            iterationFiles.push({ num, content });
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  if (iterationFiles.length === 0) {
    return "";
  }

  iterationFiles.sort((a, b) => a.num - b.num);

  const iterationsBlocks = iterationFiles
    .map((f) => `### Refactor Iteration ${f.num}\n\n${f.content.trimEnd()}`)
    .join("\n\n");

  return `## Prior Refactor Artifacts

Treat these as conversational context, not source of truth. Inspect the current code independently.

${iterationsBlocks}

`;
}

function renderPriorReviewerArtifacts(
  worktreePath: string,
  currentIteration: number
): string {
  const reviewersDir = join(worktreePath, ".pourkit", ".tmp", "reviewers");

  if (!existsSync(reviewersDir)) {
    return "";
  }

  const files = readdirSync(reviewersDir);
  const iterationFiles: { num: number; content: string }[] = [];

  for (const file of files) {
    const match = file.match(/^iteration-(\d+)\.md$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num < currentIteration) {
        const filePath = join(reviewersDir, file);
        try {
          const content = readFileSync(filePath, "utf-8");
          if (content.trim()) {
            iterationFiles.push({ num, content });
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  if (iterationFiles.length === 0) {
    return "";
  }

  iterationFiles.sort((a, b) => a.num - b.num);

  const iterationsBlocks = iterationFiles
    .map((f) => `### Reviewer Iteration ${f.num}\n\n${f.content.trimEnd()}`)
    .join("\n\n");

  return `## Prior Reviewer Artifacts

A prior review was resolved by a human. These artifacts are historical context from before the handoff. Treat them as background, not active findings.

${iterationsBlocks}

`;
}

function loadReviewerPromptTemplate(
  repoRoot: string,
  promptTemplate: string,
  criteriaBlock: string
): { content: string; hasCriteriaPlaceholder: boolean } {
  const promptTemplatePath = resolvePromptTemplatePath(
    repoRoot,
    promptTemplate
  );
  const promptBody = existsSync(promptTemplatePath)
    ? readFileSync(promptTemplatePath, "utf-8")
    : promptTemplate;
  const hasCriteriaPlaceholder = promptBody.includes("{{REVIEW_CRITERIA}}");

  return {
    content: promptBody.replace(/\{\{REVIEW_CRITERIA\}\}/g, criteriaBlock),
    hasCriteriaPlaceholder,
  };
}

function renderReviewCriteria(repoRoot: string, criteria: string[]): string {
  return criteria
    .map((criterion) => {
      const snippetPath = join(
        repoRoot,
        ".pourkit",
        "prompts",
        `reviewer-${criterion}.snippet.md`
      );

      if (existsSync(snippetPath)) {
        return readFileSync(snippetPath, "utf-8").trimEnd();
      }

      return `- ${criterion}`;
    })
    .join("\n\n");
}

function prepareReviewArtifactPath(artifactPath: string) {
  mkdirSync(dirname(artifactPath), { recursive: true });
  if (existsSync(artifactPath)) {
    rmSync(artifactPath);
  }
}

function recoverReviewOutputFromLog(logPath: string): string | null {
  if (!existsSync(logPath)) {
    return null;
  }

  const logContent = readFileSync(logPath, "utf-8");
  const startIndex = logContent.indexOf("## Findings");

  if (startIndex === -1) {
    return null;
  }

  const verdictMatch = logContent
    .slice(startIndex)
    .match(
      /<verdict>(PASS|PASS_WITH_NOTES|NEEDS_REFACTOR|FAIL|NEEDS_HUMAN)<\/verdict>/
    );

  if (!verdictMatch || verdictMatch.index === undefined) {
    return null;
  }

  const recoveredOutput = logContent
    .slice(startIndex, startIndex + verdictMatch.index + verdictMatch[0].length)
    .trim();

  return recoveredOutput.length > 0 ? recoveredOutput : null;
}

function readReviewArtifact(
  artifactPath: string,
  logPath?: string | null
): string {
  if (existsSync(artifactPath)) {
    const output = readFileSync(artifactPath, "utf-8");
    if (output.trim()) {
      return output;
    }
  }

  const recoveredOutput = logPath ? recoverReviewOutputFromLog(logPath) : null;

  if (recoveredOutput) {
    writeFileSync(artifactPath, recoveredOutput, "utf-8");
    return recoveredOutput;
  }

  if (!existsSync(artifactPath)) {
    throw new Error(`Reviewer did not produce output at ${artifactPath}`);
  }

  throw new Error(`Reviewer produced empty output at ${artifactPath}`);
}

export type ReviewLoopVerdict =
  | "PASS"
  | "PASS_WITH_NOTES"
  | "FAIL"
  | "NEEDS_HUMAN";

export interface ReviewLoopResult {
  verdict: ReviewLoopVerdict;
  output: string;
  artifactPath: string;
  iterations: number;
  exhaustedMaxIterations: boolean;
  lifetimeIterations: number;
  refactorCompletedForLastReview: boolean;
  refactorArtifactPaths?: string[];
}

export interface RunReviewLoopOptions {
  executionProvider: ExecutionProvider;
  config: PourkitConfig;
  target: Target;
  issue: IssueData;
  builderBranch: string;
  worktreePath: string;
  repoRoot: string;
  logger: PourkitLogger;
  startingLifetimeIteration?: number;
  humanHandoffResolved?: boolean;
  serena?: SerenaExecutionContext;
  onRefactorProgress?: (progress: {
    lifetimeIterations: number;
    lastVerdict: ReviewVerdict;
    lastArtifactPath: string;
    refactorArtifactPath?: string;
  }) => void | Promise<void>;
}

export async function runReviewWithRefactorLoop(
  options: RunReviewLoopOptions
): Promise<ReviewLoopResult> {
  const {
    executionProvider,
    config,
    target,
    issue,
    builderBranch,
    worktreePath,
    repoRoot,
    logger,
    startingLifetimeIteration = 0,
    humanHandoffResolved,
    serena,
  } = options;

  const strategy = target.strategy;
  const reviewer = strategy.review.reviewer;
  if (!reviewer) {
    throw new Error("No reviewer config found");
  }
  const refactorer = strategy.review.refactor;
  if (!refactorer) {
    throw new Error("No refactorer config found");
  }
  const maxIterations = strategy.review.maxIterations;
  const passWithNotesRefactorAttempts =
    strategy.review.passWithNotesRefactorAttempts;
  let resolvedStartingIteration = startingLifetimeIteration;
  {
    const reviewersDir = join(worktreePath, ".pourkit", ".tmp", "reviewers");
    try {
      const files = readdirSync(reviewersDir);
      let maxExistingIteration = 0;
      for (const file of files) {
        const match = file.match(/^iteration-(\d+)\.md$/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxExistingIteration) {
            maxExistingIteration = num;
          }
        }
      }
      if (maxExistingIteration > resolvedStartingIteration) {
        resolvedStartingIteration = maxExistingIteration;
      }
    } catch {
      // Directory may not exist yet
    }
  }

  const accumulatedRefactorPaths: string[] = [];
  let iteration = 0;
  let lastResult: ReviewResult | null = null;
  const reviewHistory: string[] = [];
  let passWithNotesRefactorAttemptsRemaining = passWithNotesRefactorAttempts;
  const priorReviewerArtifacts = humanHandoffResolved
    ? renderPriorReviewerArtifacts(
        worktreePath,
        resolvedStartingIteration + 1
      ) || undefined
    : undefined;

  while (iteration < maxIterations) {
    iteration++;
    const lifetimeIteration = resolvedStartingIteration + iteration;
    logger.step("info", `Review iteration ${lifetimeIteration}`);

    const priorRefactorArtifacts = renderPriorRefactorArtifacts(
      worktreePath,
      lifetimeIteration
    );

    const reviewResult = await runReviewCommand({
      executionProvider,
      config,
      target,
      issue,
      builderBranch,
      worktreePath,
      repoRoot,
      logger,
      iteration: lifetimeIteration,
      priorRefactorArtifacts: priorRefactorArtifacts || undefined,
      humanHandoffResolved,
      priorReviewerArtifacts,
      reviewHistory:
        reviewer.includeReviewHistory && reviewHistory.length > 0
          ? [...reviewHistory]
          : undefined,
    });

    lastResult = reviewResult;
    reviewHistory.push(reviewResult.output);

    await persistIterationArtifact(
      worktreePath,
      reviewResult.output,
      lifetimeIteration
    );

    if (reviewResult.verdict === "PASS") {
      return {
        verdict: reviewResult.verdict,
        output: reviewResult.output,
        artifactPath: reviewResult.artifactPath,
        iterations: iteration,
        lifetimeIterations: lifetimeIteration,
        exhaustedMaxIterations: false,
        refactorCompletedForLastReview: false,
        refactorArtifactPaths:
          accumulatedRefactorPaths.length > 0
            ? accumulatedRefactorPaths
            : undefined,
      };
    }

    if (
      reviewResult.verdict === "PASS_WITH_NOTES" &&
      passWithNotesRefactorAttemptsRemaining === 0
    ) {
      logger.step(
        "info",
        "PASS_WITH_NOTES refactor attempts exhausted, treating as PASS"
      );
      return {
        verdict: "PASS",
        output: reviewResult.output,
        artifactPath: reviewResult.artifactPath,
        iterations: iteration,
        lifetimeIterations: lifetimeIteration,
        exhaustedMaxIterations: false,
        refactorCompletedForLastReview: false,
        refactorArtifactPaths:
          accumulatedRefactorPaths.length > 0
            ? accumulatedRefactorPaths
            : undefined,
      };
    }

    if (reviewResult.verdict === "PASS_WITH_NOTES") {
      passWithNotesRefactorAttemptsRemaining--;
      logger.step(
        "info",
        `PASS_WITH_NOTES refactor attempts remaining: ${passWithNotesRefactorAttemptsRemaining}`
      );
    }

    if (reviewResult.verdict === "NEEDS_HUMAN") {
      logger.step("info", "NEEDS_HUMAN verdict, stopping review loop");
      return {
        verdict: "NEEDS_HUMAN",
        output: reviewResult.output,
        artifactPath: reviewResult.artifactPath,
        iterations: iteration,
        lifetimeIterations: lifetimeIteration,
        exhaustedMaxIterations: false,
        refactorCompletedForLastReview: false,
        refactorArtifactPaths:
          accumulatedRefactorPaths.length > 0
            ? accumulatedRefactorPaths
            : undefined,
      };
    }

    if (
      reviewResult.verdict === "NEEDS_REFACTOR" ||
      reviewResult.verdict === "PASS_WITH_NOTES" ||
      reviewResult.verdict === "FAIL"
    ) {
      logger.step("info", "Running refactor agent");
      const refactorArtifactPathInWorktree = join(
        ".pourkit",
        ".tmp",
        "refactors",
        `iteration-${lifetimeIteration}.md`
      );

      const refactorPrompt = buildRefactorPrompt(
        repoRoot,
        refactorer.promptTemplate,
        reviewResult.output,
        refactorArtifactPathInWorktree
      );

      const refactorResult = await executionProvider.execute({
        stage: "refactor",
        iteration: lifetimeIteration,
        agent: refactorer.agent,
        model: refactorer.model,
        prompt: refactorPrompt,
        target,
        repoRoot,
        branchName: builderBranch,
        sandbox: config.sandbox,
        autoApprove: true,
        artifactPath: refactorArtifactPathInWorktree,
        worktreePath,
        artifacts: [
          buildRunContextArtifact({
            issue,
            target,
            branchName: builderBranch,
            reviewerCriteria: reviewer.criteria,
            sections: STAGE_SECTIONS.refactor,
          }),
        ],
        ...(serena ? { serena } : {}),
        logger,
      });

      if (!refactorResult.success) {
        logger.step(
          "warn",
          "Refactor execution failed, transitioning to ready-for-human"
        );
        return {
          verdict: "FAIL",
          output: reviewResult.output,
          artifactPath: reviewResult.artifactPath,
          iterations: iteration,
          lifetimeIterations: resolvedStartingIteration + iteration,
          exhaustedMaxIterations: false,
          refactorCompletedForLastReview: false,
          refactorArtifactPaths:
            accumulatedRefactorPaths.length > 0
              ? accumulatedRefactorPaths
              : undefined,
        };
      }

      const latestFindingIds = extractLatestFindingIds(
        reviewResult.output,
        lifetimeIteration
      );
      const refactorArtifactPath = join(
        worktreePath,
        refactorArtifactPathInWorktree
      );
      try {
        validateRefactorArtifact(refactorArtifactPath, latestFindingIds);
      } catch (error) {
        if (error instanceof RefactorArtifactValidationError) {
          logger.step(
            "warn",
            `Refactor artifact validation failed: ${error.message}`
          );
          return {
            verdict: "FAIL",
            output: reviewResult.output,
            artifactPath: reviewResult.artifactPath,
            iterations: iteration,
            lifetimeIterations: resolvedStartingIteration + iteration,
            exhaustedMaxIterations: false,
            refactorCompletedForLastReview: false,
            refactorArtifactPaths:
              accumulatedRefactorPaths.length > 0
                ? accumulatedRefactorPaths
                : undefined,
          };
        }
        throw error;
      }

      accumulatedRefactorPaths.push(refactorArtifactPath);
      if (options.onRefactorProgress) {
        await options.onRefactorProgress({
          lifetimeIterations: resolvedStartingIteration + iteration,
          lastVerdict: reviewResult.verdict,
          lastArtifactPath: reviewResult.artifactPath,
          refactorArtifactPath,
        });
      }
    }
  }

  logger.step("warn", `Max review iterations (${maxIterations}) exhausted`);

  return {
    verdict: "FAIL",
    output: lastResult?.output ?? "",
    artifactPath: lastResult?.artifactPath ?? "",
    iterations: iteration,
    lifetimeIterations: resolvedStartingIteration + iteration,
    exhaustedMaxIterations: true,
    refactorCompletedForLastReview: true,
    refactorArtifactPaths:
      accumulatedRefactorPaths.length > 0
        ? accumulatedRefactorPaths
        : undefined,
  };
}

async function writeArtifact(
  worktreePath: string,
  filename: string,
  output: string
) {
  try {
    const dir = join(worktreePath, ".pourkit", ".tmp", "reviewers");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), output, "utf-8");
  } catch {
    // Do not fail pipeline on artifact write errors
  }
}

async function persistIterationArtifact(
  worktreePath: string,
  output: string,
  iteration: number
) {
  await writeArtifact(worktreePath, `iteration-${iteration}.md`, output);
}

function buildRefactorPrompt(
  repoRoot: string,
  promptTemplate: string,
  latestReview: string,
  artifactPathInWorktree: string
): string {
  const promptTemplatePath = resolvePromptTemplatePath(
    repoRoot,
    promptTemplate
  );
  const promptBody = existsSync(promptTemplatePath)
    ? readFileSync(promptTemplatePath, "utf-8")
    : promptTemplate;

  return appendProtectedWorkGuidance(`${promptBody}

## Shared Run Context

Read the selected issue requirements, branch context, validation commands, and artifact paths from: ${RUN_CONTEXT_PATH_IN_WORKTREE}

## Latest Review

${latestReview.trimEnd()}

## Output

Write your refactor artifact to: ${artifactPathInWorktree}

When you are done, finish with <promise>COMPLETE</promise>.`);
}
