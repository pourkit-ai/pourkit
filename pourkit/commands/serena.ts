import { repoRoot } from "../shared/common";
import { loadRepoConfig, resolveTarget } from "../shared/config";
import {
  ensureBaselineWorktree,
  refreshSerenaBaseline,
} from "../serena/baseline";
import { prepareSerenaSidecarConfig } from "../serena/container";

export interface SerenaTargetCommandOptions {
  target: string;
  cwd?: string;
}

async function resolveSerenaCommandContext(
  options: SerenaTargetCommandOptions
) {
  const repoRootPath = options.cwd ? repoRoot(options.cwd) : repoRoot();
  const config = await loadRepoConfig(repoRootPath);
  const target = resolveTarget(config, options.target);

  return {
    repoRootPath,
    config,
    target,
  };
}

export async function runSerenaInitCommand(
  options: SerenaTargetCommandOptions
): Promise<void> {
  const { repoRootPath, config, target } =
    await resolveSerenaCommandContext(options);

  const paths = await ensureBaselineWorktree({
    repoRoot: repoRootPath,
    dataDir: config.serena.dataDir,
  });

  await refreshSerenaBaseline({
    repoRoot: repoRootPath,
    dataDir: config.serena.dataDir,
    baseBranch: target.baseBranch,
  });

  await prepareSerenaSidecarConfig({
    baselineWorktreePath: paths.baselineWorktreePath,
    dataDir: paths.dataDir,
  });
}

export async function runSerenaRefreshCommand(
  options: SerenaTargetCommandOptions
): Promise<void> {
  const { repoRootPath, config, target } =
    await resolveSerenaCommandContext(options);

  await refreshSerenaBaseline({
    repoRoot: repoRootPath,
    dataDir: config.serena.dataDir,
    baseBranch: target.baseBranch,
  });
}
