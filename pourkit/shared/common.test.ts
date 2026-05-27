import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { execCaptureWithRetry, repoRoot } from "./common";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

function makeExecFileError(stderr: string) {
  return (...args: unknown[]) => {
    const callback = args[args.length - 1] as (
      err: Error | null,
      stdout?: string,
      stderr?: string
    ) => void;
    const error = new Error("command failed") as Error & {
      code: number;
      stdout: string;
      stderr: string;
    };
    error.code = 1;
    error.stdout = "";
    error.stderr = stderr;
    callback(error);
    return undefined as unknown as import("node:child_process").ChildProcess;
  };
}

function makeExecFileSuccess() {
  return (...args: unknown[]) => {
    const callback = args[args.length - 1] as (
      err: Error | null,
      stdout?: string,
      stderr?: string
    ) => void;
    callback(null, "", "");
    return undefined as unknown as import("node:child_process").ChildProcess;
  };
}

async function withGitRepo<T>(
  fn: (repoRoot: string, subdir: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "pourkit-reporoot-test-"));
  try {
    execFileSync("git", ["-c", "init.defaultBranch=master", "init"], {
      cwd: dir,
      encoding: "utf8",
    });
    execFileSync("git", ["config", "user.email", "test@test.com"], {
      cwd: dir,
      encoding: "utf8",
    });
    execFileSync("git", ["config", "user.name", "Test"], {
      cwd: dir,
      encoding: "utf8",
    });
    await writeFile(path.join(dir, "README.md"), "# test", "utf-8");
    execFileSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
    execFileSync("git", ["commit", "-m", "init"], {
      cwd: dir,
      encoding: "utf8",
    });
    const subdir = path.join(dir, "subdir");
    execFileSync("mkdir", ["-p", subdir]);
    return await fn(dir, subdir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("repoRoot", () => {
  it("resolves a subdirectory inside a git repo to the top-level", async () => {
    await withGitRepo(async (root, subdir) => {
      const resolved = repoRoot(subdir);
      expect(path.resolve(resolved)).toBe(path.resolve(root));
    });
  });

  it("resolves the top-level directory when it is already the git root", async () => {
    await withGitRepo(async (root, _subdir) => {
      const resolved = repoRoot(root);
      expect(path.resolve(resolved)).toBe(path.resolve(root));
    });
  });

  it("resolves the repo root when called without arguments", async () => {
    await withGitRepo(async (root, _subdir) => {
      const resolved = repoRoot(root);
      expect(path.resolve(resolved)).toBe(path.resolve(root));
    });
  });

  it("throws when the explicit path is not inside a git repo", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pourkit-reporoot-nogit-"));
    try {
      expect(() => repoRoot(dir)).toThrow("not a valid Git worktree");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("execCaptureWithRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries on HTTP 503 transient error and resolves on second attempt", async () => {
    const execFileMock = vi.mocked(execFile);
    execFileMock
      .mockImplementationOnce(makeExecFileError("HTTP 503"))
      .mockImplementationOnce(makeExecFileSuccess());

    const result = await execCaptureWithRetry(
      "gh",
      ["issue", "close", "42", "--reason", "completed"],
      { retries: 2, backoffMs: 1 }
    );

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("retries on GraphQL closeIssue transient error and resolves on second attempt", async () => {
    const execFileMock = vi.mocked(execFile);
    execFileMock
      .mockImplementationOnce(
        makeExecFileError("GraphQL: Could not close the issue. (closeIssue)")
      )
      .mockImplementationOnce(makeExecFileSuccess());

    const result = await execCaptureWithRetry(
      "gh",
      ["issue", "close", "42", "--reason", "completed"],
      { retries: 2, backoffMs: 1 }
    );

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("throws immediately for non-transient GraphQL error without retrying", async () => {
    const execFileMock = vi.mocked(execFile);
    execFileMock.mockImplementation(
      makeExecFileError("GraphQL: validation failed")
    );

    await expect(
      execCaptureWithRetry(
        "gh",
        ["issue", "close", "42", "--reason", "completed"],
        { retries: 2, backoffMs: 1 }
      )
    ).rejects.toThrow();

    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
