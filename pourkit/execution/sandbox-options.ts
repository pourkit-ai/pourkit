import type { SandboxConfig, SandboxMountConfig } from "../shared/config";
import { sandboxImageName } from "./sandbox-image";

export interface SandcastleSandboxOptions {
  imageName: string;
  mounts?: SandboxConfig["mounts"];
  env?: SandboxConfig["env"];
  idleTimeoutSeconds?: number;
}

export function buildSandboxOptions(
  repoRoot: string,
  sandbox: SandboxConfig
): SandcastleSandboxOptions {
  const mounts: SandboxConfig["mounts"] = [];
  if (sandbox.mounts !== undefined) {
    mounts.push(...sandbox.mounts);
  }

  return {
    imageName: sandboxImageName(repoRoot),
    ...(mounts.length > 0 ? { mounts } : {}),
    ...(sandbox.env !== undefined ? { env: sandbox.env } : {}),
    ...(sandbox.idleTimeoutSeconds !== undefined
      ? { idleTimeoutSeconds: sandbox.idleTimeoutSeconds }
      : {}),
  };
}
