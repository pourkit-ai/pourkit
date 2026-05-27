import { describe, it, expect } from "vitest";
import {
  parseReviewVerdict,
  ReviewVerdictProtocolError,
  type ReviewVerdict,
} from "./review-verdict";

describe("parseReviewVerdict", () => {
  it("parses a valid wrapped PASS verdict", () => {
    expect(parseReviewVerdict("<verdict>PASS</verdict>")).toBe("PASS");
  });

  it("parses a valid wrapped PASS_WITH_NOTES verdict", () => {
    expect(parseReviewVerdict("<verdict>PASS_WITH_NOTES</verdict>")).toBe(
      "PASS_WITH_NOTES"
    );
  });

  it("parses a valid wrapped NEEDS_REFACTOR verdict", () => {
    expect(parseReviewVerdict("<verdict>NEEDS_REFACTOR</verdict>")).toBe(
      "NEEDS_REFACTOR"
    );
  });

  it("parses a valid wrapped FAIL verdict", () => {
    expect(parseReviewVerdict("<verdict>FAIL</verdict>")).toBe("FAIL");
  });

  it("parses a wrapped verdict with extra markdown before and after", () => {
    const output = `## Findings

| Severity | File/Line | Issue | Recommendation |
|----------|-----------|-------|----------------|
| none | n/a | No findings. | n/a |

## Summary

The change looks good.

<verdict>PASS_WITH_NOTES</verdict>

## Recommendations

No action required.
`;
    expect(parseReviewVerdict(output)).toBe("PASS_WITH_NOTES");
  });

  it("ignores wrapped verdict examples in prose", () => {
    const output = `## Findings

| Severity | File/Line | Issue | Recommendation |
|----------|-----------|-------|----------------|
| high | .pourkit/prompts/reviewer.prompt.md:56 | The prompt quotes <verdict>PASS</verdict> and <verdict>FAIL</verdict> in prose. | Avoid prose examples that look like protocol tokens. |

## Summary

The only protocol verdict is the standalone line below.

<verdict>NEEDS_REFACTOR</verdict>
`;

    expect(parseReviewVerdict(output)).toBe("NEEDS_REFACTOR");
  });

  it("ignores wrapped verdict examples in markdown list items", () => {
    const output = `## Summary

Do not emit multiple protocol verdicts like:

- <verdict>PASS</verdict>
- <verdict>FAIL</verdict>

<verdict>PASS_WITH_NOTES</verdict>
`;

    expect(parseReviewVerdict(output)).toBe("PASS_WITH_NOTES");
  });

  it("parses a wrapped verdict with whitespace inside the tags", () => {
    expect(parseReviewVerdict("<verdict>  PASS  </verdict>")).toBe("PASS");
  });

  it("rejects output with no verdict wrapper", () => {
    expect(() => parseReviewVerdict("## Verdict\n\nPASS")).toThrow(
      ReviewVerdictProtocolError
    );
  });

  it("does not interpret advisory tokens as official verdicts", () => {
    expect(() =>
      parseReviewVerdict("<advisory>FIX_RECOMMENDED</advisory>")
    ).toThrow(ReviewVerdictProtocolError);
  });

  it("rejects output with plain token verdict", () => {
    expect(() => parseReviewVerdict("PASS")).toThrow(
      ReviewVerdictProtocolError
    );
  });

  it("rejects empty output", () => {
    expect(() => parseReviewVerdict("")).toThrow(ReviewVerdictProtocolError);
  });

  it("rejects malformed wrapper with unknown verdict", () => {
    expect(() => parseReviewVerdict("<verdict>MAYBE</verdict>")).toThrow(
      ReviewVerdictProtocolError
    );
  });

  it("rejects missing closing tag", () => {
    expect(() => parseReviewVerdict("<verdict>PASS")).toThrow(
      ReviewVerdictProtocolError
    );
  });

  it("rejects missing opening tag", () => {
    expect(() => parseReviewVerdict("PASS</verdict>")).toThrow(
      ReviewVerdictProtocolError
    );
  });

  it("rejects multiple wrapped verdicts", () => {
    expect(() =>
      parseReviewVerdict("<verdict>PASS</verdict>\n<verdict>FAIL</verdict>")
    ).toThrow(ReviewVerdictProtocolError);
  });

  it("includes error text when no wrapper is found", () => {
    try {
      parseReviewVerdict("nothing here");
    } catch (error) {
      expect((error as Error).message).toContain(
        "No <verdict>...</verdict> token found"
      );
    }
  });

  it("includes error text when multiple wrappers are found", () => {
    try {
      parseReviewVerdict("<verdict>PASS</verdict>\n\n<verdict>FAIL</verdict>");
    } catch (error) {
      expect((error as Error).message).toContain(
        "Multiple <verdict>...</verdict> tokens found"
      );
    }
  });
});
