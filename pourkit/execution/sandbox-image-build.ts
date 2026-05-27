import path from "node:path";

import { execCapture } from "../shared/common";
import { sandboxImageName } from "./sandbox-image";

export async function ensureSandboxImageBuilt(
  repoRoot: string,
  options?: { force?: boolean }
) {
  const imageName = sandboxImageName(repoRoot);
  const dockerfilePath = path.join(repoRoot, ".sandcastle", "Dockerfile");

  if (!options?.force) {
    try {
      await execCapture("docker", ["image", "inspect", imageName]);
      return;
    } catch {
      // image missing, fall through to build
    }
  }

  const buildArgs = ["build", "-t", imageName, "-f", dockerfilePath];
  if (options?.force) {
    buildArgs.push("--pull", "--no-cache");
  }
  buildArgs.push(repoRoot);

  await execCapture("docker", buildArgs);
}
