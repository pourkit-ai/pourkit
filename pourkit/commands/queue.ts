import type { PourkitConfig, IssueData } from "../shared/config";
import type { IssueProvider } from "../providers/issue-provider";
import type { PRProvider } from "../providers/pr-provider";
import type { ExecutionProvider } from "../execution/execution-provider";
import { TYPE_LABELS } from "../shared/common";
import { selectIssue, type CandidateIssue } from "../issues/select-issue";
import type { PourkitLogger } from "../shared/common";
import { parseStackedIssue } from "../issues/stacked-issue";
import { runIssueCommand, type RunIssueResult } from "./issue";
import { createIssueTransitions } from "../issues/issue-transitions";
import {
  reconcileBlockedIssues,
  type ReconcileDependencies,
} from "../issues/blocked-issue";

export interface QueueSelectionOptions {
  config: PourkitConfig;
  issueProvider: IssueProvider;
  logger: PourkitLogger;
  prdRef?: string;
}

export type QueueSelectionOutcome =
  | { ok: true; issue: IssueData }
  | { ok: false; reason: string; code: "no-candidates" | "no-runnable" };

function issueDataToCandidate(issue: IssueData): CandidateIssue {
  return {
    number: issue.number,
    title: issue.title,
    labels: issue.labels,
    createdAt: issue.createdAt
      ? issue.createdAt.toISOString()
      : new Date(0).toISOString(),
  };
}

export async function selectNextQueueIssue(
  options: QueueSelectionOptions
): Promise<QueueSelectionOutcome> {
  const { config, issueProvider, logger, prdRef } = options;

  logger.step("info", "Loading candidate issues from provider");

  const candidates = await issueProvider.listCandidates();

  if (candidates.length === 0) {
    logger.step("warn", "No candidate issues found");
    return {
      ok: false,
      reason: "No candidate issues found.",
      code: "no-candidates",
    };
  }

  logger.raw(`Found ${candidates.length} candidate(s):`);
  for (const c of candidates) {
    logger.raw(`  #${c.number}: ${c.title} [${c.labels.join(", ")}]`);
  }

  const scopedCandidates = prdRef
    ? candidates.filter((issue) => {
        const parsed = parseStackedIssue(issue.title, issue.body);
        for (const warning of parsed.warnings) {
          logger.raw(`  #${issue.number}: ${warning}`);
        }
        if (!parsed.parentRef) {
          logger.raw(
            `  #${issue.number}: no parent found, excluding from PRD scope`
          );
          return false;
        }
        const matches = parsed.parentRef === prdRef;
        if (!matches) {
          logger.raw(
            `  #${issue.number}: parent ${parsed.parentRef} does not match ${prdRef}`
          );
        }
        return matches;
      })
    : candidates;

  if (prdRef) {
    logger.step(
      "info",
      `PRD-scoped selection: ${scopedCandidates.length} of ${candidates.length} candidate(s) match ${prdRef}`
    );
  }

  if (prdRef && scopedCandidates.length === 0) {
    logger.step("warn", `No candidate issues found for ${prdRef}.`);
    return {
      ok: false,
      reason: `No candidate issues found for ${prdRef}.`,
      code: "no-candidates",
    };
  }

  const candidateIssues: CandidateIssue[] =
    scopedCandidates.map(issueDataToCandidate);
  const selection = selectIssue(candidateIssues, {
    blockedLabel: config.labels.blocked,
    agentInProgressLabel: config.labels.agentInProgress,
  });

  if (!selection.ok) {
    logger.step("warn", `No runnable issue: ${selection.reason}`);
    return { ok: false, reason: selection.reason, code: "no-runnable" };
  }

  const selected = candidates.find((c) => c.number === selection.issue.number);
  if (!selected) {
    throw new Error(
      `Selected issue #${selection.issue.number} not found in candidate list`
    );
  }

  logger.step("info", `Selected issue #${selected.number}: ${selected.title}`);
  return { ok: true, issue: selected };
}

export interface QueueRunOptions {
  targetName?: string;
  config: PourkitConfig;
  issueProvider: IssueProvider;
  prProvider: PRProvider;
  executionProvider: ExecutionProvider;
  force: boolean;
  logger: PourkitLogger;
  repoRoot: string;
  prdRef?: string;
}

export interface RunQueueResult {
  selected: IssueData;
  runResult: RunIssueResult;
}

export interface QueueEmptyResult {
  selected: null;
  reason: string;
  code: "no-candidates" | "no-runnable";
}

export interface RunQueueLoopResult {
  drained: true;
  processedCount: number;
  results: RunQueueResult[];
  selected: null;
  reason: string;
  code: "drained";
}

function makeReconcileDeps(options: QueueRunOptions): ReconcileDependencies {
  const transitions = createIssueTransitions(
    {
      fetchIssue: async (issueNumber: number) => {
        const issue = await options.issueProvider.fetchIssue(issueNumber);
        return { labels: issue.labels };
      },
      addLabels: options.issueProvider.addLabels.bind(options.issueProvider),
      removeLabel: options.issueProvider.removeLabel.bind(
        options.issueProvider
      ),
    },
    {
      blocked: options.config.labels.blocked,
      readyForAgent: options.config.labels.readyForAgent,
      needsTriage: options.config.labels.needsTriage,
      agentInProgress: options.config.labels.agentInProgress,
      readyForHuman: options.config.labels.readyForHuman,
      prOpenAwaitingMerge: options.config.labels.prOpenAwaitingMerge,
    }
  );

  return {
    getIssueState: async (issueNumber: number) => {
      const issue = await options.issueProvider.fetchIssue(issueNumber);
      return issue.state === "closed" ? "CLOSED" : "OPEN";
    },
    transitions,
    typeLabels: TYPE_LABELS,
    readyLabel: options.config.labels.readyForAgent,
  };
}

async function reconcileBlocked(options: QueueRunOptions): Promise<void> {
  const blocked = await options.issueProvider.listBlockedIssues();
  if (blocked.length > 0) {
    options.logger.step(
      "info",
      `Reconciling ${blocked.length} blocked issue(s)`
    );
    await reconcileBlockedIssues(blocked, makeReconcileDeps(options));
  }
}

async function runOneQueueIssue(
  options: QueueRunOptions
): Promise<RunQueueResult | QueueEmptyResult> {
  const {
    targetName,
    config,
    issueProvider,
    prProvider,
    executionProvider,
    force,
    logger,
    repoRoot,
    prdRef,
  } = options;

  const outcome = await selectNextQueueIssue({
    config,
    issueProvider,
    logger,
    prdRef,
  });

  if (!outcome.ok) {
    return { selected: null, reason: outcome.reason, code: outcome.code };
  }

  const { issue: selected } = outcome;

  const runResult = await runIssueCommand({
    issueNumber: selected.number,
    targetName,
    config,
    issueProvider,
    prProvider,
    executionProvider,
    force,
    logger,
    repoRoot,
  });

  logger.raw("Issue completed successfully:");
  logger.raw(`  Branch: ${runResult.branchName}`);
  if (runResult.noOp) {
    logger.raw("  Status: no-op (closed without PR)");
  } else {
    logger.raw(`  PR Title: ${runResult.prTitle}`);
    logger.raw(`  PR Number: ${runResult.prNumber}`);
    logger.raw(`  PR URL: ${runResult.prUrl}`);
  }
  logger.raw(`  Target: ${runResult.target.name}`);

  return { selected, runResult };
}

export async function runQueue(
  options: QueueRunOptions
): Promise<RunQueueResult | QueueEmptyResult> {
  return runOneQueueIssue(options);
}

export async function runQueueLoop(
  options: QueueRunOptions
): Promise<RunQueueLoopResult> {
  const results: RunQueueResult[] = [];
  while (true) {
    await reconcileBlocked(options);

    const outcome = await runOneQueueIssue(options);
    if (outcome.selected === null) {
      return {
        drained: true,
        processedCount: results.length,
        results,
        selected: null,
        reason: "Queue drained.",
        code: "drained" as const,
      };
    }
    results.push(outcome);

    const processedIssue = await options.issueProvider.fetchIssue(
      outcome.selected.number
    );
    if (processedIssue.state === "closed") {
      await reconcileBlocked(options);
    }
  }
}
