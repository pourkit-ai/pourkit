import { beforeEach, describe, expect, it, vi } from "vitest";

const execCaptureMock = vi.hoisted(() => vi.fn());
const sandboxImageNameMock = vi.hoisted(() => vi.fn());

vi.mock("../shared/common", () => ({
  execCapture: execCaptureMock,
}));

vi.mock("./sandbox-image", () => ({
  sandboxImageName: sandboxImageNameMock,
}));

import { ensureSandboxImageBuilt } from "./sandbox-image-build";

describe("ensureSandboxImageBuilt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sandboxImageNameMock.mockReturnValue("sandcastle:test-image");
  });

  it("returns without building when the image already exists", async () => {
    execCaptureMock.mockResolvedValue(undefined);

    await ensureSandboxImageBuilt("/repo");

    expect(execCaptureMock).toHaveBeenCalledTimes(1);
    expect(execCaptureMock).toHaveBeenCalledWith("docker", [
      "image",
      "inspect",
      "sandcastle:test-image",
    ]);
  });

  it("builds without cache-busting flags when the image is missing", async () => {
    execCaptureMock
      .mockRejectedValueOnce(new Error("missing image"))
      .mockResolvedValueOnce(undefined);

    await ensureSandboxImageBuilt("/repo");

    expect(execCaptureMock).toHaveBeenCalledTimes(2);
    expect(execCaptureMock).toHaveBeenLastCalledWith("docker", [
      "build",
      "-t",
      "sandcastle:test-image",
      "-f",
      "/repo/.sandcastle/Dockerfile",
      "/repo",
    ]);
  });

  it("force rebuilds with pull and no-cache flags", async () => {
    execCaptureMock.mockResolvedValue(undefined);

    await ensureSandboxImageBuilt("/repo", { force: true });

    expect(execCaptureMock).toHaveBeenCalledTimes(1);
    expect(execCaptureMock).toHaveBeenCalledWith("docker", [
      "build",
      "-t",
      "sandcastle:test-image",
      "-f",
      "/repo/.sandcastle/Dockerfile",
      "--pull",
      "--no-cache",
      "/repo",
    ]);
  });
});
