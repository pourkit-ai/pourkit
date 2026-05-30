import { describe, expect, it } from "vitest";
import {
  buildSerenaOpenCodeConfig,
  isSerenaEligibleStage,
} from "./opencode-config";

describe("isSerenaEligibleStage", () => {
  it("only enables Serena for builder and refactor stages", () => {
    expect(isSerenaEligibleStage("builder")).toBe(true);
    expect(isSerenaEligibleStage("refactor")).toBe(true);
    expect(isSerenaEligibleStage("reviewer")).toBe(false);
    expect(isSerenaEligibleStage("finalizer")).toBe(false);
    expect(isSerenaEligibleStage("conflictResolution")).toBe(false);
  });
});

describe("buildSerenaOpenCodeConfig", () => {
  it("builds remote Serena MCP config for eligible stages", () => {
    expect(
      buildSerenaOpenCodeConfig("builder", {
        available: true,
        sandboxMcpUrl: "http://sandbox.example/mcp",
      })
    ).toEqual({
      mcp: {
        serena: {
          type: "remote",
          url: "http://sandbox.example/mcp",
          enabled: true,
        },
      },
    });
  });

  it("skips Serena when stage is not eligible or unavailable", () => {
    expect(
      buildSerenaOpenCodeConfig("reviewer", {
        available: true,
        sandboxMcpUrl: "http://sandbox.example/mcp",
      })
    ).toBeUndefined();

    expect(
      buildSerenaOpenCodeConfig("builder", {
        available: false,
        sandboxMcpUrl: "http://sandbox.example/mcp",
      })
    ).toBeUndefined();
  });
});
