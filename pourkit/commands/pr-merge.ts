import {
  resolveTarget,
  type PourkitConfig,
  type Target,
} from "../shared/config";
import { createLogger } from "../shared/common";
import type {
  MergePrOptions,
  PRProvider,
  PullRequest,
} from "../providers/pr-provider";
import { runMergeCoordinator } from "../issues/merge-coordinator";

type MergeMethod = NonNullable<MergePrOptions["method"]>;

export interface PrMergeOptions {
  prNumber: number;
  target?: string;
  method: MergeMethod;
  wait: boolean;
  targetGreen: boolean;
}

export interface PrMergeResult {
  config: PourkitConfig;
  target?: Target;
  options: PrMergeOptions;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  baseBranch: string;
  merged: boolean;
}

export type PrMergeProvider = PRProvider & {
  getPrByNumber(prNumber: number): Promise<PullRequest | null>;
};

function isFlag(value: string): boolean {
  return value.startsWith("--");
}

function requireFlagValue(flag: string, value: string | undefined): string {
  if (!value || isFlag(value)) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePrNumber(raw: string | undefined): number {
  if (!raw || isFlag(raw) || !/^\d+$/.test(raw)) {
    throw new Error("PR number is required");
  }

  const prNumber = parseInt(raw, 10);
  if (prNumber <= 0) {
    throw new Error(`Invalid PR number: ${raw}`);
  }

  return prNumber;
}

export function parsePrMergeArgs(args: string[]): {
  options: PrMergeOptions;
  remaining: string[];
} {
  const prNumber = parsePrNumber(args[0]);
  let target: string | undefined;
  let method: MergeMethod = "squash";
  let wait = true;
  let targetGreen = true;
  const remaining: string[] = [];

  let i = 1;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--target") {
      target = requireFlagValue("--target", args[i + 1]);
      i += 2;
    } else if (arg === "--method") {
      const raw = requireFlagValue("--method", args[i + 1]);
      if (raw !== "merge" && raw !== "squash" && raw !== "rebase") {
        throw new Error(`Invalid merge method: ${raw}`);
      }
      method = raw;
      i += 2;
    } else if (arg === "--no-wait") {
      wait = false;
      i += 1;
    } else if (arg === "--no-target-green") {
      targetGreen = false;
      i += 1;
    } else {
      remaining.push(arg);
      i += 1;
    }
  }

  return {
    options: {
      prNumber,
      target,
      method,
      wait,
      targetGreen,
    },
    remaining,
  };
}

export function validatePrMergeOptions(options: PrMergeOptions): void {
  const errors: string[] = [];

  if (!Number.isInteger(options.prNumber) || options.prNumber <= 0) {
    errors.push("PR number must be a positive integer");
  }

  if (options.target !== undefined && options.target.trim() === "") {
    errors.push("--target must be a non-empty string");
  }

  if (!["merge", "squash", "rebase"].includes(options.method)) {
    errors.push(`Invalid merge method: ${options.method}`);
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

export async function runPrMergeCommand(
  args: string[],
  logger?: ReturnType<typeof createLogger>,
  prProvider?: PrMergeProvider,
  config?: PourkitConfig
): Promise<PrMergeResult> {
  const { options, remaining } = parsePrMergeArgs(args);

  if (remaining.length > 0) {
    throw new Error(`Unsupported arguments: ${remaining.join(" ")}`);
  }

  validatePrMergeOptions(options);

  if (!config) {
    throw new Error("Config is required");
  }

  if (!prProvider) {
    throw new Error("PR provider is required to merge a pull request");
  }

  const ownLogger = logger ?? createLogger("pr-merge");

  try {
    const pr = await prProvider.getPrByNumber(options.prNumber);
    if (!pr) {
      throw new Error(`Pull request #${options.prNumber} was not found`);
    }

    if (pr.state !== "OPEN") {
      throw new Error(`Pull request #${options.prNumber} is ${pr.state}`);
    }

    const target = options.target
      ? resolveTarget(config, options.target)
      : undefined;
    if (target && target.baseBranch !== pr.baseRefName) {
      throw new Error(
        `Pull request #${pr.number} targets ${pr.baseRefName}, not ${target.baseBranch}`
      );
    }

    const checkWaitOptions = {
      checksFoundTimeoutMs: config.checks.checksFoundTimeoutSeconds * 1000,
      checksCompletionTimeoutMs:
        config.checks.checksCompletionTimeoutSeconds * 1000,
      pollIntervalMs: config.checks.pollIntervalSeconds * 1000,
    };

    if (!options.wait) {
      await prProvider.mergePr(pr.number, {
        method: options.method,
        matchHeadCommit: pr.headRefOid,
      });
    } else {
      const coordinatorResult = await runMergeCoordinator({
        prProvider,
        logger: ownLogger,
        prNumber: pr.number,
        targetBranch: pr.baseRefName,
        matchHeadCommit: pr.headRefOid,
        checkWaitOptions,
        method: options.method,
        waitForTargetGreen: options.targetGreen,
      });

      if (coordinatorResult.stage !== "completed") {
        throw coordinatorResult.error;
      }
    }

    return {
      config,
      target,
      options,
      prNumber: pr.number,
      prUrl: pr.url,
      prTitle: pr.title,
      baseBranch: pr.baseRefName,
      merged: true,
    };
  } finally {
    if (!logger) {
      await ownLogger.close();
    }
  }
}
