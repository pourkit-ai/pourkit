import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

function repoRoot(): string {
  return path.resolve(__dirname, "../..");
}

function readDoc(relativePath: string): string {
  return readFileSync(path.join(repoRoot(), relativePath), "utf-8");
}

describe("README token precedence contract", () => {
  const readme = readDoc("README.md");

  it("documents token-based GitHub authentication", () => {
    expect(readme).toContain("GitHub Authentication");
  });

  it("documents token precedence", () => {
    expect(readme).toContain("Token precedence");
  });

  it("documents token precedence in correct order", () => {
    expect(readme).toMatch(
      /Token precedence:[\s\S]*?POURKIT_GITHUB_TOKEN[\s\S]*?GH_TOKEN[\s\S]*?GITHUB_TOKEN/
    );
  });

  it("prefers fine-grained PATs", () => {
    expect(readme).toContain(
      "Fine-grained personal access tokens (PATs) are preferred"
    );
  });

  it("supports classic PATs", () => {
    expect(readme).toContain("Classic PATs");
  });

  it("supports GitHub Actions GITHUB_TOKEN", () => {
    expect(readme).toContain("GITHUB_TOKEN");
  });

  it("states CLI is not required for runtime", () => {
    expect(readme).toContain(
      "No separate GitHub command-line authentication is required for Pourkit runtime"
    );
  });
});

describe("issue tracker docs contract", () => {
  const issueTracker = readDoc(".pourkit/docs/agents/issue-tracker.md");

  it("documents create operation", () => {
    expect(issueTracker).toContain("**Create an issue**");
  });

  it("documents read/view operation", () => {
    expect(issueTracker).toContain("**Read an issue**");
  });

  it("documents comment operation", () => {
    expect(issueTracker).toContain("**Comment on an issue**");
  });

  it("documents label operation", () => {
    expect(issueTracker).toContain("**Apply / remove labels**");
  });

  it("documents close operation", () => {
    expect(issueTracker).toContain("**Close**");
  });

  it("separates issue tracker guidance from Pourkit runtime prerequisite", () => {
    expect(issueTracker).toContain("not a Pourkit runtime prerequisite");
  });
});
