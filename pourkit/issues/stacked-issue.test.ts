import { describe, expect, it } from "vitest";
import {
  parseAffectedCodePaths,
  parseParentRefFromBody,
  parseParentRefFromTitle,
  parseStackedIssue,
} from "./stacked-issue";

describe("parseParentRefFromBody", () => {
  it("parses the parent PRD from the parent section", () => {
    expect(parseParentRefFromBody("## Parent\n\nPRD-002 (#17)\n")).toBe(
      "PRD-002"
    );
  });

  it("returns undefined when no parent section exists", () => {
    expect(parseParentRefFromBody("## What to build\n\nTest")).toBeUndefined();
  });
});

describe("parseParentRefFromTitle", () => {
  it("parses the parent PRD from child issue titles", () => {
    expect(parseParentRefFromTitle("PRD-014 / I-03: Add stack context")).toBe(
      "PRD-014"
    );
  });

  it("returns undefined for non-child titles", () => {
    expect(parseParentRefFromTitle("Standalone issue")).toBeUndefined();
  });
});

describe("parseAffectedCodePaths", () => {
  it("extracts code paths from the affected code paths section", () => {
    expect(
      parseAffectedCodePaths(
        [
          "## Affected code paths",
          "",
          "- `pourkit/commands/issue.ts`",
          "- `pourkit/shared/run-context.ts`",
          "- Class/Module: `Ignored`",
          "",
        ].join("\n")
      )
    ).toEqual(["pourkit/commands/issue.ts", "pourkit/shared/run-context.ts"]);
  });

  it("returns an empty list when the section is missing", () => {
    expect(parseAffectedCodePaths("## Desired behavior\n\n- Test")).toEqual([]);
  });
});

describe("parseStackedIssue", () => {
  it("prefers body parent metadata over title fallback", () => {
    const parsed = parseStackedIssue(
      "PRD-001 / I-02: Title fallback",
      "## Parent\n\nPRD-002 (#20)"
    );

    expect(parsed.parentRef).toBe("PRD-002");
    expect(parsed.parentSource).toBe("body");
    expect(parsed.warnings).toEqual([
      "Parent mismatch: body references PRD-002 but title references PRD-001",
    ]);
  });

  it("returns compact metadata for malformed content", () => {
    expect(parseStackedIssue("Standalone issue", "")).toEqual({
      parentRef: undefined,
      parentSource: undefined,
      bodyParentRef: undefined,
      titleParentRef: undefined,
      affectedCodePaths: [],
      isChildIssue: false,
      siblingGroupingKey: undefined,
      warnings: [],
    });
  });
});
