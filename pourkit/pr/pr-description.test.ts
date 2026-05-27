import { describe, it, expect } from "vitest";
import {
  ensureConventionalPrTitle,
  parsePrDescription,
  PrDescriptionProtocolError,
} from "./pr-description";

describe("parsePrDescription", () => {
  it("parses valid title and body", () => {
    const output =
      "## PR Title\n\nAdd cool feature\n\n## PR Body\n\n## Summary\n\n- Why this branch exists.\n- What outcome this branch delivers.\n\n## Changes\n\n- Final net change 1.\n- Final net change 2.";
    const result = parsePrDescription(output);
    expect(result.title).toBe("Add cool feature");
    expect(result.body).toBe(
      "## Summary\n\n- Why this branch exists.\n- What outcome this branch delivers.\n\n## Changes\n\n- Final net change 1.\n- Final net change 2."
    );
    expect(result.body).toContain("## Summary");
    expect(result.body).toContain("## Changes");
  });

  it("parses body with closing references", () => {
    const output =
      "## PR Title\n\nAdd cool feature\n\n## PR Body\n\n## Summary\n\n- Why this branch exists.\n\n## Changes\n\n- Final net change 1.\n\nCloses #123";
    const result = parsePrDescription(output);
    expect(result.title).toBe("Add cool feature");
    expect(result.body).toBe(
      "## Summary\n\n- Why this branch exists.\n\n## Changes\n\n- Final net change 1.\n\nCloses #123"
    );
    expect(result.body).toContain("## Summary");
    expect(result.body).toContain("## Changes");
  });

  it("parses with extra content before first heading", () => {
    const output =
      "Some preamble text\n\n## PR Title\n\nAdd feature\n\n## PR Body\n\n## Summary\n\n- Why this branch exists.\n\n## Changes\n\n- Change 1.";
    const result = parsePrDescription(output);
    expect(result.title).toBe("Add feature");
    expect(result.body).toBe(
      "## Summary\n\n- Why this branch exists.\n\n## Changes\n\n- Change 1."
    );
    expect(result.body).toContain("## Summary");
    expect(result.body).toContain("## Changes");
  });

  it("includes trailing content in body", () => {
    const output =
      "## PR Title\n\nAdd feature\n\n## PR Body\n\n## Summary\n\n- Summary here.\n\n## Changes\n\n- Change 1.\n\nSome trailing notes";
    const result = parsePrDescription(output);
    expect(result.title).toBe("Add feature");
    expect(result.body).toBe(
      "## Summary\n\n- Summary here.\n\n## Changes\n\n- Change 1.\n\nSome trailing notes"
    );
    expect(result.body).toContain("## Summary");
    expect(result.body).toContain("## Changes");
  });

  it("rejects missing PR Title section", () => {
    const output = "## PR Body\n\nSome body";
    expect(() => parsePrDescription(output)).toThrow(
      PrDescriptionProtocolError
    );
    expect(() => parsePrDescription(output)).toThrow(
      'Missing required section "## PR Title"'
    );
  });

  it("rejects missing PR Body section", () => {
    const output = "## PR Title\n\nSome title";
    expect(() => parsePrDescription(output)).toThrow(
      PrDescriptionProtocolError
    );
    expect(() => parsePrDescription(output)).toThrow(
      'Missing required section "## PR Body"'
    );
  });

  it("rejects empty title after heading", () => {
    const output = "## PR Title\n\n## PR Body\n\nSome body";
    expect(() => parsePrDescription(output)).toThrow(
      PrDescriptionProtocolError
    );
    expect(() => parsePrDescription(output)).toThrow(
      '"## PR Title" section is empty'
    );
  });

  it("rejects empty body after heading", () => {
    const output = "## PR Title\n\nSome title\n\n## PR Body\n\n";
    expect(() => parsePrDescription(output)).toThrow(
      PrDescriptionProtocolError
    );
    expect(() => parsePrDescription(output)).toThrow(
      '"## PR Body" section is empty'
    );
  });

  it("rejects duplicate PR Title sections", () => {
    const output =
      "## PR Title\n\nTitle 1\n\n## PR Title\n\nTitle 2\n\n## PR Body\n\nBody";
    expect(() => parsePrDescription(output)).toThrow(
      PrDescriptionProtocolError
    );
    expect(() => parsePrDescription(output)).toThrow(
      'Duplicate "## PR Title" sections found'
    );
  });

  it("rejects duplicate PR Body sections", () => {
    const output =
      "## PR Title\n\nTitle\n\n## PR Body\n\nBody 1\n\n## PR Body\n\nBody 2";
    expect(() => parsePrDescription(output)).toThrow(
      PrDescriptionProtocolError
    );
    expect(() => parsePrDescription(output)).toThrow(
      'Duplicate "## PR Body" sections found'
    );
  });

  it("rejects empty output", () => {
    expect(() => parsePrDescription("")).toThrow(PrDescriptionProtocolError);
    expect(() => parsePrDescription("")).toThrow(
      'Missing required section "## PR Title"'
    );
  });

  it("rejects output with only headings and no content", () => {
    const output = "## PR Title\n\n## PR Body";
    expect(() => parsePrDescription(output)).toThrow(
      PrDescriptionProtocolError
    );
  });

  it("rejects output with only PR Body section and no PR Title", () => {
    expect(() => parsePrDescription("## PR Body\n\nbody")).toThrow(
      PrDescriptionProtocolError
    );
  });

  it("handles title with only one line of body", () => {
    const output =
      "## PR Title\n\nAdd feature\n\n## PR Body\n\n## Summary\n\n- A single summary point.";
    const result = parsePrDescription(output);
    expect(result.title).toBe("Add feature");
    expect(result.body).toBe("## Summary\n\n- A single summary point.");
    expect(result.body).toContain("## Summary");
  });
});

describe("ensureConventionalPrTitle", () => {
  it("keeps conventional titles unchanged", () => {
    expect(ensureConventionalPrTitle("fix: normalize PR title", "")).toBe(
      "fix: normalize PR title"
    );
  });

  it("prefixes non-conventional titles from commit summaries", () => {
    expect(
      ensureConventionalPrTitle(
        "Deterministic E2E pipeline coverage",
        "abc123 test(e2e): exercise deterministic refactor stage"
      )
    ).toBe("test: Deterministic E2E pipeline coverage");
  });

  it("falls back to chore when no conventional commit type is available", () => {
    expect(
      ensureConventionalPrTitle("Generated PR Title", "not a commit")
    ).toBe("chore: Generated PR Title");
  });

  it("strips backticks from conventional titles wrapped in inline code", () => {
    expect(
      ensureConventionalPrTitle(
        "`feat: remove pre-PR runner verification gate from PR workflow`",
        ""
      )
    ).toBe("feat: remove pre-PR runner verification gate from PR workflow");
  });

  it("strips backticks from non-conventional titles and falls back to chore", () => {
    expect(
      ensureConventionalPrTitle("`Non-conventional title`", "not a commit")
    ).toBe("chore: Non-conventional title");
  });
});
