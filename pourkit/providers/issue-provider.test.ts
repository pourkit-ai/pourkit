import { describe, expect, it } from "vitest";
import { FakeIssueProvider } from "./issue-provider";

describe("FakeIssueProvider listRelatedIssues", () => {
  it("matches related issues by parent body or title fallback", async () => {
    const provider = new FakeIssueProvider([
      {
        number: 1,
        title: "PRD-002 / I-01: Body parent",
        body: "## Parent\n\nPRD-002 (#20)",
        state: "closed",
        labels: [],
        comments: [],
      },
      {
        number: 2,
        title: "PRD-002 / I-02: Title fallback",
        body: "",
        state: "open",
        labels: [],
        comments: [],
      },
      {
        number: 3,
        title: "PRD-003 / I-01: Different parent",
        body: "",
        state: "closed",
        labels: [],
        comments: [],
      },
    ]);

    await expect(provider.listRelatedIssues("PRD-002")).resolves.toEqual([
      expect.objectContaining({ number: 1 }),
      expect.objectContaining({ number: 2 }),
    ]);
  });
});

describe("FakeIssueProvider resolveIssueByCanonicalRef", () => {
  it("resolves parent PRD by canonical ref in title", async () => {
    const provider = new FakeIssueProvider([
      {
        number: 20,
        title: "PRD-002: Some parent PRD",
        body: "## Description\n\nParent PRD body.",
        state: "open",
        labels: [],
        comments: [],
      },
      {
        number: 1,
        title: "PRD-002 / I-01: Child issue",
        body: "## Parent\n\nPRD-002 (#20)",
        state: "closed",
        labels: [],
        comments: [],
      },
      {
        number: 99,
        title: "PRD-003: Unrelated PRD",
        body: "",
        state: "open",
        labels: [],
        comments: [],
      },
    ]);

    const parent = await provider.resolveIssueByCanonicalRef("PRD-002");
    expect(parent).not.toBeNull();
    expect(parent!.number).toBe(20);
    expect(parent!.title).toBe("PRD-002: Some parent PRD");
  });

  it("returns null when no issue matches the canonical ref", async () => {
    const provider = new FakeIssueProvider([
      {
        number: 1,
        title: "PRD-999 / I-01: Child issue",
        body: "",
        state: "open",
        labels: [],
        comments: [],
      },
    ]);

    const parent = await provider.resolveIssueByCanonicalRef("PRD-002");
    expect(parent).toBeNull();
  });

  it("does not match child issues that happen to start with the canonical ref", async () => {
    const provider = new FakeIssueProvider([
      {
        number: 1,
        title: "PRD-002 / I-01: Child issue",
        body: "",
        state: "open",
        labels: [],
        comments: [],
      },
    ]);

    const parent = await provider.resolveIssueByCanonicalRef("PRD-002");
    expect(parent).toBeNull();
  });
});
