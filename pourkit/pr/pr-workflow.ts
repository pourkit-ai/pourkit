import type { PourkitLogger } from "../shared/common";
import type { Target } from "../shared/config";
import { runPrPolicy, validatePrHead, type PrPolicyResult } from "./pr-policy";
import type { PRProvider } from "../providers/pr-provider";

export interface PrWorkflowOptions {
  target: Target;
  explicitBase?: string;
  explicitHead?: string;
  logger: PourkitLogger;
  title: string;
  body: string;
  prProvider: PRProvider;
  repoRoot: string;
}

export interface PrWorkflowResult extends PrPolicyResult {
  prNumber: number;
  prUrl: string;
}

export async function runPrWorkflow(
  options: PrWorkflowOptions
): Promise<PrWorkflowResult> {
  const {
    target,
    explicitBase,
    explicitHead,
    logger,
    title,
    body,
    prProvider,
  } = options;

  const policyResult = await runPrPolicy({
    target,
    explicitBase,
    explicitHead,
    logger,
    repoRoot: options.repoRoot,
  });

  validatePrHead(policyResult.currentBranch, policyResult.baseBranch);

  const pr = await prProvider.createPr({
    title,
    body,
    head: policyResult.currentBranch,
    base: policyResult.baseBranch,
  });

  return {
    ...policyResult,
    prNumber: pr.number,
    prUrl: pr.url,
  };
}
