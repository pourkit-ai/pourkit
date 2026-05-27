import { execCapture } from "./common";
import { readWorktreeRunState } from "./worktree-run-state";
import type { PourkitConfig } from "./config";
import type { IssueProvider } from "../providers/issue-provider";
import type { PRProvider } from "../providers/pr-provider";
import type { PourkitLogger } from "./common";
import { join } from "node:path";

interface WorktreeEntry {
  path: string;
  branch?: string;
}

interface CleanupCandidate {
  path: string;
  branch?: string;
}

interface CleanupOptions {
  repoRoot: string;
  config: PourkitConfig;
  issueProvider: IssueProvider;
  prProvider: PRProvider;
  logger: PourkitLogger;
}

export function parseWorktreeListPorcelain(text: string): WorktreeEntry[] {
  const entries = text.trim().split("\n\n");
  return entries
    .map((entry) => {
      const lines = entry.trim().split("\n");
      let path = "";
      let branch = "";
      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          path = line.slice("worktree ".length);
        } else if (line.startsWith("branch refs/heads/")) {
          branch = line.slice("branch refs/heads/".length);
        }
      }
      return { path, branch: branch || undefined };
    })
    .filter((e) => e.path);
}

export async function listCleanupCandidates(
  repoRoot: string,
  retentionDays: number
): Promise<CleanupCandidate[]> {
  const { stdout } = await execCapture(
    "git",
    ["worktree", "list", "--porcelain"],
    { cwd: repoRoot }
  );
  const entries = parseWorktreeListPorcelain(stdout);
  const now = Date.now();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const candidates: CleanupCandidate[] = [];

  for (const entry of entries) {
    if (!entry.branch) continue;

    const state = readWorktreeRunState(entry.path);
    if (!state) continue;

    const isCompleted = state.pr?.merged === true;
    if (!isCompleted) continue;

    const updatedAt = new Date(state.updatedAt).getTime();
    if (now - updatedAt < retentionMs) continue;

    candidates.push({ path: entry.path, branch: entry.branch });
  }

  return candidates;
}

export async function removeStaleWorktree(
  candidate: CleanupCandidate,
  repoRoot: string,
  logger: PourkitLogger
): Promise<void> {
  logger.step("cleanup", `Removing stale worktree at ${candidate.path}`);
  await execCapture("git", ["worktree", "remove", candidate.path], {
    cwd: repoRoot,
  });
  if (candidate.branch) {
    try {
      await execCapture("git", ["branch", "-d", candidate.branch], {
        cwd: repoRoot,
      });
    } catch {
      // Branch not merged yet - leave it
    }
  }
}

export async function removeExpiredFiles(
  dirPath: string,
  retentionDays: number
): Promise<void> {
  const { readdir, stat, unlink, access } = await import("node:fs/promises");

  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return;
  }

  const now = Date.now();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

  for (const entry of entries) {
    const entryPath = join(dirPath, entry);
    try {
      const stats = await stat(entryPath);
      if (stats.isFile() && now - stats.mtimeMs > retentionMs) {
        await access(entryPath, 4); // R_OK — skip if not readable
        await unlink(entryPath);
      }
    } catch {
      // skip unreadable files
    }
  }
}

export async function removeExpiredPromptDumps(
  worktreePaths: string[],
  retentionDays: number
): Promise<void> {
  for (const wtPath of worktreePaths) {
    await removeExpiredFiles(
      join(wtPath, ".pourkit", ".tmp", "prompts"),
      retentionDays
    );
  }
}

export async function cleanupRepository(
  options: CleanupOptions
): Promise<void> {
  const { repoRoot, config, logger } = options;
  if (!config.cleanup?.enabled) return;

  try {
    const retentionDays = config.cleanup.worktreeRetentionDays ?? 14;
    const candidates = await listCleanupCandidates(repoRoot, retentionDays);
    for (const candidate of candidates) {
      try {
        await removeStaleWorktree(candidate, repoRoot, logger);
      } catch (err) {
        logger.step(
          "warn",
          `Failed to remove stale worktree ${candidate.path}: ${err}`
        );
      }
    }

    const logRetentionDays = config.cleanup.logRetentionDays ?? 30;
    await removeExpiredFiles(
      join(repoRoot, ".pourkit", "logs"),
      logRetentionDays
    );

    const { stdout: wtStdout } = await execCapture(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: repoRoot }
    );
    const worktreePaths = parseWorktreeListPorcelain(wtStdout).map(
      (e) => e.path
    );
    await removeExpiredPromptDumps(worktreePaths, logRetentionDays);
  } catch (err) {
    logger.step("warn", `Cleanup failed: ${err}`);
  }
}
