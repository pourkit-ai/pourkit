import { writeFile } from "node:fs/promises";
import { dirname, join } from "path";
import { ensureDir, execCapture, type PourkitLogger } from "../shared/common";
import type {
  SandboxConfig,
  Target,
  VerificationCommand,
} from "../shared/config";
import type { ExecutionArtifact } from "../shared/run-context";

export interface ExecutionResult {
  success: boolean;
  branch: string;
  worktreePath: string;
  commits: string[];
  logPath: string | null;
  error?: string;
}

export type PourkitStage =
  | "builder"
  | "reviewer"
  | "refactor"
  | "finalizer"
  | "conflictResolution";

export interface ExecutionProviderOptions {
  stage: PourkitStage;
  iteration?: number;
  artifactPath?: string;
  worktreePath?: string;
  agent: string;
  model: string;
  prompt: string;
  target: Target;
  repoRoot: string;
  branchName: string;
  baseRef?: string;
  sandbox: SandboxConfig;
  autoApprove?: boolean;
  timeoutMs?: number;
  artifacts?: ExecutionArtifact[];
  logger: PourkitLogger;
}

export interface ExecutionProvider {
  execute(options: ExecutionProviderOptions): Promise<ExecutionResult>;
  createSession?(): Promise<ExecutionSession>;
}

export interface ExecutionSession extends ExecutionProvider {
  close(): Promise<void>;
}

export async function runSetupCommands(
  commands: VerificationCommand[],
  worktreePath: string,
  logger: PourkitLogger
) {
  for (const command of commands) {
    await execCapture("bash", ["-lc", command.command], {
      cwd: worktreePath,
      logger,
      label: command.label,
    });
  }
}

export async function writeExecutionArtifacts(
  worktreePath: string,
  artifacts: ExecutionArtifact[]
) {
  for (const artifact of artifacts) {
    const filePath = join(worktreePath, artifact.path);
    await ensureDir(dirname(filePath));
    await writeFile(filePath, artifact.content, "utf-8");
  }
}

export class FakeExecutionProvider implements ExecutionProvider {
  private _result: ExecutionResult;
  lastOptions: ExecutionProviderOptions | null = null;
  calls: ExecutionProviderOptions[] = [];

  constructor(result: ExecutionResult) {
    this._result = result;
  }

  async execute(_options: ExecutionProviderOptions): Promise<ExecutionResult> {
    this.lastOptions = _options;
    this.calls.push(_options);
    if (_options.artifactPath && _options.worktreePath) {
      const artifactPath = join(_options.worktreePath, _options.artifactPath);
      await ensureDir(dirname(artifactPath));
      if (_options.stage === "reviewer") {
        await writeFile(
          artifactPath,
          [
            "## Findings",
            "",
            "| ID | Supersedes | Severity | File/Line | Issue | Recommendation |",
            "|----|------------|----------|-----------|-------|----------------|",
            "| none | n/a | n/a | n/a | No findings. | n/a |",
            "",
            "<verdict>PASS</verdict>",
          ].join("\n"),
          "utf-8"
        );
      }
      if (_options.stage === "finalizer") {
        await writeFile(
          artifactPath,
          "## PR Title\n\nfix: Test issue\n\n## PR Body\n\nCloses #42",
          "utf-8"
        );
      }
    }
    return this._result;
  }

  get result(): ExecutionResult {
    return this._result;
  }

  set result(value: ExecutionResult) {
    this._result = value;
  }
}
