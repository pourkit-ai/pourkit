import type {
  AgentProvider,
  AgentCommandOptions,
  PrintCommand,
} from "@ai-hero/sandcastle";
import { createWorktree, run } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { ensureSandboxImageBuilt } from "./sandbox-image-build";
import { buildSandboxOptions } from "./sandbox-options";

type DeterministicParsedStreamEvent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "result";
      result: string;
    }
  | {
      type: "tool_call";
      name: string;
      args: string;
    }
  | {
      type: "session_id";
      sessionId: string;
    };
import type {
  ExecutionProvider,
  ExecutionProviderOptions,
  ExecutionResult,
} from "./execution-provider";
import { writeExecutionArtifacts } from "./execution-provider";

export interface DeterministicAgentOptions {
  env?: Record<string, string>;
}

export class DeterministicAgentProvider implements AgentProvider {
  readonly name = "deterministic-agent";
  readonly env: Record<string, string>;
  readonly captureSessions = false;

  constructor(options?: DeterministicAgentOptions) {
    this.env = options?.env ?? {};
  }

  buildPrintCommand(_options: AgentCommandOptions): PrintCommand {
    return {
      command: "bash pourkit/execution/deterministic-agent.sh",
    };
  }

  parseStreamLine(line: string): DeterministicParsedStreamEvent[] {
    const events: DeterministicParsedStreamEvent[] = [];

    if (line.includes("<promise>COMPLETE</promise>")) {
      events.push({
        type: "text",
        text: line,
      });
      events.push({
        type: "result",
        result: "COMPLETE",
      });
    } else if (line.trim().length > 0) {
      events.push({
        type: "text",
        text: line,
      });
    }

    return events;
  }
}

function resolveSandboxProvider(provider: string) {
  if (provider === "docker") {
    return docker;
  }

  throw new Error(`Unsupported sandbox provider: ${provider}`);
}

function sanitizeBranch(branchName: string) {
  return branchName.replace(/[^A-Za-z0-9._-]/g, "-");
}

export class DeterministicExecutionProvider implements ExecutionProvider {
  lastResult: ExecutionResult | null = null;
  lastOptions: ExecutionProviderOptions | null = null;

  async execute(options: ExecutionProviderOptions): Promise<ExecutionResult> {
    this.lastOptions = options;
    const {
      stage,
      iteration,
      repoRoot: root,
      branchName,
      worktreePath,
      sandbox,
      timeoutMs,
      artifacts = [],
      logger,
    } = options;

    const stageLabel =
      iteration !== undefined ? `${stage}:${iteration}` : stage;
    logger.step(
      "deterministic",
      `[${stageLabel}] running deterministic agent (no LLM tokens)`
    );

    try {
      const logPath = `${root}/.pourkit/logs/${sanitizeBranch(branchName)}-deterministic-${Date.now()}.log`;

      await ensureSandboxImageBuilt(root, { force: sandbox.forceRebuild });

      const env: Record<string, string> = {
        POURKIT_STAGE: stage,
        POURKIT_BRANCH_NAME: branchName,
      };
      if (options.artifactPath) {
        env.POURKIT_ARTIFACT_PATH = options.artifactPath;
      }
      if (iteration !== undefined) {
        env.POURKIT_REVIEW_ITERATION = String(iteration);
      }

      const agent = new DeterministicAgentProvider({ env });

      const sandboxOptions = buildSandboxOptions(root, sandbox);
      const sandboxProvider = resolveSandboxProvider(sandbox.provider);
      let createdWorktreePath: string | undefined;
      const result = worktreePath
        ? await (async () => {
            await writeExecutionArtifacts(worktreePath, artifacts);
            return run({
              agent,
              sandbox: sandboxProvider(sandboxOptions),
              cwd: worktreePath,
              branchStrategy: { type: "head" },
              prompt: options.prompt,
              maxIterations: 1,
              logging: {
                type: "file",
                path: logPath,
              },
              completionSignal: "<promise>COMPLETE</promise>",
              ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
            });
          })()
        : await (async () => {
            const worktree = await createWorktree({
              cwd: root,
              branchStrategy: {
                type: "branch",
                branch: branchName,
                baseBranch: options.target.baseBranch,
              },
            });
            createdWorktreePath = worktree.worktreePath;
            await writeExecutionArtifacts(worktree.worktreePath, artifacts);
            return worktree.run({
              agent,
              sandbox: sandboxProvider(sandboxOptions),
              prompt: options.prompt,
              maxIterations: 1,
              logging: {
                type: "file",
                path: logPath,
              },
              completionSignal: "<promise>COMPLETE</promise>",
              ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
            });
          })();

      const commits = result.commits.map((c) => c.sha);

      logger.kv("SANDBOX_SUCCESS", "true");
      logger.kv("COMMITS_CREATED", String(commits.length));
      logger.kv("WORKTREE_BRANCH", result.branch);
      if (result.logFilePath) {
        logger.kv("LOG_FILE", result.logFilePath);
      }

      const artifactOnlyStage = stage === "reviewer" || stage === "finalizer";

      if (commits.length === 0 && !artifactOnlyStage) {
        this.lastResult = {
          success: false,
          branch: result.branch,
          worktreePath: worktreePath ?? createdWorktreePath ?? "",
          commits: [],
          logPath,
          error: "Deterministic agent returned zero commits",
        };
        return this.lastResult;
      }

      this.lastResult = {
        success: true,
        branch: result.branch,
        worktreePath: worktreePath ?? createdWorktreePath ?? "",
        commits,
        logPath,
      };
      return this.lastResult;
    } catch (error) {
      logger.step(
        "error",
        `Deterministic execution failed: ${error instanceof Error ? error.message : String(error)}`
      );
      this.lastResult = {
        success: false,
        branch: "",
        worktreePath: "",
        commits: [],
        logPath: null,
        error: error instanceof Error ? error.message : String(error),
      };
      return this.lastResult;
    }
  }
}
