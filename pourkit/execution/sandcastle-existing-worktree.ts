interface CreateSandboxFromExistingWorktreeOptions {
  branch: string;
  worktreePath: string;
  hostRepoDir: string;
  sandbox: unknown;
  hooks?: unknown;
  copyToWorktree?: string[];
}

type CreateSandboxFromWorktree = (
  options: CreateSandboxFromExistingWorktreeOptions
) => Promise<unknown>;

/**
 * Sandcastle exposes this path through Worktree.createSandbox(), but Pourkit only
 * has a preserved worktree path when resuming an interrupted issue run.
 */
export async function createSandboxFromExistingWorktree(
  options: CreateSandboxFromExistingWorktreeOptions
): Promise<unknown> {
  const sandcastleEntryUrl = import.meta.resolve("@ai-hero/sandcastle");
  const createSandboxUrl = new URL("./createSandbox.js", sandcastleEntryUrl);
  const sandcastleCreateSandbox = (await import(createSandboxUrl.href)) as {
    createSandboxFromWorktree: CreateSandboxFromWorktree;
  };

  return sandcastleCreateSandbox.createSandboxFromWorktree(options);
}
