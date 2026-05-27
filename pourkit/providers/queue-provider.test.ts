import { describe, expect, it } from "vitest";
import { FakeIssueProvider } from "../providers/issue-provider";
import type { IssueData } from "../shared/config";

const makeIssue = (overrides: Partial<IssueData> = {}): IssueData => ({
  number: 1,
  title: "Test issue",
  body: "Test body",
  state: "open",
  labels: ["ready-for-agent"],
  comments: [],
  ...overrides,
});

describe("FakeIssueProvider listCandidates", () => {
  it("returns all open AFK-ready issues as candidates", async () => {
    const issues = [
      makeIssue({ number: 1, title: "Issue one" }),
      makeIssue({ number: 2, title: "Issue two" }),
      makeIssue({ number: 3, title: "Issue three" }),
    ];
    const provider = new FakeIssueProvider(issues);

    const candidates = await provider.listCandidates();

    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.number)).toContain(1);
    expect(candidates.map((c) => c.number)).toContain(2);
    expect(candidates.map((c) => c.number)).toContain(3);
  });

  it("returns empty array when no issues exist", async () => {
    const provider = new FakeIssueProvider([]);

    const candidates = await provider.listCandidates();

    expect(candidates).toHaveLength(0);
  });

  it("returns independent copies of issues", async () => {
    const issues = [makeIssue({ number: 1, labels: ["ready-for-agent"] })];
    const provider = new FakeIssueProvider(issues);

    const candidates = await provider.listCandidates();
    candidates[0].labels.push("modified");

    const original = await provider.fetchIssue(1);
    expect(original.labels).not.toContain("modified");
  });

  it("includes blocked issues in candidate list", async () => {
    const issues = [
      makeIssue({ number: 1, labels: ["ready-for-agent"] }),
      makeIssue({ number: 2, labels: ["ready-for-agent", "blocked"] }),
    ];
    const provider = new FakeIssueProvider(issues);

    const candidates = await provider.listCandidates();

    expect(candidates).toHaveLength(2);
    const blockedCandidate = candidates.find((c) => c.number === 2);
    expect(blockedCandidate?.labels).toContain("blocked");
  });

  it("excludes closed issues", async () => {
    const issues = [
      makeIssue({ number: 1, title: "Open issue" }),
      makeIssue({ number: 2, title: "Closed issue", state: "closed" }),
    ];
    const provider = new FakeIssueProvider(issues);

    const candidates = await provider.listCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0].number).toBe(1);
  });

  it("excludes issues without ready-for-agent label", async () => {
    const issues = [
      makeIssue({ number: 1, labels: ["ready-for-agent"] }),
      makeIssue({ number: 2, labels: ["type:feature"] }),
    ];
    const provider = new FakeIssueProvider(issues);

    const candidates = await provider.listCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0].number).toBe(1);
  });

  it("uses custom ready-for-agent label when configured", async () => {
    const issues = [
      makeIssue({
        number: 1,
        labels: ["afk-ready"],
        state: "open",
      }),
      makeIssue({
        number: 2,
        labels: ["ready-for-agent"],
        state: "open",
      }),
    ];
    const provider = new FakeIssueProvider(issues, {
      readyForAgentLabel: "afk-ready",
    });

    const candidates = await provider.listCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0].number).toBe(1);
  });
});
