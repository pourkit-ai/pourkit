import path from "node:path";
import { describe, expect } from "vitest";
import { runIssueCommand } from "../../commands/issue";
import { runQueueCommand } from "../../commands/queue-run";
import type { RunQueueOutcome } from "../../commands/queue-run";
import { DeterministicExecutionProvider } from "../../execution/deterministic-agent";
import { makeE2EConfig, resolveE2EConfigFile } from "../run-live-e2e";
import {
  createLogger,
  repoRoot,
  type PourkitLogger,
} from "../../shared/common";
import {
  loadRepoConfig,
  resolveTarget,
  type IssueData,
  type PourkitConfig,
  type Target,
} from "../../shared/config";
import { renderBranchName } from "../../pr/templates";
import { GitHubIssueProvider } from "../../providers/github-provider";
import { GitHubPRProvider } from "../../providers/github-pr-provider";
import {
  requireGitHubClient,
  type GitHubClient,
} from "../../providers/github-client";
import type { IssueProvider } from "../../providers/issue-provider";
import type { BlockedIssue } from "../../issues/blocked-issue";
import {
  cleanupQueueLoopResources,
  cleanupResources,
  createE2EIssue,
  createLiveTargetBranch,
  persistResources,
  ScenarioExecutionProvider,
  ScenarioPrProvider,
  type E2EResources,
  type ScenarioExecutionInjections,
  type ScenarioPrInjections,
} from "./harness";

class ScopedIssueProvider implements IssueProvider {
  private readonly base: GitHubIssueProvider;
  private readonly allowedNumbers: Set<number>;

  constructor(base: GitHubIssueProvider, allowedNumbers: Iterable<number>) {
    this.base = base;
    this.allowedNumbers = new Set(allowedNumbers);
  }

  async fetchIssue(number: number): Promise<IssueData> {
    return this.base.fetchIssue(number);
  }

  async listCandidates(): Promise<IssueData[]> {
    const all = await this.base.listCandidates();
    return all.filter((i) => this.allowedNumbers.has(i.number));
  }

  async listBlockedIssues(): Promise<BlockedIssue[]> {
    const all = await this.base.listBlockedIssues();
    return all.filter((i) => this.allowedNumbers.has(i.number));
  }

  async listRelatedIssues(parentRef: string): Promise<IssueData[]> {
    return this.base.listRelatedIssues(parentRef);
  }

  async resolveIssueByCanonicalRef(ref: string): Promise<IssueData | null> {
    return this.base.resolveIssueByCanonicalRef(ref);
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    return this.base.addLabels(issueNumber, labels);
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    return this.base.removeLabel(issueNumber, label);
  }

  async getComments(issueNumber: number): Promise<string[]> {
    return this.base.getComments(issueNumber);
  }

  async commentIssue(issueNumber: number, body: string): Promise<void> {
    return this.base.commentIssue(issueNumber, body);
  }

  async closeIssue(issueNumber: number): Promise<void> {
    return this.base.closeIssue(issueNumber);
  }
}

export const describeLive =
  process.env.POURKIT_RUN_LIVE_E2E === "true" ? describe : describe.skip;

export interface LiveScenarioOptions {
  fullCheck?: boolean;
  executionInjections?: ScenarioExecutionInjections;
  prInjections?: ScenarioPrInjections;
  prepareIssue?: (issueNumber: number, client: GitHubClient) => Promise<void>;
  mutateConfig?: (config: PourkitConfig) => PourkitConfig;
}

export function resolveLiveTestName(defaultTitle: string): string {
  return expect.getState().currentTestName?.trim() ?? defaultTitle;
}

export function resolveLivePrTitle(defaultTitle: string): string {
  return `test: ${resolveLiveTestName(defaultTitle)}`;
}

export interface LiveScenarioContext {
  root: string;
  runId: string;
  client: GitHubClient;
  logger: PourkitLogger;
  issueProvider: GitHubIssueProvider;
  prProvider: ScenarioPrProvider;
  executionProvider: ScenarioExecutionProvider;
  resources: E2EResources;
  config: PourkitConfig;
  issue: IssueData;
  target: Target;
  expectedBranchName: string;
  runIssue(): ReturnType<typeof runIssueCommand>;
  rerunIssue(options?: { force?: boolean }): ReturnType<typeof runIssueCommand>;
  cleanup(): Promise<void>;
}

export function generateRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveLiveTargetName(): string {
  const targetName = process.env.POURKIT_LIVE_E2E_TARGET?.trim();
  if (!targetName) {
    throw new Error(
      "POURKIT_LIVE_E2E_TARGET is required. Run npm run pourkit:e2e:test-live --target <name>."
    );
  }

  return targetName;
}

export async function createLiveScenario(
  options: LiveScenarioOptions
): Promise<LiveScenarioContext> {
  const root = repoRoot();
  const runId = generateRunId();
  const targetName = resolveLiveTargetName();
  const livePrTitle = resolveLivePrTitle(`E2E Test Issue ${runId}`);
  const logPath = path.join(root, ".pourkit", "logs", `e2e-${runId}.log`);
  const logger = createLogger("e2e", logPath);
  const client = await requireGitHubClient({ cwd: root });
  const issueProvider = new GitHubIssueProvider(client);
  const executionInjections: ScenarioExecutionInjections = {
    ...options.executionInjections,
    finalizer: {
      ...options.executionInjections?.finalizer,
      title: options.executionInjections?.finalizer?.title ?? livePrTitle,
    },
  };
  const executionProvider = new ScenarioExecutionProvider(
    new DeterministicExecutionProvider(),
    executionInjections
  );
  const prProvider = new ScenarioPrProvider(
    new GitHubPRProvider(client, logger),
    client,
    options.prInjections
  );
  const resources: E2EResources = {};

  try {
    const targetBranch = await createLiveTargetBranch(runId, logger);
    resources.targetBranch = targetBranch;
    await persistResources(root, runId, resources);

    const createdIssue = await createE2EIssue(
      runId,
      targetBranch,
      logger,
      client,
      livePrTitle
    );
    resources.issueNumber = createdIssue.number;
    resources.issueUrl = createdIssue.url;
    await persistResources(root, runId, resources);

    if (options.prepareIssue) {
      await options.prepareIssue(createdIssue.number, client);
    }

    const baseConfig = await loadRepoConfig(root, resolveE2EConfigFile(root));
    const config = (options.mutateConfig ?? ((value) => value))(
      makeE2EConfig(
        baseConfig,
        targetName,
        targetBranch,
        options.fullCheck ? "full-check" : "fast"
      )
    );
    const issue = await issueProvider.fetchIssue(createdIssue.number);
    const target = resolveTarget(config, targetName);
    const expectedBranchName = renderBranchName(target.branchTemplate, issue);
    resources.agentBranch = expectedBranchName;
    await persistResources(root, runId, resources);

    return {
      root,
      runId,
      client,
      logger,
      issueProvider,
      prProvider,
      executionProvider,
      resources,
      config,
      issue,
      target,
      expectedBranchName,
      runIssue: () =>
        runIssueCommand({
          issueNumber: createdIssue.number,
          targetName,
          config,
          issueProvider,
          prProvider,
          executionProvider,
          force: false,
          logger,
          repoRoot: root,
        }),
      rerunIssue: (opts?: { force?: boolean }) =>
        runIssueCommand({
          issueNumber: createdIssue.number,
          targetName,
          config,
          issueProvider,
          prProvider,
          executionProvider,
          force: opts?.force ?? false,
          logger,
          repoRoot: root,
        }),
      cleanup: async () => {
        await cleanupResources(resources, root, runId, false, logger, client);
        await logger.close();
      },
    };
  } catch (error) {
    logger.step(
      "error",
      `Live scenario setup failed: ${error instanceof Error ? error.message : String(error)}`
    );
    await cleanupResources(resources, root, runId, false, logger, client);
    await logger.close();
    throw error;
  }
}

export interface QueueLoopLiveIssueState {
  issueNumber: number;
  issueUrl: string;
  agentBranch: string;
  prNumber?: number;
  prUrl?: string;
}

export interface QueueLoopLiveScenarioOptions {
  executionInjections?: ScenarioExecutionInjections;
  prInjections?: ScenarioPrInjections;
  prepareIssueA?: (issueNumber: number, client: GitHubClient) => Promise<void>;
  prepareIssueB?: (
    issueNumber: number,
    issueANumber: number,
    client: GitHubClient
  ) => Promise<void>;
  mutateConfig?: (config: PourkitConfig) => PourkitConfig;
}

export interface QueueLoopLiveScenarioContext {
  root: string;
  runId: string;
  client: GitHubClient;
  logger: PourkitLogger;
  issueProvider: GitHubIssueProvider;
  prProvider: ScenarioPrProvider;
  executionProvider: ScenarioExecutionProvider;
  config: PourkitConfig;
  target: Target;
  targetBranch: string;
  issues: QueueLoopLiveIssueState[];
  runQueueLoop(): Promise<RunQueueOutcome>;
  cleanup(): Promise<string[]>;
}

export async function createQueueLoopLiveScenario(
  options: QueueLoopLiveScenarioOptions = {}
): Promise<QueueLoopLiveScenarioContext> {
  const root = repoRoot();
  const runId = generateRunId();
  const targetName = resolveLiveTargetName();
  const issueATitle = resolveLivePrTitle("Queue Loop Issue A");
  const issueBTitle = resolveLivePrTitle("Queue Loop Issue B");
  const logPath = path.join(root, ".pourkit", "logs", `e2e-${runId}.log`);
  const logger = createLogger("e2e", logPath);
  const client = await requireGitHubClient({ cwd: root });
  const issueProvider = new GitHubIssueProvider(client);
  const executionInjections: ScenarioExecutionInjections = {
    ...options.executionInjections,
    finalizer: {
      ...options.executionInjections?.finalizer,
      title:
        options.executionInjections?.finalizer?.title ??
        resolveLivePrTitle("E2E Queue Loop"),
    },
  };
  const executionProvider = new ScenarioExecutionProvider(
    new DeterministicExecutionProvider(),
    executionInjections
  );
  const prProvider = new ScenarioPrProvider(
    new GitHubPRProvider(client, logger),
    client,
    options.prInjections
  );
  const qlIssues: QueueLoopLiveIssueState[] = [];

  try {
    const targetBranch: string = await createLiveTargetBranch(runId, logger);
    await persistResources(root, runId, { targetBranch });

    const issueA = await createE2EIssue(
      runId,
      targetBranch,
      logger,
      client,
      issueATitle
    );
    qlIssues.push({
      issueNumber: issueA.number,
      issueUrl: issueA.url,
      agentBranch: "",
    });
    await persistResources(root, runId, {
      targetBranch,
      issueNumber: issueA.number,
      issueUrl: issueA.url,
    });

    if (options.prepareIssueA) {
      await options.prepareIssueA(issueA.number, client);
    }

    const issueB = await createE2EIssue(
      runId,
      targetBranch,
      logger,
      client,
      issueBTitle
    );
    qlIssues.push({
      issueNumber: issueB.number,
      issueUrl: issueB.url,
      agentBranch: "",
    });
    await persistResources(root, runId, {
      targetBranch,
      issueNumber: issueB.number,
      issueUrl: issueB.url,
    });

    if (options.prepareIssueB) {
      await options.prepareIssueB(issueB.number, issueA.number, client);
    }

    const baseConfig = await loadRepoConfig(root, resolveE2EConfigFile(root));
    const config = (options.mutateConfig ?? ((value) => value))(
      makeE2EConfig(baseConfig, targetName, targetBranch, "fast")
    );
    const target = resolveTarget(config, targetName);

    const issueAData = await issueProvider.fetchIssue(issueA.number);
    const issueBData = await issueProvider.fetchIssue(issueB.number);
    const branchA = renderBranchName(target.branchTemplate, issueAData);
    const branchB = renderBranchName(target.branchTemplate, issueBData);

    qlIssues[0].agentBranch = branchA;
    qlIssues[1].agentBranch = branchB;

    return {
      root,
      runId,
      client,
      logger,
      issueProvider,
      prProvider,
      executionProvider,
      config,
      target,
      targetBranch,
      issues: qlIssues,
      runQueueLoop: async () => {
        const scopedIssueNumbers = qlIssues.map((i) => i.issueNumber);
        const scopedProvider = new ScopedIssueProvider(
          issueProvider,
          scopedIssueNumbers
        );
        const outcome = await runQueueCommand({
          targetName,
          config,
          issueProvider: scopedProvider,
          prProvider,
          executionProvider,
          force: false,
          loop: true,
          logger,
          repoRoot: root,
        });
        if ("drained" in outcome) {
          for (const result of outcome.results) {
            const state = qlIssues.find(
              (i) => i.issueNumber === result.selected.number
            );
            if (state) {
              state.prNumber = result.runResult.prNumber;
              state.prUrl = result.runResult.prUrl;
            }
          }
        }
        return outcome;
      },
      cleanup: async () => {
        const cleanupErrors = await cleanupQueueLoopResources(
          { targetBranch, issues: qlIssues },
          root,
          runId,
          logger,
          client
        );
        await logger.close();
        return cleanupErrors;
      },
    };
  } catch (error) {
    logger.step(
      "error",
      `Queue Loop live scenario setup failed: ${error instanceof Error ? error.message : String(error)}`
    );
    const partialTargetBranch = `pourkit-e2e-target/${runId}`;
    await cleanupQueueLoopResources(
      { targetBranch: partialTargetBranch, issues: qlIssues },
      root,
      runId,
      logger,
      client
    );
    await logger.close();
    throw error;
  }
}
