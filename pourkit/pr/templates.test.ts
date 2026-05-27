import { describe, it, expect } from "vitest";
import { renderBranchName } from "./templates";
import type { IssueData } from "../shared/config";

const mockIssue: IssueData = {
  number: 42,
  title: "Add dark mode toggle",
  body: "Implement a toggle for dark mode in settings.",
  state: "open",
  labels: ["feature"],
  comments: [],
};

describe("renderBranchName", () => {
  it("substitutes issue number and slug", () => {
    const result = renderBranchName(
      "pourkit/{{issue.number}}/{{issue.slug}}",
      mockIssue
    );
    expect(result).toBe("pourkit/42/add-dark-mode-toggle");
  });

  it("handles empty template", () => {
    expect(renderBranchName("", mockIssue)).toBe("");
  });
});
