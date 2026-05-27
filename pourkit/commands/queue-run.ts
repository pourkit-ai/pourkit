import type { PourkitConfig, IssueData } from "../shared/config";
import type { IssueProvider } from "../providers/issue-provider";
import type { PRProvider } from "../providers/pr-provider";
import type { ExecutionProvider } from "../execution/execution-provider";
import {
  runQueue,
  runQueueLoop,
  type QueueRunOptions,
  type RunQueueResult,
  type QueueEmptyResult,
  type RunQueueLoopResult,
} from "./queue";
import type { PourkitLogger } from "../shared/common";

export interface RunQueueOptions {
  targetName?: string;
  config: PourkitConfig;
  issueProvider: IssueProvider;
  prProvider: PRProvider;
  executionProvider: ExecutionProvider;
  force: boolean;
  loop: boolean;
  logger: PourkitLogger;
  repoRoot: string;
  prdRef?: string;
}

export type RunQueueOutcome =
  | RunQueueResult
  | QueueEmptyResult
  | RunQueueLoopResult;

export async function runQueueCommand(
  options: RunQueueOptions
): Promise<RunQueueOutcome> {
  const queueOptions: QueueRunOptions = {
    targetName: options.targetName,
    config: options.config,
    issueProvider: options.issueProvider,
    prProvider: options.prProvider,
    executionProvider: options.executionProvider,
    force: options.force,
    logger: options.logger,
    repoRoot: options.repoRoot,
    prdRef: options.prdRef,
  };

  if (!options.loop) {
    return runQueue(queueOptions);
  }

  return runQueueLoop(queueOptions);
}
