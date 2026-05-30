import { execCapture } from "../shared/common";

export interface SerenaSidecarOptions {
  baselineWorktreePath: string;
  dataDir: string;
  mcpPort: number;
  dashboardPort: number;
  image: string;
  containerName?: string;
}

export interface SerenaSidecarStatus {
  running: boolean;
  mcpUrl: string;
  dashboardUrl: string;
  containerName: string;
}

const DEFAULT_CONTAINER_NAME = "pourkit-serena-sidecar";
const MCP_CONTAINER_PORT = 9121;
const DASHBOARD_CONTAINER_PORT = 24282;

type DockerInspectResult = {
  State?: {
    Running?: boolean;
  };
};

function resolveSidecarUrls(options: SerenaSidecarOptions) {
  return {
    containerName: options.containerName ?? DEFAULT_CONTAINER_NAME,
    mcpUrl: `http://localhost:${options.mcpPort}/mcp`,
    dashboardUrl: `http://localhost:${options.dashboardPort}`,
  };
}

async function inspectSidecarContainer(containerName: string) {
  try {
    const result = await execCapture("docker", ["inspect", containerName]);
    const parsed = JSON.parse(result.stdout) as DockerInspectResult[];
    return {
      exists: true,
      running: Boolean(parsed[0]?.State?.Running),
    };
  } catch {
    return {
      exists: false,
      running: false,
    };
  }
}

async function readSidecarStatus(
  options: SerenaSidecarOptions
): Promise<SerenaSidecarStatus> {
  const { containerName, mcpUrl, dashboardUrl } = resolveSidecarUrls(options);
  const container = await inspectSidecarContainer(containerName);

  return {
    running: container.running,
    mcpUrl,
    dashboardUrl,
    containerName,
  };
}

function buildStartArgs(options: SerenaSidecarOptions, containerName: string) {
  return [
    "run",
    "-d",
    "--name",
    containerName,
    "--restart",
    "unless-stopped",
    "-p",
    `${options.mcpPort}:${MCP_CONTAINER_PORT}`,
    "-p",
    `${options.dashboardPort}:${DASHBOARD_CONTAINER_PORT}`,
    "-v",
    `${options.baselineWorktreePath}:/workspaces/pourkit:ro`,
    "-v",
    `${options.dataDir}:/workspaces/serena`,
    options.image,
    "serena",
    "start-mcp-server",
    "--transport",
    "streamable-http",
    "--port",
    String(MCP_CONTAINER_PORT),
    "--host",
    "0.0.0.0",
  ];
}

export async function getSerenaSidecarStatus(
  options: SerenaSidecarOptions
): Promise<SerenaSidecarStatus> {
  return readSidecarStatus(options);
}

export async function startSerenaSidecar(
  options: SerenaSidecarOptions
): Promise<SerenaSidecarStatus> {
  const { containerName } = resolveSidecarUrls(options);
  const container = await inspectSidecarContainer(containerName);

  if (container.exists) {
    if (!container.running) {
      await execCapture("docker", ["start", containerName]);
    }

    return readSidecarStatus(options);
  }

  await execCapture("docker", buildStartArgs(options, containerName));

  return readSidecarStatus(options);
}

export async function stopSerenaSidecar(
  options: SerenaSidecarOptions
): Promise<SerenaSidecarStatus> {
  const { containerName } = resolveSidecarUrls(options);

  try {
    await execCapture("docker", ["stop", containerName]);
  } catch {
    // Container may already be stopped or absent.
  }

  return readSidecarStatus(options);
}
