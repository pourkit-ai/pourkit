import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { IssueData, PourkitConfig, Target } from "../shared/config";
import { resolvePromptTemplatePath } from "../shared/config";
import type { ExecutionProvider } from "../execution/execution-provider";
import {
  ensureConventionalPrTitle,
  parsePrDescription,
  PrDescriptionProtocolError,
} from "../pr/pr-description";
import {
  collectFinalizerContext,
  buildFinalizerPrompt,
} from "../pr/pr-description-context";
import type { PourkitLogger } from "../shared/common";
import { buildRunContextArtifact, STAGE_SECTIONS } from "../shared/run-context";

export interface RunFinalizerOptions {
  executionProvider: ExecutionProvider;
  config: PourkitConfig;
  target: Target;
  issue: IssueData;
  builderBranch: string;
  worktreePath: string;
  reviewArtifactPath?: string;
  repoRoot: string;
  logger: PourkitLogger;
}

export interface RunFinalizerResult {
  title: string;
  body: string;
  artifactPath: string;
}

export async function runFinalizerAgent(
  options: RunFinalizerOptions
): Promise<RunFinalizerResult> {
  const {
    executionProvider,
    config,
    target,
    issue,
    builderBranch,
    worktreePath,
    reviewArtifactPath,
    repoRoot,
    logger,
  } = options;

  const strategy = target.strategy;
  const finalizer = strategy.finalize.prDescriptionAgent;

  const context = await collectFinalizerContext({
    targetBase: target.baseBranch,
    branchName: builderBranch,
    worktreePath,
    reviewArtifactPath,
    logger,
  });

  const resolvedPrompt = loadFinalizerPrompt(
    repoRoot,
    finalizer.promptTemplate
  );

  const prompt = buildFinalizerPrompt(context, resolvedPrompt);

  const artifactPathInWorktree = join(
    ".pourkit",
    ".tmp",
    "finalizer",
    "agent-output.md"
  );
  const artifactPath = join(worktreePath, artifactPathInWorktree);

  prepareArtifactPath(artifactPath);

  let output = "";
  let parsed: ReturnType<typeof parsePrDescription> | undefined;
  let lastValidationError: Error | undefined;

  for (let attempt = 1; attempt <= strategy.finalize.maxAttempts; attempt++) {
    logger.step(
      "info",
      `Running finalizer agent (${attempt}/${strategy.finalize.maxAttempts})`
    );

    const executionResult = await executionProvider.execute({
      stage: "finalizer",
      agent: finalizer.agent,
      model: finalizer.model,
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
          reviewerCriteria: strategy.review.reviewer.criteria,
          sections: STAGE_SECTIONS.finalizer,
        }),
      ],
      logger,
    });

    if (!executionResult.success) {
      throw new Error(
        `Finalizer agent execution failed: ${executionResult.error}`
      );
    }

    try {
      output = readAgentOutput(artifactPath);
      parsed = parsePrDescription(output);
      lastValidationError = undefined;
      break;
    } catch (error) {
      lastValidationError =
        error instanceof PrDescriptionProtocolError
          ? new Error(`Finalizer protocol error: ${error.message}`)
          : error instanceof Error
            ? error
            : new Error(String(error));
      if (attempt === strategy.finalize.maxAttempts) {
        break;
      }
      prepareArtifactPath(artifactPath);
    }
  }

  if (!parsed) {
    throw lastValidationError ?? new Error("Finalizer validation failed");
  }

  await persistGeneratedArtifact(worktreePath, output);
  const title = ensureConventionalPrTitle(parsed.title, context.commits);

  logger.step("info", "Finalizer output generated successfully");

  return {
    title,
    body: parsed.body,
    artifactPath,
  };
}

function loadFinalizerPrompt(repoRoot: string, promptTemplate: string): string {
  const promptPath = resolvePromptTemplatePath(repoRoot, promptTemplate);
  if (existsSync(promptPath)) {
    return readFileSync(promptPath, "utf-8");
  }
  return promptTemplate;
}

function prepareArtifactPath(artifactPath: string) {
  mkdirSync(dirname(artifactPath), { recursive: true });
  if (existsSync(artifactPath)) {
    rmSync(artifactPath);
  }
}

function readAgentOutput(artifactPath: string): string {
  if (!existsSync(artifactPath)) {
    throw new Error(
      `Finalizer agent did not produce output at ${artifactPath}`
    );
  }
  const output = readFileSync(artifactPath, "utf-8");
  if (!output.trim()) {
    throw new Error(`Finalizer agent produced empty output at ${artifactPath}`);
  }
  return output;
}

async function persistGeneratedArtifact(worktreePath: string, output: string) {
  try {
    const dir = join(worktreePath, ".pourkit", ".tmp", "finalizer");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "generated.md"), output, "utf-8");
  } catch {
    // Do not fail pipeline on artifact write errors
  }
}
