import type { PourkitLogger } from "../shared/common";
import { ensureBaselineWorktree, refreshSerenaBaseline } from "./baseline";
import {
  getSerenaSidecarStatus,
  prepareSerenaSidecarConfig,
  startSerenaSidecar,
} from "./container";

const SERENA_MCP_PORT = 9121;
const SERENA_DASHBOARD_PORT = 24282;
const SERENA_IMAGE = "ghcr.io/oraios/serena:latest";

export interface PrepareSerenaForTargetOptions {
  repoRoot: string;
  targetName: string;
  baseBranch: string;
  dataDir: string;
  mcpUrl: string;
  enabled: boolean;
  required: boolean;
  autoStart: boolean;
  logger: PourkitLogger;
}

export type SerenaPreflightResult =
  | { enabled: false }
  | { enabled: true; available: true; mcpUrl: string }
  | { enabled: true; available: false; error: string };

function sidecarOptions(
  paths: {
    baselineWorktreePath: string;
    dataDir: string;
  },
  mcpUrl: string
) {
  return {
    baselineWorktreePath: paths.baselineWorktreePath,
    dataDir: paths.dataDir,
    mcpPort: SERENA_MCP_PORT,
    dashboardPort: SERENA_DASHBOARD_PORT,
    image: SERENA_IMAGE,
    mcpUrl,
  };
}

async function canReachMcp(url: string): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fetch(url, { method: "GET", signal: AbortSignal.timeout(500) });
      return true;
    } catch {
      if (attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  return false;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function prepareSerenaForTarget(
  options: PrepareSerenaForTargetOptions
): Promise<SerenaPreflightResult> {
  if (!options.enabled) {
    return { enabled: false };
  }

  try {
    const paths = await ensureBaselineWorktree({
      repoRoot: options.repoRoot,
      dataDir: options.dataDir,
    });

    await prepareSerenaSidecarConfig({
      baselineWorktreePath: paths.baselineWorktreePath,
      dataDir: paths.dataDir,
    });

    const status = options.autoStart
      ? await startSerenaSidecar(sidecarOptions(paths, options.mcpUrl))
      : await getSerenaSidecarStatus(sidecarOptions(paths, options.mcpUrl));
    const mcpReachable = await canReachMcp(options.mcpUrl);

    if (!mcpReachable) {
      return {
        enabled: true,
        available: false,
        error: status.running
          ? `Serena MCP is not reachable at ${options.mcpUrl}`
          : `Serena sidecar is not running for target ${options.targetName}`,
      };
    }

    await refreshSerenaBaseline({
      repoRoot: options.repoRoot,
      dataDir: options.dataDir,
      baseBranch: options.baseBranch,
    });

    return {
      enabled: true,
      available: true,
      mcpUrl: options.mcpUrl,
    };
  } catch (error) {
    return {
      enabled: true,
      available: false,
      error: formatError(error),
    };
  }
}
