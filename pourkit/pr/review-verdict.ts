export type ReviewVerdict =
  | "PASS"
  | "PASS_WITH_NOTES"
  | "NEEDS_REFACTOR"
  | "FAIL"
  | "NEEDS_HUMAN";

const VALID_VERDICTS: ReviewVerdict[] = [
  "PASS",
  "PASS_WITH_NOTES",
  "NEEDS_REFACTOR",
  "FAIL",
  "NEEDS_HUMAN",
];

export class ReviewVerdictProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewVerdictProtocolError";
  }
}

export function parseReviewVerdict(output: string): ReviewVerdict {
  const verdictRegex =
    /^\s*<verdict>\s*(PASS|PASS_WITH_NOTES|NEEDS_REFACTOR|FAIL|NEEDS_HUMAN)\s*<\/verdict>\s*$/gm;
  const matches = Array.from(output.matchAll(verdictRegex));

  if (!matches || matches.length === 0) {
    throw new ReviewVerdictProtocolError(
      "No <verdict>...</verdict> token found in reviewer output"
    );
  }

  if (matches.length > 1) {
    throw new ReviewVerdictProtocolError(
      "Multiple <verdict>...</verdict> tokens found in reviewer output"
    );
  }

  const verdict = matches[0][1];
  if (!verdict) {
    throw new ReviewVerdictProtocolError(
      "Malformed <verdict>...</verdict> token in reviewer output"
    );
  }

  return verdict as ReviewVerdict;
}
