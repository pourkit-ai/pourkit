import { describe, expect, it } from "vitest";
import {
  detectChangesetFiles,
  detectBypassLabel,
  checkChangesetRequired,
  getChangedFiles,
} from "./check-changeset-required";

describe("detectChangesetFiles", () => {
  it("passes when a changeset file is in the changed files list", () => {
    const result = detectChangesetFiles([".changeset/sweet-mangoes-yawn.md"]);
    expect(result.ok).toBe(true);
  });

  it("passes when multiple changeset files are in the changed files list", () => {
    const result = detectChangesetFiles([
      ".changeset/calm-geese.md",
      ".changeset/old-stars-twinkle.md",
    ]);
    expect(result.ok).toBe(true);
  });

  it("fails when no changeset files are in the changed files list", () => {
    const result = detectChangesetFiles(["src/index.ts", "package.json"]);
    expect(result.ok).toBe(false);
  });

  it("ignores config.json in .changeset directory", () => {
    const result = detectChangesetFiles([".changeset/config.json"]);
    expect(result.ok).toBe(false);
  });
});

describe("detectBypassLabel", () => {
  it("passes when the no-changeset-needed label is present", () => {
    const result = detectBypassLabel(["no-changeset-needed"]);
    expect(result.ok).toBe(true);
  });

  it("passes when the bypass label is among multiple labels", () => {
    const result = detectBypassLabel([
      "bug",
      "no-changeset-needed",
      "enhancement",
    ]);
    expect(result.ok).toBe(true);
  });

  it("fails when the bypass label is not present", () => {
    const result = detectBypassLabel(["bug", "enhancement"]);
    expect(result.ok).toBe(false);
  });

  it("fails when the labels list is empty", () => {
    const result = detectBypassLabel([]);
    expect(result.ok).toBe(false);
  });
});

describe("checkChangesetRequired", () => {
  it("passes with a changeset file and no bypass label", () => {
    const result = checkChangesetRequired(
      [".changeset/sweet-mangoes-yawn.md"],
      ["bug"]
    );
    expect(result.ok).toBe(true);
  });

  it("passes with bypass label and no changeset file", () => {
    const result = checkChangesetRequired(
      ["src/index.ts"],
      ["no-changeset-needed"]
    );
    expect(result.ok).toBe(true);
  });

  it("fails with no changeset file and no bypass label", () => {
    const result = checkChangesetRequired(
      ["src/index.ts", "package.json"],
      ["bug", "enhancement"]
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("npx changeset");
    expect(result.message).toContain("no-changeset-needed");
  });
});

describe("getChangedFiles", () => {
  it("returns an array of strings without throwing", () => {
    expect(() => getChangedFiles()).not.toThrow();
    const files = getChangedFiles();
    expect(Array.isArray(files)).toBe(true);
    for (const f of files) {
      expect(typeof f).toBe("string");
      expect(f.length).toBeGreaterThan(0);
    }
  });
});
