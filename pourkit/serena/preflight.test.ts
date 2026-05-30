import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSerenaForTarget } from "./preflight";

const {
  ensureBaselineWorktreeMock,
  refreshSerenaBaselineMock,
  prepareSerenaSidecarConfigMock,
  getSerenaSidecarStatusMock,
  startSerenaSidecarMock,
} = vi.hoisted(() => ({
  ensureBaselineWorktreeMock: vi.fn(),
  refreshSerenaBaselineMock: vi.fn(),
  prepareSerenaSidecarConfigMock: vi.fn(),
  getSerenaSidecarStatusMock: vi.fn(),
  startSerenaSidecarMock: vi.fn(),
}));

vi.mock("./baseline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./baseline")>();
  return {
    ...actual,
    ensureBaselineWorktree: ensureBaselineWorktreeMock,
    refreshSerenaBaseline: refreshSerenaBaselineMock,
  };
});

vi.mock("./container", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./container")>();
  return {
    ...actual,
    prepareSerenaSidecarConfig: prepareSerenaSidecarConfigMock,
    getSerenaSidecarStatus: getSerenaSidecarStatusMock,
    startSerenaSidecar: startSerenaSidecarMock,
  };
});

function makeLogger() {
  return {
    line: vi.fn(),
    raw: vi.fn(),
    step: vi.fn(),
    status: vi.fn(),
    kv: vi.fn(),
    close: vi.fn(),
  };
}

describe("prepareSerenaForTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips Serena when target is disabled", async () => {
    const result = await prepareSerenaForTarget({
      repoRoot: "/repo",
      targetName: "default",
      baseBranch: "dev",
      dataDir: ".pourkit/serena/",
      enabled: false,
      required: false,
      autoStart: false,
      logger: makeLogger(),
    });

    expect(result).toEqual({ enabled: false });
    expect(ensureBaselineWorktreeMock).not.toHaveBeenCalled();
    expect(refreshSerenaBaselineMock).not.toHaveBeenCalled();
    expect(startSerenaSidecarMock).not.toHaveBeenCalled();
  });

  it("starts Serena and refreshes baseline when autoStart is on", async () => {
    const paths = {
      rootDir: "/repo/.pourkit/serena",
      baselineWorktreePath: "/repo/.pourkit/serena/baseline/active-repo",
      dataDir: "/repo/.pourkit/serena/data",
    };

    ensureBaselineWorktreeMock.mockResolvedValue(paths);
    prepareSerenaSidecarConfigMock.mockResolvedValue(undefined);
    startSerenaSidecarMock.mockResolvedValue({
      running: true,
      mcpUrl: "http://localhost:9121/mcp",
      dashboardUrl: "http://localhost:24282",
      containerName: "pourkit-serena-sidecar",
    });
    refreshSerenaBaselineMock.mockResolvedValue({
      exists: true,
      baselineWorktreePath: paths.baselineWorktreePath,
      currentCommit: "abc123",
      expectedRef: "origin/dev",
      fresh: true,
    });

    const result = await prepareSerenaForTarget({
      repoRoot: "/repo",
      targetName: "default",
      baseBranch: "dev",
      dataDir: ".pourkit/serena/",
      enabled: true,
      required: false,
      autoStart: true,
      logger: makeLogger(),
    });

    expect(ensureBaselineWorktreeMock).toHaveBeenCalledWith({
      repoRoot: "/repo",
      dataDir: ".pourkit/serena/",
    });
    expect(prepareSerenaSidecarConfigMock).toHaveBeenCalledWith({
      baselineWorktreePath: paths.baselineWorktreePath,
      dataDir: paths.dataDir,
    });
    expect(startSerenaSidecarMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baselineWorktreePath: paths.baselineWorktreePath,
        dataDir: paths.dataDir,
      })
    );
    expect(refreshSerenaBaselineMock).toHaveBeenCalledWith({
      repoRoot: "/repo",
      dataDir: ".pourkit/serena/",
      baseBranch: "dev",
    });
    expect(result).toEqual({
      enabled: true,
      available: true,
      mcpUrl: "http://localhost:9121/mcp",
    });
  });

  it("returns unavailable when Serena sidecar is not running", async () => {
    const paths = {
      rootDir: "/repo/.pourkit/serena",
      baselineWorktreePath: "/repo/.pourkit/serena/baseline/active-repo",
      dataDir: "/repo/.pourkit/serena/data",
    };

    ensureBaselineWorktreeMock.mockResolvedValue(paths);
    prepareSerenaSidecarConfigMock.mockResolvedValue(undefined);
    getSerenaSidecarStatusMock.mockResolvedValue({
      running: false,
      mcpUrl: "http://localhost:9121/mcp",
      dashboardUrl: "http://localhost:24282",
      containerName: "pourkit-serena-sidecar",
    });

    const result = await prepareSerenaForTarget({
      repoRoot: "/repo",
      targetName: "default",
      baseBranch: "dev",
      dataDir: ".pourkit/serena/",
      enabled: true,
      required: false,
      autoStart: false,
      logger: makeLogger(),
    });

    expect(result).toMatchObject({
      enabled: true,
      available: false,
    });
    expect((result as { error: string }).error).toContain(
      "Serena sidecar is not running"
    );
    expect(refreshSerenaBaselineMock).not.toHaveBeenCalled();
  });
});
