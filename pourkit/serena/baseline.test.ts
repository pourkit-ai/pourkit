import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureBaselineWorktree,
  getSerenaBaselineStatus,
  refreshSerenaBaseline,
  resolveSerenaPaths,
} from "./baseline";

const { execCaptureMock } = vi.hoisted(() => ({
  execCaptureMock: vi.fn(),
}));

vi.mock("../shared/common", () => ({
  execCapture: execCaptureMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveSerenaPaths", () => {
  it("resolves default baseline and data paths under Serena root", () => {
    expect(resolveSerenaPaths("/repo")).toEqual({
      rootDir: path.join("/repo", ".pourkit", "serena"),
      baselineWorktreePath: path.join(
        "/repo",
        ".pourkit",
        "serena",
        "baseline",
        "active-repo"
      ),
      dataDir: path.join("/repo", ".pourkit", "serena", "data"),
    });
  });
});

describe("refreshSerenaBaseline", () => {
  it("fetches and detaches target base branch in baseline cwd", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "pourkit-serena-"));
    const baselinePaths = resolveSerenaPaths(repoRoot);
    await mkdir(baselinePaths.baselineWorktreePath, { recursive: true });
    const chdirSpy = vi.spyOn(process, "chdir");

    execCaptureMock.mockImplementation(
      async (command: string, args: string[], options?: { cwd?: string }) => {
        expect(options?.cwd).toBe(baselinePaths.baselineWorktreePath);

        if (command !== "git") {
          throw new Error(`Unexpected command: ${command}`);
        }

        const key = args.join(" ");
        switch (key) {
          case "rev-parse --is-inside-work-tree":
          case "rev-parse --show-toplevel":
            return {
              code: 0,
              stdout: `${baselinePaths.baselineWorktreePath}\n`,
              stderr: "",
            };
          case "fetch origin dev":
            return { code: 0, stdout: "", stderr: "" };
          case "checkout --detach origin/dev":
            return { code: 0, stdout: "", stderr: "" };
          case "rev-parse HEAD":
          case "rev-parse origin/dev":
            return { code: 0, stdout: "abc123\n", stderr: "" };
          default:
            throw new Error(`Unexpected git args: ${key}`);
        }
      }
    );

    const status = await refreshSerenaBaseline({
      repoRoot,
      baseBranch: "dev",
    });

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["fetch", "origin", "dev"],
      expect.objectContaining({ cwd: baselinePaths.baselineWorktreePath })
    );
    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["checkout", "--detach", "origin/dev"],
      expect.objectContaining({ cwd: baselinePaths.baselineWorktreePath })
    );
    expect(chdirSpy).not.toHaveBeenCalled();
    expect(status).toEqual({
      exists: true,
      baselineWorktreePath: baselinePaths.baselineWorktreePath,
      currentCommit: "abc123",
      expectedRef: "origin/dev",
      fresh: true,
    });

    chdirSpy.mockRestore();
  });

  it("does not let a local branch named main override target baseBranch dev", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "pourkit-serena-"));
    const baselinePaths = resolveSerenaPaths(repoRoot);
    await mkdir(baselinePaths.baselineWorktreePath, { recursive: true });
    const chdirSpy = vi.spyOn(process, "chdir");

    execCaptureMock.mockImplementation(
      async (command: string, args: string[], options?: { cwd?: string }) => {
        expect(command).toBe("git");
        expect(options?.cwd).toBe(baselinePaths.baselineWorktreePath);

        const key = args.join(" ");
        switch (key) {
          case "rev-parse --is-inside-work-tree":
          case "rev-parse --show-toplevel":
            return {
              code: 0,
              stdout: `${baselinePaths.baselineWorktreePath}\n`,
              stderr: "",
            };
          case "rev-parse --abbrev-ref HEAD":
            return { code: 0, stdout: "main\n", stderr: "" };
          case "branch --list":
            return { code: 0, stdout: "main\n", stderr: "" };
          case "fetch origin dev":
            return { code: 0, stdout: "", stderr: "" };
          case "checkout --detach origin/dev":
            return { code: 0, stdout: "", stderr: "" };
          case "rev-parse HEAD":
          case "rev-parse origin/dev":
            return { code: 0, stdout: "abc123\n", stderr: "" };
          default:
            throw new Error(`Unexpected git args: ${key}`);
        }
      }
    );

    const status = await refreshSerenaBaseline({
      repoRoot,
      baseBranch: "dev",
    });

    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["fetch", "origin", "dev"],
      expect.objectContaining({ cwd: baselinePaths.baselineWorktreePath })
    );
    expect(execCaptureMock).toHaveBeenCalledWith(
      "git",
      ["checkout", "--detach", "origin/dev"],
      expect.objectContaining({ cwd: baselinePaths.baselineWorktreePath })
    );
    const checkoutCalls = execCaptureMock.mock.calls.filter(
      (c: unknown[]) =>
        c[0] === "git" && Array.isArray(c[1]) && c[1][0] === "checkout"
    );
    for (const call of checkoutCalls) {
      expect((call[1] as string[]).join(" ")).not.toMatch(/\bmain\b/);
    }
    expect(chdirSpy).not.toHaveBeenCalled();
    expect(status).toEqual({
      exists: true,
      baselineWorktreePath: baselinePaths.baselineWorktreePath,
      currentCommit: "abc123",
      expectedRef: "origin/dev",
      fresh: true,
    });

    chdirSpy.mockRestore();
  });
});

describe("getSerenaBaselineStatus", () => {
  it("reports stale when HEAD differs from target base ref", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "pourkit-serena-"));
    const baselinePaths = resolveSerenaPaths(repoRoot);
    await mkdir(baselinePaths.baselineWorktreePath, { recursive: true });

    execCaptureMock.mockImplementation(
      async (command: string, args: string[], options?: { cwd?: string }) => {
        expect(options?.cwd).toBe(baselinePaths.baselineWorktreePath);

        if (command !== "git") {
          throw new Error(`Unexpected command: ${command}`);
        }

        const key = args.join(" ");
        switch (key) {
          case "rev-parse --is-inside-work-tree":
          case "rev-parse --show-toplevel":
            return {
              code: 0,
              stdout: `${baselinePaths.baselineWorktreePath}\n`,
              stderr: "",
            };
          case "rev-parse HEAD":
            return { code: 0, stdout: "abc123\n", stderr: "" };
          case "rev-parse origin/dev":
            return { code: 0, stdout: "def456\n", stderr: "" };
          default:
            throw new Error(`Unexpected git args: ${key}`);
        }
      }
    );

    expect(
      await getSerenaBaselineStatus({ repoRoot, baseBranch: "dev" })
    ).toEqual({
      exists: true,
      baselineWorktreePath: baselinePaths.baselineWorktreePath,
      currentCommit: "abc123",
      expectedRef: "origin/dev",
      fresh: false,
    });
  });
});

describe("ensureBaselineWorktree", () => {
  it("rejects plain nested directory that only shares repo ancestry", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "pourkit-serena-"));
    const baselinePaths = resolveSerenaPaths(repoRoot);
    await mkdir(baselinePaths.baselineWorktreePath, { recursive: true });

    execCaptureMock.mockImplementation(
      async (command: string, args: string[], options?: { cwd?: string }) => {
        expect(command).toBe("git");
        expect(options?.cwd).toBe(baselinePaths.baselineWorktreePath);
        expect(args).toEqual(["rev-parse", "--show-toplevel"]);
        return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
      }
    );

    await expect(ensureBaselineWorktree({ repoRoot })).rejects.toThrow(
      "Serena baseline worktree exists but is not a git repo"
    );
  });

  it("clones baseline checkout when it does not exist yet", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "pourkit-serena-"));
    const baselinePaths = resolveSerenaPaths(repoRoot);

    execCaptureMock.mockImplementation(
      async (command: string, args: string[], options?: { cwd?: string }) => {
        expect(command).toBe("git");
        expect(options?.cwd).toBe(repoRoot);
        expect(args).toEqual([
          "clone",
          repoRoot,
          baselinePaths.baselineWorktreePath,
        ]);
        return { code: 0, stdout: "", stderr: "" };
      }
    );

    await expect(ensureBaselineWorktree({ repoRoot })).resolves.toEqual(
      baselinePaths
    );
  });
});
