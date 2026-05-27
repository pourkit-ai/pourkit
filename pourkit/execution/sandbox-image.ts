import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function sandboxImageName(repoRoot: string): string {
  const dirName = path.basename(repoRoot.replace(/[\\/]+$/, "")) || "local";
  const sanitized = dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  const baseName = sanitized || "local";
  const dockerfilePath = path.join(repoRoot, ".sandcastle", "Dockerfile");

  if (!existsSync(dockerfilePath)) {
    return `sandcastle:${baseName}`;
  }

  const fingerprint = createHash("sha256")
    .update(readFileSync(dockerfilePath))
    .digest("hex")
    .slice(0, 8);

  return `sandcastle:${baseName}-${fingerprint}`;
}
