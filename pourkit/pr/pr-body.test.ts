import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildPrBody,
  DEFAULT_MANUAL_PR_BODY,
  ensureClosingRefs,
} from "./pr-body";

const { readFileMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: readFileMock,
  };
});

describe("buildPrBody", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns default body when no custom body is provided", async () => {
    const result = await buildPrBody({
      defaultBody: DEFAULT_MANUAL_PR_BODY,
      options: {},
    });

    expect(result).toContain("## Summary");
    expect(result).toContain("## Changes");
  });

  it("uses --body when provided", async () => {
    const result = await buildPrBody({
      defaultBody: "## Summary\n\nDefault body content",
      options: { body: "Custom body from --body" },
    });

    expect(result).toBe("Custom body from --body");
  });

  it("reads body from --body-file", async () => {
    readFileMock.mockResolvedValue("Body content from file");

    const result = await buildPrBody({
      defaultBody: "## Summary\n\nDefault body content",
      options: { bodyFile: "body.md" },
    });

    expect(result).toBe("Body content from file");
    expect(readFileMock).toHaveBeenCalledWith("body.md", "utf-8");
  });

  it("throws when --body and --body-file are both provided", async () => {
    await expect(
      buildPrBody({
        defaultBody: "## Summary\n\nDefault body content",
        options: {
          body: "Custom body",
          bodyFile: "body.md",
        },
      })
    ).rejects.toThrow("--body and --body-file cannot be used together");
  });

  it("appends closing ref for explicit --issue value", async () => {
    const result = await buildPrBody({
      defaultBody: DEFAULT_MANUAL_PR_BODY,
      options: { issue: 42 },
    });

    expect(result).toContain("## Summary");
    expect(result).toContain("## Changes");
    expect(result).toContain("Closes #42");
  });

  it("does not append footer when no issues are provided", async () => {
    const result = await buildPrBody({
      defaultBody: DEFAULT_MANUAL_PR_BODY,
      options: {},
    });

    expect(result).toContain("## Summary");
    expect(result).not.toContain("Closes #");
  });

  it("does not duplicate closing refs already in custom body", async () => {
    const result = await buildPrBody({
      defaultBody: DEFAULT_MANUAL_PR_BODY,
      options: {
        body: "Custom body\n\nCloses #42",
        issue: 42,
      },
    });

    const closesCount = (result.match(/Closes #42/g) || []).length;
    expect(closesCount).toBe(1);
  });

  it("does not duplicate refs with different closing verbs", async () => {
    const result = await buildPrBody({
      defaultBody: DEFAULT_MANUAL_PR_BODY,
      options: {
        body: "Custom body\n\nFixes #42",
        issue: 42,
      },
    });

    expect(result).toContain("Fixes #42");
    expect(result).not.toContain("Closes #42");
  });

  it("adds only missing refs when issue is already present", async () => {
    const result = await buildPrBody({
      defaultBody: DEFAULT_MANUAL_PR_BODY,
      options: {
        body: "Custom body\n\nCloses #42",
        issue: 42,
      },
    });

    expect(result).toContain("Closes #42");
    const closes42Count = (result.match(/Closes #42/g) || []).length;
    expect(closes42Count).toBe(1);
  });

  it("ignores branch-name content for closing refs", async () => {
    const result = await buildPrBody({
      defaultBody: "Branch: pourkit/42/some-feature",
      options: {},
    });

    expect(result).not.toContain("Closes #42");
  });

  it("handles empty default body", async () => {
    const result = await buildPrBody({
      defaultBody: "",
      options: { issue: 42 },
    });

    expect(result).toBe("\n\nCloses #42");
  });

  it("recognizes resolves keyword as existing ref", async () => {
    const result = await buildPrBody({
      defaultBody: DEFAULT_MANUAL_PR_BODY,
      options: {
        body: "Custom body\n\nResolves #42",
        issue: 42,
      },
    });

    expect(result).not.toContain("Closes #42");
    expect(result).toContain("Resolves #42");
  });

  it("recognizes colon-separated refs", async () => {
    const result = await buildPrBody({
      defaultBody: DEFAULT_MANUAL_PR_BODY,
      options: {
        body: "Custom body\n\nCloses: #42",
        issue: 42,
      },
    });

    const closesCount = (result.match(/Closes: #42/g) || []).length;
    expect(closesCount).toBe(1);
  });
});

describe("ensureClosingRefs", () => {
  it("strips bulletized closing refs", () => {
    const body = [
      "## Summary",
      "",
      "- Why this branch exists.",
      "",
      "## Changes",
      "",
      "- Final net change 1.",
      "- Closes #1202",
      "- Final net change 2.",
    ].join("\n");

    const result = ensureClosingRefs(body, 42);

    expect(result).toContain("## Summary");
    expect(result).toContain("## Changes");
    expect(result).toContain("- Why this branch exists.");
    expect(result).toContain("- Final net change 1.");
    expect(result).toContain("- Final net change 2.");
    expect(result).not.toContain("Closes #1202");
    expect(result).not.toMatch(/- \s*$/m);
    expect(result.match(/Closes #42/g)).toHaveLength(1);
  });
});
