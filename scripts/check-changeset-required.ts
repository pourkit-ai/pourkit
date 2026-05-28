import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const CHANGESET_MARKER = "no-changeset-needed";

interface ChangesetGuardResult {
  ok: boolean;
  message: string;
}

function isChangesetFile(file: string): boolean {
  return /^\.changeset\/.+\.md$/.test(file);
}

export function detectChangesetFiles(
  changedFiles: string[]
): ChangesetGuardResult {
  const hasChangeset = changedFiles.some(isChangesetFile);
  if (hasChangeset) {
    return { ok: true, message: "Changeset file detected." };
  }
  return { ok: false, message: "" };
}

export function detectBypassLabel(labels: string[]): ChangesetGuardResult {
  if (labels.includes(CHANGESET_MARKER)) {
    return {
      ok: true,
      message: `Bypass label "${CHANGESET_MARKER}" detected.`,
    };
  }
  return { ok: false, message: "" };
}

export function checkChangesetRequired(
  changedFiles: string[],
  labels: string[]
): ChangesetGuardResult {
  const changesetResult = detectChangesetFiles(changedFiles);
  if (changesetResult.ok) return changesetResult;

  const bypassResult = detectBypassLabel(labels);
  if (bypassResult.ok) return bypassResult;

  return {
    ok: false,
    message: [
      `No Changeset found and no "${CHANGESET_MARKER}" label detected.`,
      "",
      "If your PR contains user-facing changes, add a Changeset:",
      "  npx changeset",
      "",
      `If your PR does NOT contain user-facing changes, add the "${CHANGESET_MARKER}" label.`,
    ].join("\n"),
  };
}

export function getChangedFiles(): string[] {
  const baseRef = process.env.GITHUB_BASE_REF;
  if (baseRef) {
    const output = execSync(`git diff --name-only origin/${baseRef}...HEAD`, {
      encoding: "utf-8",
    });
    return output.trim().split("\n").filter(Boolean);
  }
  const output = execSync("git diff --name-only HEAD~1", {
    encoding: "utf-8",
  });
  return output.trim().split("\n").filter(Boolean);
}

function getPrLabels(): string[] {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) return [];
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf-8"));
    const labels: { name: string }[] =
      event.pull_request?.labels ?? event.labels ?? [];
    return labels.map((l: { name: string }) => l.name);
  } catch {
    return [];
  }
}

export function main(): void {
  const changedFiles = getChangedFiles();
  const labels = getPrLabels();
  const result = checkChangesetRequired(changedFiles, labels);

  if (result.ok) {
    console.log(result.message);
    process.exit(0);
  }

  console.error(result.message);
  process.exit(1);
}

if (process.argv[1]?.endsWith("check-changeset-required.ts")) {
  main();
}
