import { mkdir } from "node:fs/promises";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { type PourkitLogger, createLogger } from "@pourkit/logger";

const execFileAsync = promisify(execFile);

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type { PourkitLogger };
export { createLogger };

export async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

export function repoRoot(explicitRoot = process.env.POURKIT_ROOT) {
  if (explicitRoot?.trim()) {
    const root = explicitRoot.trim();

    const insideResult = spawnSync(
      "git",
      ["-C", root, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf8" }
    );

    if (insideResult.status !== 0 || insideResult.stdout.trim() !== "true") {
      throw new Error(
        `POURKIT_ROOT is not a valid Git worktree: ${root}\n${insideResult.stderr || insideResult.stdout}`
      );
    }

    const topLevelResult = spawnSync(
      "git",
      ["-C", root, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" }
    );

    if (topLevelResult.status !== 0) {
      throw new Error(
        `Failed to validate POURKIT_ROOT as a Git worktree: ${root}\n${topLevelResult.stderr || topLevelResult.stdout}`
      );
    }

    return topLevelResult.stdout.trim();
  }

  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      `Failed to resolve repo root: ${result.stderr || result.stdout}`
    );
  }

  return result.stdout.trim();
}

export function repoRelative(root: string, ...segments: string[]) {
  return path.join(root, ...segments);
}

export function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 50);

  return slug || "issue";
}

function formatCommand(command: string, args: string[]) {
  return [command, ...args]
    .map((part) => {
      if (/^[A-Za-z0-9_\/.=:,@+-]+$/.test(part)) {
        return part;
      }

      return `'${part.replace(/'/g, "'\\''")}'`;
    })
    .join(" ");
}

export function readMaybeEnvInt(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function execCapture(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    logger?: PourkitLogger;
    label?: string;
  } = {}
) {
  if (options.logger && options.label) {
    options.logger.step(
      options.label,
      `running ${formatCommand(command, args)}`
    );
  }

  let stdout = "";
  let stderr = "";
  let code = 0;

  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });

    stdout =
      typeof result.stdout === "string"
        ? result.stdout
        : String(result.stdout ?? "");
    stderr =
      typeof result.stderr === "string"
        ? result.stderr
        : String(result.stderr ?? "");
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    stdout = typeof err.stdout === "string" ? err.stdout : "";
    stderr = typeof err.stderr === "string" ? err.stderr : "";
    code = typeof err.code === "number" ? err.code : 1;
  }

  if (code !== 0) {
    throw new Error(
      [
        `command failed: ${formatCommand(command, args)}`,
        `exit code: ${code}`,
        stdout ? `stdout:\n${stdout}` : "",
        stderr ? `stderr:\n${stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return { code, stdout, stderr } satisfies RunResult;
}

export async function execJson<T>(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    logger?: PourkitLogger;
    label?: string;
  } = {}
) {
  const result = await execCapture(command, args, options);
  return JSON.parse(result.stdout) as T;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TRANSIENT_GH_ERROR =
  /HTTP (502|503|504)\b|Could not close the issue|GraphQL:.*closeIssue/;

export async function execCaptureWithRetry(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    logger?: PourkitLogger;
    label?: string;
    retries?: number;
    backoffMs?: number;
  } = {}
) {
  const retries = options.retries ?? 3;
  const backoffMs = options.backoffMs ?? 2000;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await execCapture(command, args, options);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!TRANSIENT_GH_ERROR.test(lastError.message)) {
        throw lastError;
      }
      if (options.logger) {
        options.logger.step(
          options.label ?? command,
          `transient failure (attempt ${attempt}/${retries}), retrying`
        );
      }
      if (attempt < retries) {
        await sleep(backoffMs * Math.pow(2, attempt - 1));
      }
    }
  }

  throw lastError!;
}

export async function execJsonWithRetry<T>(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    logger?: PourkitLogger;
    label?: string;
    retries?: number;
    backoffMs?: number;
  } = {}
) {
  const result = await execCaptureWithRetry(command, args, options);
  return JSON.parse(result.stdout) as T;
}

export const TYPE_LABELS = [
  "type:bugfix",
  "type:infra",
  "type:feature",
  "type:polish",
  "type:refactor",
] as const;

/**
 * Parse `git worktree list --porcelain` output and find the worktree
 * path for a given branch.
 *
 * Returns null if no worktree is registered for that branch.
 */
export function parseWorktreeListPorcelain(
  text: string,
  branch: string
): string | null {
  const entries = text.trim().split("\n\n");
  for (const entry of entries) {
    const lines = entry.trim().split("\n");
    let path = "";
    let entryBranch = "";
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
      } else if (line.startsWith("branch refs/heads/")) {
        entryBranch = line.slice("branch refs/heads/".length);
      }
    }
    if (entryBranch === branch && path) {
      return path;
    }
  }
  return null;
}
