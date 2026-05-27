import { Octokit } from "octokit";

export interface GitHubClient {
  octokit: Octokit;
  owner: string;
  repo: string;
}

export interface GitHubClientOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  repository?: string;
}

const REMOTE_PATTERN = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/;

export function resolveGitHubToken(env: NodeJS.ProcessEnv): string {
  const token = env.POURKIT_GITHUB_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GitHub token is required. Set POURKIT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN."
    );
  }
  return token;
}

export async function resolveGitHubRepository(
  options?: GitHubClientOptions
): Promise<{ owner: string; repo: string }> {
  if (options?.repository) {
    const parts = options.repository.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `Invalid repository format: "${options.repository}". Expected "owner/repo".`
      );
    }
    return { owner: parts[0], repo: parts[1] };
  }

  const env = options?.env ?? process.env;
  const envRepo = env.GITHUB_REPOSITORY;
  if (envRepo) {
    const parts = envRepo.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { owner: parts[0], repo: parts[1] };
    }
    throw new Error(
      `Invalid repository format: "${envRepo}". Expected "owner/repo".`
    );
  }

  const { execCapture } = await import("../shared/common");
  const cwd = options?.cwd;
  try {
    const result = await execCapture("git", ["remote", "get-url", "origin"], {
      cwd,
    });
    const remote = result.stdout.trim();
    const match = remote.match(REMOTE_PATTERN);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  } catch {
    // fall through to error
  }

  throw new Error(
    "Could not resolve GitHub repository. Set GITHUB_REPOSITORY env var or ensure a valid 'origin' remote exists."
  );
}

export async function requireGitHubClient(
  options?: GitHubClientOptions
): Promise<GitHubClient> {
  const env = options?.env ?? process.env;
  const token = resolveGitHubToken(env);
  const repo = await resolveGitHubRepository(options);

  const octokit = new Octokit({ auth: token });

  return { octokit, ...repo };
}

export async function tryCreateGitHubClient(
  options?: GitHubClientOptions
): Promise<
  | { ok: true; client: GitHubClient }
  | {
      ok: false;
      reason: "missing-token" | "missing-repository" | "invalid-repository";
      message: string;
    }
> {
  const env = options?.env ?? process.env;

  let token: string;
  try {
    token = resolveGitHubToken(env);
  } catch {
    return {
      ok: false,
      reason: "missing-token",
      message: "GitHub token is not configured.",
    };
  }

  let repo: { owner: string; repo: string };
  try {
    repo = await resolveGitHubRepository(options);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("Invalid repository format")) {
      return { ok: false, reason: "invalid-repository", message };
    }
    return { ok: false, reason: "missing-repository", message };
  }

  const octokit = new Octokit({ auth: token });

  return { ok: true, client: { octokit, ...repo } };
}
