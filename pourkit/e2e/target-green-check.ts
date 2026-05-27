import { execCapture, sleep } from "../shared/common";
import { pathToFileURL } from "node:url";

const DEFAULT_HOLD_MS = 25_000;
const FAIL_MARKER = /\be2e-check:\s*fail\b/i;
const PASS_MARKER = /\be2e-check:\s*pass\b/i;

export function evaluateTargetGreenCommitMessage(message: string): {
  passed: boolean;
  reason: string;
} {
  if (FAIL_MARKER.test(message)) {
    return { passed: false, reason: "explicit fail marker" };
  }

  if (PASS_MARKER.test(message)) {
    return { passed: true, reason: "explicit pass marker" };
  }

  return { passed: true, reason: "default pass" };
}

async function readLatestCommitMessage(): Promise<string> {
  const result = await execCapture("git", ["log", "-1", "--format=%B"]);
  return result.stdout.trim();
}

export async function runTargetGreenCheck(): Promise<void> {
  const holdMs = readHoldMs(process.env.POURKIT_TARGET_GREEN_HOLD_MS);
  await sleep(holdMs);

  const message = await readLatestCommitMessage();
  const evaluation = evaluateTargetGreenCommitMessage(message);

  if (!evaluation.passed) {
    throw new Error(
      `Target branch commit failed target-green policy: ${evaluation.reason}`
    );
  }
}

function readHoldMs(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_HOLD_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HOLD_MS;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runTargetGreenCheck().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
}
