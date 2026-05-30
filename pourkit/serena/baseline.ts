import path from "node:path";
import { access, mkdir } from "node:fs/promises";
import { execCapture } from "../shared/common";

export interface SerenaPaths {
  rootDir: string;
  baselineWorktreePath: string;
  dataDir: string;
}

export interface RefreshSerenaBaselineOptions {
  repoRoot: string;
  dataDir?: string;
  remoteName?: string;
  baseBranch: string;
}

export interface SerenaBaselineStatus {
  exists: boolean;
  baselineWorktreePath: string;
  currentCommit?: string;
  expectedRef: string;
  fresh?: boolean;
}

export function resolveSerenaPaths(
  repoRoot: string,
  dataDir = ".pourkit/serena/"
): SerenaPaths {
  const rootDir = path.isAbsolute(dataDir)
    ? path.normalize(dataDir)
    : path.resolve(repoRoot, dataDir);

  return {
    rootDir,
    baselineWorktreePath: path.join(rootDir, "baseline", "active-repo"),
    dataDir: path.join(rootDir, "data"),
  };
}

async function pathExists(dirPath: string): Promise<boolean> {
  try {
    await access(dirPath);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepoRoot(repoPath: string): Promise<boolean> {
  try {
    const result = await execCapture("git", ["rev-parse", "--show-toplevel"], {
      cwd: repoPath,
      label: "git rev-parse --show-toplevel",
    });
    return path.resolve(result.stdout.trim()) === path.resolve(repoPath);
  } catch {
    return false;
  }
}

export async function ensureBaselineWorktree(options: {
  repoRoot: string;
  dataDir?: string;
}): Promise<SerenaPaths> {
  const paths = resolveSerenaPaths(options.repoRoot, options.dataDir);

  await mkdir(paths.rootDir, { recursive: true });
  await mkdir(paths.dataDir, { recursive: true });

  if (!(await pathExists(paths.baselineWorktreePath))) {
    await mkdir(path.dirname(paths.baselineWorktreePath), { recursive: true });
    await execCapture(
      "git",
      ["clone", options.repoRoot, paths.baselineWorktreePath],
      {
        cwd: options.repoRoot,
        label: "git clone baseline worktree",
      }
    );
    return paths;
  }

  if (!(await isGitRepoRoot(paths.baselineWorktreePath))) {
    throw new Error(
      `Serena baseline worktree exists but is not a git repo: ${paths.baselineWorktreePath}`
    );
  }

  return paths;
}

export async function getSerenaBaselineStatus(
  options: RefreshSerenaBaselineOptions
): Promise<SerenaBaselineStatus> {
  const remoteName = options.remoteName ?? "origin";
  const paths = resolveSerenaPaths(options.repoRoot, options.dataDir);
  const expectedRef = `${remoteName}/${options.baseBranch}`;

  if (!(await pathExists(paths.baselineWorktreePath))) {
    return {
      exists: false,
      baselineWorktreePath: paths.baselineWorktreePath,
      expectedRef,
      fresh: false,
    };
  }

  if (!(await isGitRepoRoot(paths.baselineWorktreePath))) {
    return {
      exists: false,
      baselineWorktreePath: paths.baselineWorktreePath,
      expectedRef,
      fresh: false,
    };
  }

  let currentCommit: string | undefined;
  try {
    const currentResult = await execCapture("git", ["rev-parse", "HEAD"], {
      cwd: paths.baselineWorktreePath,
      label: "git rev-parse HEAD",
    });
    currentCommit = currentResult.stdout.trim() || undefined;
  } catch {
    return {
      exists: true,
      baselineWorktreePath: paths.baselineWorktreePath,
      expectedRef,
      fresh: false,
    };
  }

  let expectedCommit: string | undefined;
  try {
    const expectedResult = await execCapture(
      "git",
      ["rev-parse", expectedRef],
      {
        cwd: paths.baselineWorktreePath,
        label: `git rev-parse ${expectedRef}`,
      }
    );
    expectedCommit = expectedResult.stdout.trim() || undefined;
  } catch {
    return {
      exists: true,
      baselineWorktreePath: paths.baselineWorktreePath,
      currentCommit,
      expectedRef,
      fresh: false,
    };
  }

  return {
    exists: true,
    baselineWorktreePath: paths.baselineWorktreePath,
    currentCommit,
    expectedRef,
    fresh: currentCommit === expectedCommit,
  };
}

export async function refreshSerenaBaseline(
  options: RefreshSerenaBaselineOptions
): Promise<SerenaBaselineStatus> {
  const remoteName = options.remoteName ?? "origin";
  const paths = await ensureBaselineWorktree(options);

  await execCapture("git", ["fetch", remoteName, options.baseBranch], {
    cwd: paths.baselineWorktreePath,
    label: "git fetch baseline branch",
  });

  await execCapture(
    "git",
    ["checkout", "--detach", `${remoteName}/${options.baseBranch}`],
    {
      cwd: paths.baselineWorktreePath,
      label: "git checkout detached baseline branch",
    }
  );

  return getSerenaBaselineStatus(options);
}
