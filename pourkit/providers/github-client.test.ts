import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  resolveGitHubToken,
  resolveGitHubRepository,
  tryCreateGitHubClient,
} from "./github-client";

const { execCaptureMock } = vi.hoisted(() => ({
  execCaptureMock: vi.fn(),
}));

vi.mock("../shared/common", () => ({
  execCapture: execCaptureMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  execCaptureMock.mockRejectedValue(new Error("no git remote"));
  delete process.env.GITHUB_REPOSITORY;
});

describe("resolveGitHubToken", () => {
  it("returns POURKIT_GITHUB_TOKEN when all three env vars are set", () => {
    const token = resolveGitHubToken({
      POURKIT_GITHUB_TOKEN: "pourkit-token",
      GH_TOKEN: "gh-token",
      GITHUB_TOKEN: "github-token",
    });
    expect(token).toBe("pourkit-token");
  });

  it("falls back to GH_TOKEN when POURKIT_GITHUB_TOKEN is not set", () => {
    const token = resolveGitHubToken({
      GH_TOKEN: "gh-token",
      GITHUB_TOKEN: "github-token",
    });
    expect(token).toBe("gh-token");
  });

  it("falls back to GITHUB_TOKEN when higher precedence vars are not set", () => {
    const token = resolveGitHubToken({
      GITHUB_TOKEN: "github-token",
    });
    expect(token).toBe("github-token");
  });

  it("throws when no token is present", () => {
    expect(() => resolveGitHubToken({})).toThrow("GitHub token is required");
  });
});

describe("resolveGitHubRepository", () => {
  it("uses explicit repository option when provided", async () => {
    const result = await resolveGitHubRepository({
      repository: "owner/repo",
    });
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("uses GITHUB_REPOSITORY env var when explicit option is not set", async () => {
    const result = await resolveGitHubRepository({
      env: { GITHUB_REPOSITORY: "owner/repo" },
    });
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("prefers GITHUB_REPOSITORY over malformed origin remote", async () => {
    execCaptureMock.mockResolvedValue({
      code: 0,
      stdout: "invalid-remote-url\n",
      stderr: "",
    });

    const result = await resolveGitHubRepository({
      env: { GITHUB_REPOSITORY: "owner/repo" },
    });

    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses repository from origin remote when env vars are not set", async () => {
    execCaptureMock.mockResolvedValue({
      code: 0,
      stdout: "git@github.com:myorg/myrepo.git\n",
      stderr: "",
    });

    const result = await resolveGitHubRepository();
    expect(result).toEqual({ owner: "myorg", repo: "myrepo" });
  });

  it("parses https origin remote format", async () => {
    execCaptureMock.mockResolvedValue({
      code: 0,
      stdout: "https://github.com/foo/bar.git\n",
      stderr: "",
    });

    const result = await resolveGitHubRepository();
    expect(result).toEqual({ owner: "foo", repo: "bar" });
  });

  it("throws when repository option has invalid format", async () => {
    await expect(
      resolveGitHubRepository({ repository: "invalid" })
    ).rejects.toThrow("Invalid repository format");
  });

  it("throws invalid-repository error when GITHUB_REPOSITORY has invalid format", async () => {
    await expect(
      resolveGitHubRepository({
        env: { GITHUB_REPOSITORY: "no-slash-here" },
      })
    ).rejects.toThrow("Invalid repository format");
  });

  it("throws invalid-repository error when GITHUB_REPOSITORY is malformed even with valid origin remote", async () => {
    execCaptureMock.mockResolvedValue({
      code: 0,
      stdout: "git@github.com:myorg/myrepo.git\n",
      stderr: "",
    });

    await expect(
      resolveGitHubRepository({
        env: { GITHUB_REPOSITORY: "no-slash-here" },
      })
    ).rejects.toThrow("Invalid repository format");
  });

  it("parses repository from origin remote when GITHUB_REPOSITORY is not set and origin remote has dotted repo name", async () => {
    execCaptureMock.mockResolvedValue({
      code: 0,
      stdout: "git@github.com:myorg/my.repo.git\n",
      stderr: "",
    });

    const result = await resolveGitHubRepository();
    expect(result).toEqual({ owner: "myorg", repo: "my.repo" });
  });

  it("parses repository from https origin remote with dotted repo name", async () => {
    execCaptureMock.mockResolvedValue({
      code: 0,
      stdout: "https://github.com/foo/bar.baz.git\n",
      stderr: "",
    });

    const result = await resolveGitHubRepository();
    expect(result).toEqual({ owner: "foo", repo: "bar.baz" });
  });

  it("throws when no repository can be resolved", async () => {
    execCaptureMock.mockRejectedValue(new Error("no git remote"));

    await expect(resolveGitHubRepository()).rejects.toThrow(
      "Could not resolve GitHub repository"
    );
  });

  it("reads process.env.GITHUB_REPOSITORY when options.env is absent", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    const result = await resolveGitHubRepository();
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("prefers process.env.GITHUB_REPOSITORY over origin remote when options.env is absent", async () => {
    execCaptureMock.mockResolvedValue({
      code: 0,
      stdout: "git@github.com:wrong/wrong.git\n",
      stderr: "",
    });

    process.env.GITHUB_REPOSITORY = "owner/repo";
    const result = await resolveGitHubRepository();
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });
});

describe("tryCreateGitHubClient", () => {
  it("returns invalid-repository when GITHUB_REPOSITORY is malformed", async () => {
    const result = await tryCreateGitHubClient({
      env: {
        POURKIT_GITHUB_TOKEN: "token",
        GITHUB_REPOSITORY: "no-slash-here",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-repository");
    }
  });

  it("returns invalid-repository when GITHUB_REPOSITORY is malformed even with valid origin remote", async () => {
    execCaptureMock.mockResolvedValue({
      code: 0,
      stdout: "git@github.com:myorg/myrepo.git\n",
      stderr: "",
    });

    const result = await tryCreateGitHubClient({
      env: {
        POURKIT_GITHUB_TOKEN: "token",
        GITHUB_REPOSITORY: "no-slash-here",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-repository");
    }
  });
});
