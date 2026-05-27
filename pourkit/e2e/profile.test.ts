import { describe, it, expect } from "vitest";
import {
  getVerificationCommands,
  composeFailureWithProfile,
  type E2EVerificationProfile,
} from "./profile";
import type { VerificationCommand } from "../shared/config";

describe("getVerificationCommands", () => {
  const baseCommands: VerificationCommand[] = [
    { command: "npm run typecheck", label: "typecheck" },
    { command: "npm run test", label: "tests" },
  ];

  it("returns base commands for fast profile", () => {
    const result = getVerificationCommands(baseCommands, "fast");
    expect(result).toEqual(baseCommands);
  });

  it("returns full-check commands for full-check profile", () => {
    const result = getVerificationCommands(baseCommands, "full-check");
    expect(result).toEqual([
      { command: "npm run prettier:check", label: "prettier:check" },
      { command: "npm run typecheck", label: "typecheck" },
      { command: "npm run test", label: "tests" },
      { command: "npm run build", label: "build" },
    ]);
  });

  it("returns exit 1 command for failure profile", () => {
    const result = getVerificationCommands(baseCommands, "failure");
    expect(result).toEqual([{ command: "exit 1", label: "fail-e2e" }]);
  });

  it("does not mutate the input array", () => {
    const original = [...baseCommands];
    getVerificationCommands(baseCommands, "failure");
    expect(baseCommands).toEqual(original);
  });

  it("returns commands that conform to VerificationCommand shape", () => {
    for (const profile of [
      "fast",
      "full-check",
      "failure",
    ] as E2EVerificationProfile[]) {
      const result = getVerificationCommands(baseCommands, profile);
      for (const cmd of result) {
        expect(cmd).toHaveProperty("command");
        expect(typeof cmd.command).toBe("string");
        expect(cmd.command.length).toBeGreaterThan(0);
        expect(cmd).toHaveProperty("label");
        expect(typeof cmd.label).toBe("string");
        expect(cmd.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("handles empty base commands", () => {
    const fast = getVerificationCommands([], "fast");
    expect(fast).toEqual([]);

    const full = getVerificationCommands([], "full-check");
    expect(full).toEqual([
      { command: "npm run prettier:check", label: "prettier:check" },
      { command: "npm run typecheck", label: "typecheck" },
      { command: "npm run test", label: "tests" },
      { command: "npm run build", label: "build" },
    ]);

    const fail = getVerificationCommands([], "failure");
    expect(fail).toEqual([{ command: "exit 1", label: "fail-e2e" }]);
  });
});

describe("full-check profile contents and order", () => {
  const baseCommands: VerificationCommand[] = [
    { command: "npm run typecheck", label: "typecheck" },
    { command: "npm run test", label: "tests" },
  ];

  it("includes npm run prettier:check", () => {
    const result = getVerificationCommands(baseCommands, "full-check");
    expect(result.some((c) => c.command === "npm run prettier:check")).toBe(
      true
    );
  });

  it("includes npm run typecheck", () => {
    const result = getVerificationCommands(baseCommands, "full-check");
    expect(result.some((c) => c.command === "npm run typecheck")).toBe(true);
  });

  it("includes npm run test", () => {
    const result = getVerificationCommands(baseCommands, "full-check");
    expect(result.some((c) => c.command === "npm run test")).toBe(true);
  });

  it("includes npm run build", () => {
    const result = getVerificationCommands(baseCommands, "full-check");
    expect(result.some((c) => c.command === "npm run build")).toBe(true);
  });

  it("returns exactly four commands", () => {
    const result = getVerificationCommands(baseCommands, "full-check");
    expect(result).toHaveLength(4);
  });

  it("returns commands in stable order", () => {
    const first = getVerificationCommands(baseCommands, "full-check");
    const second = getVerificationCommands(baseCommands, "full-check");
    const third = getVerificationCommands(baseCommands, "full-check");
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it("returns commands in prettier, typecheck, test, build order", () => {
    const result = getVerificationCommands(baseCommands, "full-check");
    expect(result.map((c) => c.label)).toEqual([
      "prettier:check",
      "typecheck",
      "tests",
      "build",
    ]);
  });

  it("differs from fast profile in command count", () => {
    const fast = getVerificationCommands(baseCommands, "fast");
    const full = getVerificationCommands(baseCommands, "full-check");
    expect(full).not.toEqual(fast);
    expect(full.length).toBeGreaterThan(fast.length);
  });

  it("differs from fast profile in command set", () => {
    const fast = getVerificationCommands(baseCommands, "fast");
    const full = getVerificationCommands(baseCommands, "full-check");
    const fastCommands = new Set(fast.map((c) => c.command));
    const fullCommands = new Set(full.map((c) => c.command));
    expect(fastCommands).not.toEqual(fullCommands);
    expect(fullCommands.has("npm run prettier:check")).toBe(true);
    expect(fullCommands.has("npm run build")).toBe(true);
    expect(fastCommands.has("npm run prettier:check")).toBe(false);
    expect(fastCommands.has("npm run build")).toBe(false);
  });
});

describe("composeFailureWithProfile", () => {
  const baseCommands: VerificationCommand[] = [
    { command: "npm run typecheck", label: "typecheck" },
    { command: "npm run test", label: "tests" },
  ];

  it("prepends exit 1 to fast profile commands", () => {
    const result = composeFailureWithProfile(baseCommands, "fast");
    expect(result[0]).toEqual({ command: "exit 1", label: "fail-e2e" });
    expect(result.slice(1)).toEqual(baseCommands);
  });

  it("prepends exit 1 to full-check profile commands", () => {
    const result = composeFailureWithProfile(baseCommands, "full-check");
    expect(result[0]).toEqual({ command: "exit 1", label: "fail-e2e" });
    expect(result.slice(1)).toEqual([
      { command: "npm run prettier:check", label: "prettier:check" },
      { command: "npm run typecheck", label: "typecheck" },
      { command: "npm run test", label: "tests" },
      { command: "npm run build", label: "build" },
    ]);
  });

  it("always fails before any profile command runs", () => {
    for (const profile of ["fast", "full-check"] as E2EVerificationProfile[]) {
      const result = composeFailureWithProfile(baseCommands, profile);
      expect(result[0].command).toBe("exit 1");
      expect(result.length).toBeGreaterThan(1);
    }
  });

  it("does not mutate the input array", () => {
    const original = [...baseCommands];
    composeFailureWithProfile(baseCommands, "fast");
    expect(baseCommands).toEqual(original);
  });

  it("returns commands that conform to VerificationCommand shape", () => {
    for (const profile of ["fast", "full-check"] as E2EVerificationProfile[]) {
      const result = composeFailureWithProfile(baseCommands, profile);
      for (const cmd of result) {
        expect(cmd).toHaveProperty("command");
        expect(typeof cmd.command).toBe("string");
        expect(cmd.command.length).toBeGreaterThan(0);
        expect(cmd).toHaveProperty("label");
        expect(typeof cmd.label).toBe("string");
        expect(cmd.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("handles empty base commands", () => {
    const fast = composeFailureWithProfile([], "fast");
    expect(fast).toEqual([{ command: "exit 1", label: "fail-e2e" }]);

    const full = composeFailureWithProfile([], "full-check");
    expect(full[0]).toEqual({ command: "exit 1", label: "fail-e2e" });
    expect(full.length).toBeGreaterThan(1);
  });
});
