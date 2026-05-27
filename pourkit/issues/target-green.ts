import type { PRProvider } from "../providers/pr-provider";
import { sleep } from "../shared/common";
import type { PourkitLogger } from "../shared/common";

const RED_CHECK_CONCLUSIONS = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
  "STALE",
]);

export interface WaitForBranchChecksOptions {
  branchName: string;
  checksFoundTimeoutMs?: number;
  checksCompletionTimeoutMs?: number;
  pollIntervalMs?: number;
  stableHeadMs?: number;
}

export async function waitForBranchChecks(
  prProvider: PRProvider,
  logger: PourkitLogger,
  options: WaitForBranchChecksOptions
): Promise<void> {
  const checksFoundTimeoutMs = options.checksFoundTimeoutMs ?? 60 * 1000;
  const checksCompletionTimeoutMs =
    options.checksCompletionTimeoutMs ?? 5 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 15 * 1000;
  const stableHeadMs = options.stableHeadMs ?? pollIntervalMs;

  let lastHeadSha = "";
  let headStableSince = 0;
  let checksFoundDeadline = 0;
  let checksCompletionDeadline = 0;
  let checksDiscovered = false;

  logger.step("wait", `waiting for ${options.branchName} to be green`);

  while (true) {
    const observedAt = Date.now();
    const status = await prProvider.getBranchStatus(options.branchName);

    if (status.headSha !== lastHeadSha) {
      logger.step(
        "info",
        `branch head changed to ${status.headSha.substring(0, 7)}`
      );
      lastHeadSha = status.headSha;
      headStableSince = observedAt;
      if (checksFoundDeadline === 0) {
        checksFoundDeadline = observedAt + checksFoundTimeoutMs;
      }
      checksCompletionDeadline = 0;
      checksDiscovered = false;
    }

    if (status.checks.length > 0 && !checksDiscovered) {
      checksDiscovered = true;
      checksCompletionDeadline = observedAt + checksCompletionTimeoutMs;
      logger.step("info", `Checks: ${formatChecks(status.checks)}`);
    }

    if (status.state === "red") {
      const failedChecks = status.checks
        .filter(
          (c) =>
            c.conclusion !== null && RED_CHECK_CONCLUSIONS.has(c.conclusion)
        )
        .map((c) => c.name)
        .join(", ");
      throw new Error(
        `Target branch ${options.branchName} is red: ${failedChecks}`
      );
    }

    if (status.state === "green") {
      const stableForMs = observedAt - headStableSince;
      if (stableForMs < stableHeadMs) {
        logger.step(
          "info",
          `target branch is green; waiting for stable head (${stableForMs}/${stableHeadMs}ms)`
        );
        await sleep(pollIntervalMs);
        continue;
      }

      logger.step("success", `target branch ${options.branchName} is green`);
      return;
    }

    const stableForMs = observedAt - headStableSince;
    if (!checksDiscovered && status.checks.length === 0) {
      if (observedAt >= checksFoundDeadline) {
        if (stableForMs >= stableHeadMs) {
          logger.step(
            "success",
            `target branch ${options.branchName} has no checks`
          );
          return;
        }

        throw new Error(
          `Timeout waiting for ${options.branchName} to be green`
        );
      }

      logger.step(
        "info",
        `target branch has no checks yet, waiting... (${secondsRemaining(checksFoundDeadline, observedAt)}s remaining)`
      );
      await sleep(pollIntervalMs);
      continue;
    }

    if (checksDiscovered) {
      if (observedAt >= checksCompletionDeadline) {
        throw new Error(
          `Timeout waiting for ${options.branchName} to be green`
        );
      }

      logger.step(
        "info",
        `target branch is ${status.state}, waiting... (${secondsRemaining(checksCompletionDeadline, observedAt)}s remaining)`
      );
      await sleep(pollIntervalMs);
      continue;
    }

    logger.step(
      "info",
      `target branch is ${status.state}, waiting... (${secondsRemaining(checksFoundDeadline, observedAt)}s remaining)`
    );
    await sleep(pollIntervalMs);
  }
}

function formatChecks(
  checks: { name: string; conclusion: string | null; status: string | null }[]
) {
  return checks
    .map((check) => `${check.name}=${check.conclusion ?? check.status}`)
    .join(", ");
}

function secondsRemaining(deadline: number, observedAt: number) {
  return Math.max(0, Math.ceil((deadline - observedAt) / 1000));
}
