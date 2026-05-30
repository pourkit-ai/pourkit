import { repoRoot } from "../shared/common";
import { loadRepoConfig, resolveTarget } from "../shared/config";
import {
  ensureBaselineWorktree,
  getSerenaBaselineStatus,
  refreshSerenaBaseline,
  resolveSerenaPaths,
  type SerenaPaths,
} from "../serena/baseline";
import {
  getSerenaSidecarStatus,
  indexSerenaProject,
  prepareSerenaSidecarConfig,
  startSerenaSidecar,
  stopSerenaSidecar,
  type SerenaSidecarStatus,
} from "../serena/container";

const SERENA_MCP_PORT = 9121;
const SERENA_DASHBOARD_PORT = 24282;
const SERENA_IMAGE = "ghcr.io/oraios/serena:latest";

export interface SerenaTargetCommandOptions {
  target: string;
  cwd?: string;
}

export interface SerenaLifecycleCommandOptions {
  cwd?: string;
  target?: string;
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

async function resolveSerenaLifecycleContext(
  options: SerenaLifecycleCommandOptions
) {
  const repoRootPath = options.cwd ? repoRoot(options.cwd) : repoRoot();
  const config = await loadRepoConfig(repoRootPath);

  return {
    repoRootPath,
    config,
    paths: resolveSerenaPaths(repoRootPath, config.serena.dataDir),
  };
}

function buildSerenaSidecarOptions(paths: SerenaPaths, mcpUrl?: string) {
  return {
    baselineWorktreePath: paths.baselineWorktreePath,
    dataDir: paths.dataDir,
    mcpPort: SERENA_MCP_PORT,
    dashboardPort: SERENA_DASHBOARD_PORT,
    image: SERENA_IMAGE,
    mcpUrl,
  };
}

function logSerenaSidecarStatus(
  heading: string,
  status: SerenaSidecarStatus,
  baselineFreshness?: "fresh" | "stale"
) {
  console.log(`${heading}:`);
  console.log(`  running: ${status.running ? "yes" : "no"}`);
  console.log(`  mcpUrl: ${status.mcpUrl}`);
  console.log(`  dashboardUrl: ${status.dashboardUrl}`);
  console.log(`  containerName: ${status.containerName}`);

  if (baselineFreshness) {
    console.log(`  Baseline freshness: ${baselineFreshness}`);
  }
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

  const sidecarOptions = buildSerenaSidecarOptions(paths, config.serena.mcpUrl);
  await startSerenaSidecar(sidecarOptions);
  await indexSerenaProject(sidecarOptions);
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

export async function runSerenaStartCommand(
  options: SerenaLifecycleCommandOptions
): Promise<void> {
  const { repoRootPath, config } = await resolveSerenaLifecycleContext(options);
  const ensuredPaths = await ensureBaselineWorktree({
    repoRoot: repoRootPath,
    dataDir: config.serena.dataDir,
  });

  await prepareSerenaSidecarConfig({
    baselineWorktreePath: ensuredPaths.baselineWorktreePath,
    dataDir: ensuredPaths.dataDir,
  });

  const status = await startSerenaSidecar(
    buildSerenaSidecarOptions(ensuredPaths, config.serena.mcpUrl)
  );
  logSerenaSidecarStatus("Serena sidecar started", status);
}

export async function runSerenaStopCommand(
  options: SerenaLifecycleCommandOptions
): Promise<void> {
  const { config, paths } = await resolveSerenaLifecycleContext(options);
  const status = await stopSerenaSidecar(
    buildSerenaSidecarOptions(paths, config.serena.mcpUrl)
  );
  logSerenaSidecarStatus("Serena sidecar stopped", status);
}

export async function runSerenaStatusCommand(
  options: SerenaLifecycleCommandOptions
): Promise<void> {
  const { repoRootPath, config, paths } =
    await resolveSerenaLifecycleContext(options);
  const status = await getSerenaSidecarStatus(
    buildSerenaSidecarOptions(paths, config.serena.mcpUrl)
  );

  if (options.target) {
    const target = resolveTarget(config, options.target);
    const baseline = await getSerenaBaselineStatus({
      repoRoot: repoRootPath,
      dataDir: config.serena.dataDir,
      baseBranch: target.baseBranch,
    });

    logSerenaSidecarStatus(
      "Serena sidecar status",
      status,
      baseline.fresh ? "fresh" : "stale"
    );
    return;
  }

  logSerenaSidecarStatus("Serena sidecar status", status);
}
