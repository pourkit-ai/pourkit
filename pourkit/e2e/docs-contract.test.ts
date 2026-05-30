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

describe("Serena handoff docs contract", () => {
  const readme = readDoc(".pourkit/handoffs/serena/README.md");
  const integrationPlan = readDoc(
    ".pourkit/handoffs/serena/integration-plan-and-tradeoffs.md"
  );

  it("points Last Discussion at validation report", () => {
    expect(readme).toContain("Validation Report");
    expect(readme).toContain("integration-plan-and-tradeoffs.md");
  });

  it("keeps Batch Baseline recommendation and rejected options documented", () => {
    expect(integrationPlan).toContain("Batch Baseline Model (recommended)");
    expect(integrationPlan).toContain(
      "Option A: Worktree Remount + Exclusive Lease (rejected)"
    );
    expect(integrationPlan).toContain(
      "Option B: Serena Inside Sandbox Container (rejected)"
    );
    expect(integrationPlan).toContain(
      "Option C: Serena as MCP stdio inside Sandbox (rejected)"
    );
  });

  it("records runtime assumption validation sections", () => {
    expect(integrationPlan).toContain("## Validation Report");
    expect(integrationPlan).toContain("Docker HTTP MCP startup");
    expect(integrationPlan).toContain("Mounted repo indexing");
    expect(integrationPlan).toContain("Checkout-triggered incremental updates");
    expect(integrationPlan).toContain("Sandcastle networking");
    expect(integrationPlan).toContain(
      "Multiple clients sharing one Serena sidecar"
    );
  });
});
