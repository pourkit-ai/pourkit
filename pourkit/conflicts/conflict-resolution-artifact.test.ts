import { describe, it, expect } from "vitest";
import {
  parseConflictResolutionArtifact,
  ConflictResolutionArtifactProtocolError,
} from "./conflict-resolution-artifact";

function validResolvedOutput(): string {
  return [
    "## Status",
    "",
    "resolved",
    "",
    "## Summary",
    "",
    "- Preserved latest baseBranch behavior.",
    "- Reapplied compatible issue work.",
    "",
    "## Files",
    "",
    "- `src/foo.ts`",
    "",
    "<conflict-resolution>resolved</conflict-resolution>",
  ].join("\n");
}

function validAmbiguousOutput(): string {
  return [
    "## Status",
    "",
    "ambiguous",
    "",
    "## Summary",
    "",
    "- Changes conflict with base branch changes.",
    "",
    "## Files",
    "",
    "- `src/bar.ts`",
    "",
    "<conflict-resolution>ambiguous</conflict-resolution>",
  ].join("\n");
}

describe("parseConflictResolutionArtifact", () => {
  it("parses valid resolved artifact", () => {
    const result = parseConflictResolutionArtifact(validResolvedOutput());
    expect(result.status).toBe("resolved");
    expect(result.summary).toContain("Preserved latest baseBranch behavior");
    expect(result.files).toContain("src/foo.ts");
  });

  it("parses valid ambiguous artifact", () => {
    const result = parseConflictResolutionArtifact(validAmbiguousOutput());
    expect(result.status).toBe("ambiguous");
    expect(result.summary).toContain("Changes conflict");
    expect(result.files).toContain("src/bar.ts");
  });

  it("exposes raw output", () => {
    const output = validResolvedOutput();
    const result = parseConflictResolutionArtifact(output);
    expect(result.raw).toBe(output);
  });

  it("rejects empty output", () => {
    expect(() => parseConflictResolutionArtifact("")).toThrow(
      ConflictResolutionArtifactProtocolError
    );
  });

  it("rejects output with missing status section", () => {
    const output = [
      "## Summary",
      "",
      "- Something.",
      "",
      "## Files",
      "",
      "- `src/foo.ts`",
      "",
      "<conflict-resolution>resolved</conflict-resolution>",
    ].join("\n");
    expect(() => parseConflictResolutionArtifact(output)).toThrow(
      ConflictResolutionArtifactProtocolError
    );
  });

  it("rejects output with unsupported status", () => {
    const output = [
      "## Status",
      "",
      "done",
      "",
      "## Summary",
      "",
      "- Something.",
      "",
      "## Files",
      "",
      "- `src/foo.ts`",
      "",
      "<conflict-resolution>done</conflict-resolution>",
    ].join("\n");
    expect(() => parseConflictResolutionArtifact(output)).toThrow(
      ConflictResolutionArtifactProtocolError
    );
  });

  it("rejects output with missing conflict-resolution marker", () => {
    const output = [
      "## Status",
      "",
      "resolved",
      "",
      "## Summary",
      "",
      "- Something.",
      "",
      "## Files",
      "",
      "- `src/foo.ts`",
    ].join("\n");
    expect(() => parseConflictResolutionArtifact(output)).toThrow(
      ConflictResolutionArtifactProtocolError
    );
  });

  it("rejects output with mismatched status and marker", () => {
    const output = [
      "## Status",
      "",
      "resolved",
      "",
      "## Summary",
      "",
      "- Something.",
      "",
      "## Files",
      "",
      "- `src/foo.ts`",
      "",
      "<conflict-resolution>ambiguous</conflict-resolution>",
    ].join("\n");
    expect(() => parseConflictResolutionArtifact(output)).toThrow(
      ConflictResolutionArtifactProtocolError
    );
  });

  it("rejects output with missing summary section", () => {
    const output = [
      "## Status",
      "",
      "resolved",
      "",
      "## Files",
      "",
      "- `src/foo.ts`",
      "",
      "<conflict-resolution>resolved</conflict-resolution>",
    ].join("\n");
    expect(() => parseConflictResolutionArtifact(output)).toThrow(
      ConflictResolutionArtifactProtocolError
    );
  });

  it("rejects output with missing files section", () => {
    const output = [
      "## Status",
      "",
      "resolved",
      "",
      "## Summary",
      "",
      "- Something.",
      "",
      "<conflict-resolution>resolved</conflict-resolution>",
    ].join("\n");
    expect(() => parseConflictResolutionArtifact(output)).toThrow(
      ConflictResolutionArtifactProtocolError
    );
  });

  it("rejects output with duplicate status sections", () => {
    const output = [
      "## Status",
      "",
      "resolved",
      "",
      "## Status",
      "",
      "ambiguous",
      "",
      "## Summary",
      "",
      "- Something.",
      "",
      "## Files",
      "",
      "- `src/foo.ts`",
      "",
      "<conflict-resolution>resolved</conflict-resolution>",
    ].join("\n");
    expect(() => parseConflictResolutionArtifact(output)).toThrow(
      ConflictResolutionArtifactProtocolError
    );
  });

  it("rejects output with duplicate summary sections", () => {
    const output = [
      "## Status",
      "",
      "resolved",
      "",
      "## Summary",
      "",
      "- First summary.",
      "",
      "## Summary",
      "",
      "- Second summary.",
      "",
      "## Files",
      "",
      "- `src/foo.ts`",
      "",
      "<conflict-resolution>resolved</conflict-resolution>",
    ].join("\n");
    expect(() => parseConflictResolutionArtifact(output)).toThrow(
      ConflictResolutionArtifactProtocolError
    );
  });

  it("rejects output with duplicate files sections", () => {
    const output = [
      "## Status",
      "",
      "resolved",
      "",
      "## Summary",
      "",
      "- Something.",
      "",
      "## Files",
      "",
      "- `src/foo.ts`",
      "",
      "## Files",
      "",
      "- `src/bar.ts`",
      "",
      "<conflict-resolution>resolved</conflict-resolution>",
    ].join("\n");
    expect(() => parseConflictResolutionArtifact(output)).toThrow(
      ConflictResolutionArtifactProtocolError
    );
  });

  it("rejects output with duplicate conflict-resolution markers (same status)", () => {
    const output = [
      "## Status",
      "",
      "resolved",
      "",
      "## Summary",
      "",
      "- Something.",
      "",
      "## Files",
      "",
      "- `src/foo.ts`",
      "",
      "<conflict-resolution>resolved</conflict-resolution>",
      "",
      "<conflict-resolution>resolved</conflict-resolution>",
    ].join("\n");
    expect(() => parseConflictResolutionArtifact(output)).toThrow(
      ConflictResolutionArtifactProtocolError
    );
  });

  it("rejects output with duplicate conflict-resolution markers (conflicting status)", () => {
    const output = [
      "## Status",
      "",
      "resolved",
      "",
      "## Summary",
      "",
      "- Something.",
      "",
      "## Files",
      "",
      "- `src/foo.ts`",
      "",
      "<conflict-resolution>resolved</conflict-resolution>",
      "",
      "<conflict-resolution>ambiguous</conflict-resolution>",
    ].join("\n");
    expect(() => parseConflictResolutionArtifact(output)).toThrow(
      ConflictResolutionArtifactProtocolError
    );
  });

  it("parses artifact with optional verification section", () => {
    const output = [
      "## Status",
      "",
      "resolved",
      "",
      "## Summary",
      "",
      "- Preserved latest baseBranch behavior.",
      "",
      "## Files",
      "",
      "- `src/foo.ts`",
      "",
      "## Verification",
      "",
      "| Command | Result | Notes |",
      "|---------|--------|-------|",
      "| npm test | passed | All tests pass |",
      "| npm run typecheck | passed | No type errors |",
      "",
      "<conflict-resolution>resolved</conflict-resolution>",
    ].join("\n");
    const result = parseConflictResolutionArtifact(output);
    expect(result.status).toBe("resolved");
    expect(result.files).toEqual(["src/foo.ts"]);
    expect(result.verification).toBeDefined();
    expect(result.verification).toHaveLength(2);
    expect(result.verification![0]).toEqual({
      command: "npm test",
      result: "passed",
      notes: "All tests pass",
    });
    expect(result.verification![1]).toEqual({
      command: "npm run typecheck",
      result: "passed",
      notes: "No type errors",
    });
  });

  it("parses artifact without verification section when not present", () => {
    const result = parseConflictResolutionArtifact(validResolvedOutput());
    expect(result.verification).toBeUndefined();
  });

  it("parses artifact with empty verification table", () => {
    const output = [
      "## Status",
      "",
      "resolved",
      "",
      "## Summary",
      "",
      "- Preserved latest baseBranch behavior.",
      "",
      "## Files",
      "",
      "- `src/foo.ts`",
      "",
      "## Verification",
      "",
      "| Command | Result | Notes |",
      "|---------|--------|-------|",
      "",
      "<conflict-resolution>resolved</conflict-resolution>",
    ].join("\n");
    const result = parseConflictResolutionArtifact(output);
    expect(result.verification).toEqual([]);
  });
});
