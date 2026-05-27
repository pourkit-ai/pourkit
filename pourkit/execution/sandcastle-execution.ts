import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { createWorktree, opencode } from "@ai-hero/sandcastle";
import type { AgentStreamEvent } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import type {
  ExecutionProvider,
  ExecutionProviderOptions,
  ExecutionResult,
  ExecutionSession,
} from "./execution-provider";
import { writeExecutionArtifacts } from "./execution-provider";
import { ensureSandboxImageBuilt } from "./sandbox-image-build";
import { createSandboxFromExistingWorktree } from "./sandcastle-existing-worktree";
import { buildSandboxOptions } from "./sandbox-options";

export class SandcastleExecutionProvider implements ExecutionProvider {
  async createSession(): Promise<ExecutionSession> {
    return new SandcastleExecutionSession();
  }

  async execute(options: ExecutionProviderOptions): Promise<ExecutionResult> {
    const session = await this.createSession();
    try {
      return await session.execute(options);
    } finally {
      await session.close();
    }
  }
}

class SandcastleExecutionSession implements ExecutionSession {
  private sandboxHandle: SandcastleSandboxHandle | null = null;
  private worktreeHandle: SandcastleWorktreeHandle | null = null;

  async close(): Promise<void> {
    try {
      await this.sandboxHandle?.close?.();
    } finally {
      this.sandboxHandle = null;
    }
  }

  async execute(options: ExecutionProviderOptions): Promise<ExecutionResult> {
    const {
      stage,
      iteration,
      agent,
      model,
      prompt,
      target,
      repoRoot,
      branchName,
      worktreePath,
      baseRef,
      sandbox,
      autoApprove = false,
      timeoutMs,
      artifacts = [],
      logger,
    } = options;

    const stageLabel =
      iteration !== undefined ? `${stage}:${iteration}` : stage;
    logger.step(
      "sandcastle",
      `[${stageLabel}] running agent "${agent}" with model "${model}"`
    );

    try {
      const env: Record<string, string> = {};
      if (autoApprove) {
        env.OPENCODE_AUTO_APPROVE = "true";
      }

      const logPath = `${repoRoot}/.pourkit/logs/${sanitizeBranch(branchName)}-${Date.now()}.log`;

      await ensureSandboxImageBuilt(repoRoot, { force: sandbox.forceRebuild });

      try {
        savePromptToFile(repoRoot, stage, iteration, prompt);
      } catch {
        // Best-effort prompt saving; do not break execution
      }

      const agentProvider = opencode(model, { env, agent });
      const sandboxOptions = buildSandboxOptions(repoRoot, sandbox);
      const sandboxProvider = resolveSandboxProvider(sandbox.provider, docker);
      const activeSandbox = await this.getOrCreateSandbox({
        repoRoot,
        branchName,
        baseBranch: baseRef ?? target.baseBranch,
        worktreePath,
        sandboxProvider: sandboxProvider(sandboxOptions),
        setupCommands: target.setupCommands ?? [],
        copyToWorktree: sandbox.copyToWorktree ?? [],
      });

      await writeExecutionArtifacts(activeSandbox.worktreePath, artifacts);

      const result = await activeSandbox.run({
        agent: agentProvider,
        prompt,
        maxIterations: 1,
        name: stageLabel,
        logging: {
          type: "file",
          path: logPath,
          onAgentStreamEvent: (event: AgentStreamEvent) => {
            if (event.type === "text") {
              logger.raw(event.message);
            } else if (event.type === "toolCall") {
              logger.raw(`${event.name}(${event.formattedArgs})`);
            }
          },
        },
        completionSignal: "<promise>COMPLETE</promise>",
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        ...(sandboxOptions.idleTimeoutSeconds
          ? { idleTimeoutSeconds: sandboxOptions.idleTimeoutSeconds }
          : {}),
      });

      const commits = result.commits.map((c) => c.sha);
      const resultBranch = result.branch ?? activeSandbox.branch ?? branchName;

      logger.kv("SANDBOX_SUCCESS", "true");
      logger.kv("COMMITS_CREATED", String(commits.length));
      logger.kv("WORKTREE_BRANCH", resultBranch);
      if (result.logFilePath) {
        logger.kv("LOG_FILE", result.logFilePath);
      }

      return {
        success: true,
        branch: resultBranch,
        worktreePath: activeSandbox.worktreePath,
        commits,
        logPath,
      };
    } catch (error) {
      logger.step(
        "error",
        `Sandcastle failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return {
        success: false,
        branch: "",
        worktreePath: "",
        commits: [],
        logPath: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async getOrCreateSandbox(options: {
    repoRoot: string;
    branchName: string;
    baseBranch: string;
    worktreePath?: string;
    sandboxProvider: unknown;
    setupCommands: Array<{ command: string }>;
    copyToWorktree: string[];
  }): Promise<SandcastleSandboxHandle> {
    if (this.sandboxHandle) {
      return this.sandboxHandle;
    }

    const hooks = {
      sandbox: {
        onSandboxReady: options.setupCommands.map((command) => ({
          command: command.command,
        })),
      },
    };

    if (options.worktreePath) {
      this.sandboxHandle = (await createSandboxFromExistingWorktree({
        branch: options.branchName,
        hostRepoDir: options.repoRoot,
        worktreePath: options.worktreePath,
        sandbox: options.sandboxProvider,
        ...(options.copyToWorktree.length > 0
          ? { copyToWorktree: options.copyToWorktree }
          : {}),
        hooks,
      } as never)) as SandcastleSandboxHandle;
      return this.sandboxHandle;
    }

    this.worktreeHandle = (await createWorktree({
      cwd: options.repoRoot,
      branchStrategy: {
        type: "branch",
        branch: options.branchName,
        baseBranch: options.baseBranch,
      },
      ...(options.copyToWorktree.length > 0
        ? { copyToWorktree: options.copyToWorktree }
        : {}),
    } as never)) as SandcastleWorktreeHandle;

    this.sandboxHandle = await this.worktreeHandle.createSandbox({
      sandbox: options.sandboxProvider,
      ...(options.copyToWorktree.length > 0
        ? { copyToWorktree: options.copyToWorktree }
        : {}),
      hooks,
    });

    return this.sandboxHandle;
  }
}

interface SandcastleWorktreeHandle {
  branch: string;
  worktreePath: string;
  createSandbox(options: unknown): Promise<SandcastleSandboxHandle>;
}

interface SandcastleSandboxHandle {
  branch: string;
  worktreePath: string;
  run(options: unknown): Promise<{
    branch?: string;
    commits: Array<{ sha: string }>;
    logFilePath?: string;
  }>;
  close?(): Promise<unknown>;
}

function resolveSandboxProvider(
  provider: string,
  dockerFactory: (typeof import("@ai-hero/sandcastle/sandboxes/docker"))["docker"]
) {
  if (provider === "docker") {
    return dockerFactory;
  }

  throw new Error(`Unsupported sandbox provider: ${provider}`);
}

function sanitizeBranch(branchName: string) {
  return branchName.replace(/[^A-Za-z0-9._-]/g, "-");
}

function savePromptToFile(
  repoRoot: string,
  stage: string,
  iteration: number | undefined,
  prompt: string
): void {
  const promptsDir = join(repoRoot, ".pourkit", ".tmp", "prompts");
  mkdirSync(promptsDir, { recursive: true });

  const timestamp = Date.now();
  const iterationSuffix =
    iteration !== undefined ? `-iteration-${iteration}` : "";
  const filename = `${stage}${iterationSuffix}-${timestamp}.md`;
  const filePath = join(promptsDir, filename);

  writeFileSync(filePath, prompt, "utf-8");
}
