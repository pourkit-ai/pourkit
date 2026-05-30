import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSerenaSidecarStatus,
  indexSerenaProject,
  startSerenaSidecar,
  stopSerenaSidecar,
} from "./container";

const execCaptureMock = vi.hoisted(() => vi.fn());

const sandcastleMocks = vi.hoisted(() => ({
  ensureSandboxImageBuiltMock: vi.fn(),
}));

vi.mock("../shared/common", () => ({
  execCapture: execCaptureMock,
}));

vi.mock("../execution/sandbox-image-build", () => ({
  ensureSandboxImageBuilt: sandcastleMocks.ensureSandboxImageBuiltMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("startSerenaSidecar", () => {
  it("does not invoke Sandcastle image build helper", async () => {
    const options = {
      baselineWorktreePath: "/repo/.pourkit/serena/baseline/active-repo",
      dataDir: "/repo/.pourkit/serena/data",
      mcpPort: 9121,
      dashboardPort: 24282,
      image: "ghcr.io/oraios/serena:latest",
    };

    execCaptureMock.mockImplementation(
      async (command: string, args: string[]) => {
        expect(command).toBe("docker");

        if (args[0] === "inspect") {
          throw new Error("No such container");
        }

        if (args[0] === "run") {
          return { code: 0, stdout: "container-id\n", stderr: "" };
        }

        throw new Error(`Unexpected docker args: ${args.join(" ")}`);
      }
    );

    await startSerenaSidecar(options);

    expect(sandcastleMocks.ensureSandboxImageBuiltMock).not.toHaveBeenCalled();
  });

  it("starts Serena with baseline and data mounts", async () => {
    const options = {
      baselineWorktreePath: "/repo/.pourkit/serena/baseline/active-repo",
      dataDir: "/repo/.pourkit/serena/data",
      mcpPort: 9121,
      dashboardPort: 24282,
      image: "ghcr.io/oraios/serena:latest",
    };

    let started = false;
    execCaptureMock.mockImplementation(
      async (command: string, args: string[]) => {
        expect(command).toBe("docker");

        if (args[0] === "inspect") {
          if (!started) {
            throw new Error("No such container");
          }

          return {
            code: 0,
            stdout: JSON.stringify([{ State: { Running: true } }]),
            stderr: "",
          };
        }

        if (args[0] === "run") {
          started = true;
          expect(args).toContain("ghcr.io/oraios/serena:latest");
          expect(args).toContain(
            "/repo/.pourkit/serena/baseline/active-repo:/workspaces/pourkit"
          );
          expect(args).toContain(
            "/repo/.pourkit/serena/data:/workspaces/serena-data"
          );
          expect(args).toContain("SERENA_HOME=/workspaces/serena-data/config");
          expect(args).toContain("-p");
          expect(args).toContain("9121:9121");
          expect(args).toContain("24282:24282");
          expect(args).toContain("--host");
          expect(args).toContain("0.0.0.0");
          expect(args).toContain("--transport");
          expect(args).toContain("streamable-http");

          return { code: 0, stdout: "container-id\n", stderr: "" };
        }

        throw new Error(`Unexpected docker args: ${args.join(" ")}`);
      }
    );

    await expect(startSerenaSidecar(options)).resolves.toEqual({
      running: true,
      mcpUrl: "http://localhost:9121/mcp",
      dashboardUrl: "http://localhost:24282",
      containerName: "pourkit-serena-sidecar",
    });
  });
});

describe("stopSerenaSidecar", () => {
  it("stops Serena without removing persisted data", async () => {
    const options = {
      baselineWorktreePath: "/repo/.pourkit/serena/baseline/active-repo",
      dataDir: "/repo/.pourkit/serena/data",
      mcpPort: 9121,
      dashboardPort: 24282,
      image: "ghcr.io/oraios/serena:latest",
    };

    execCaptureMock.mockImplementation(
      async (command: string, args: string[]) => {
        expect(command).toBe("docker");

        if (args[0] === "stop") {
          return { code: 0, stdout: "pourkit-serena-sidecar\n", stderr: "" };
        }

        if (args[0] === "inspect") {
          return {
            code: 0,
            stdout: JSON.stringify([{ State: { Running: false } }]),
            stderr: "",
          };
        }

        throw new Error(`Unexpected docker args: ${args.join(" ")}`);
      }
    );

    await expect(stopSerenaSidecar(options)).resolves.toEqual({
      running: false,
      mcpUrl: "http://localhost:9121/mcp",
      dashboardUrl: "http://localhost:24282",
      containerName: "pourkit-serena-sidecar",
    });

    expect(
      execCaptureMock.mock.calls.some(
        ([command, args]) =>
          command === "docker" && Array.isArray(args) && args[0] === "rm"
      )
    ).toBe(false);
  });
});

describe("getSerenaSidecarStatus", () => {
  it("reports running container state from docker inspect", async () => {
    const options = {
      baselineWorktreePath: "/repo/.pourkit/serena/baseline/active-repo",
      dataDir: "/repo/.pourkit/serena/data",
      mcpPort: 9121,
      dashboardPort: 24282,
      image: "ghcr.io/oraios/serena:latest",
    };

    execCaptureMock.mockImplementation(
      async (command: string, args: string[]) => {
        expect(command).toBe("docker");
        expect(args).toEqual(["inspect", "pourkit-serena-sidecar"]);
        return {
          code: 0,
          stdout: JSON.stringify([{ State: { Running: true } }]),
          stderr: "",
        };
      }
    );

    await expect(getSerenaSidecarStatus(options)).resolves.toEqual({
      running: true,
      mcpUrl: "http://localhost:9121/mcp",
      dashboardUrl: "http://localhost:24282",
      containerName: "pourkit-serena-sidecar",
    });
  });

  it("reports configured MCP URL", async () => {
    const options = {
      baselineWorktreePath: "/repo/.pourkit/serena/baseline/active-repo",
      dataDir: "/repo/.pourkit/serena/data",
      mcpPort: 9121,
      dashboardPort: 24282,
      image: "ghcr.io/oraios/serena:latest",
      mcpUrl: "http://serena.example/mcp",
    };

    execCaptureMock.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ State: { Running: true } }]),
      stderr: "",
    });

    await expect(getSerenaSidecarStatus(options)).resolves.toMatchObject({
      mcpUrl: "http://serena.example/mcp",
    });
  });
});

describe("indexSerenaProject", () => {
  it("runs Serena project create index in sidecar", async () => {
    const options = {
      baselineWorktreePath: "/repo/.pourkit/serena/baseline/active-repo",
      dataDir: "/repo/.pourkit/serena/data",
      mcpPort: 9121,
      dashboardPort: 24282,
      image: "ghcr.io/oraios/serena:latest",
    };

    execCaptureMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await indexSerenaProject(options);

    expect(execCaptureMock).toHaveBeenCalledWith("docker", [
      "exec",
      "pourkit-serena-sidecar",
      "serena",
      "project",
      "create",
      "--language",
      "typescript",
      "--index",
      "/workspaces/pourkit",
    ]);
  });
});
