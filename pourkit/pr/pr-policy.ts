import { execCapture, repoRoot, type PourkitLogger } from "../shared/common";
import type { Target } from "../shared/config";

export interface PrPolicyOptions {
  target: Target;
  explicitBase?: string;
  explicitHead?: string;
  logger: PourkitLogger;
  repoRoot: string;
}

export interface PrPolicyResult {
  baseBranch: string;
  currentBranch: string;
  root: string;
}

const DISPOSABLE_TARGET_BRANCH = /^pourkit-e2e-target\//;
const DISPOSABLE_AGENT_BRANCH = /^pourkit\/\d+\/e2e-test-issue-/;

export async function inferBaseBranch(
  explicitBase: string | undefined,
  target: Target
): Promise<string> {
  if (explicitBase) {
    return normalizeBaseBranch(explicitBase);
  }

  return normalizeBaseBranch(target.baseBranch);
}

function normalizeBaseBranch(base: string): string {
  return base;
}

export async function getCurrentBranch(cwd?: string): Promise<string> {
  const result = await execCapture(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    {
      cwd,
    }
  );

  const branch = result.stdout.trim();

  if (branch === "HEAD" || branch === "") {
    throw new Error("Cannot determine current branch (detached HEAD or empty)");
  }

  return branch;
}

export function validatePrHead(head: string, base: string): void {
  if (DISPOSABLE_TARGET_BRANCH.test(head)) {
    throw new Error(
      "Refusing to create PR from disposable E2E target branch. Switch to a proper topic branch or pass --head."
    );
  }

  if (
    DISPOSABLE_AGENT_BRANCH.test(head) &&
    !base.startsWith("pourkit-e2e-target/")
  ) {
    throw new Error(
      "Refusing to create PR from disposable E2E agent branch targeting a normal base. Switch to a proper topic branch or pass --head."
    );
  }
}

async function assertRemoteBranchExists(
  branch: string,
  cwd?: string
): Promise<void> {
  const root = cwd ?? repoRoot();

  try {
    await execCapture(
      "git",
      ["ls-remote", "--exit-code", "--heads", "origin", branch],
      {
        cwd: root,
      }
    );
  } catch (error) {
    throw new Error(
      `Explicit head branch "${branch}" must exist on origin: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function runPrPolicy(
  options: PrPolicyOptions
): Promise<PrPolicyResult> {
  const { target, explicitBase, explicitHead, logger } = options;

  const baseBranch = await inferBaseBranch(explicitBase, target);
  logger.step("policy", `base branch: ${baseBranch}`);

  const root = options.repoRoot;

  if (explicitHead !== undefined) {
    const headBranch = explicitHead.trim();

    if (headBranch === "") {
      throw new Error("Explicit head branch must be a non-empty string");
    }

    if (headBranch === baseBranch) {
      throw new Error(
        `Explicit head branch "${headBranch}" cannot match base branch "${baseBranch}"`
      );
    }

    logger.step("policy", `explicit head branch: ${headBranch}`);
    await assertRemoteBranchExists(headBranch, root);

    return { baseBranch, currentBranch: headBranch, root };
  }

  const currentBranch = await getCurrentBranch(root);
  logger.step("policy", `current branch: ${currentBranch}`);

  return { baseBranch, currentBranch, root };
}
