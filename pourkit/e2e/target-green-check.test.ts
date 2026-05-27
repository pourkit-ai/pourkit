import { describe, expect, it } from "vitest";
import { evaluateTargetGreenCommitMessage } from "./target-green-check";

describe("evaluateTargetGreenCommitMessage", () => {
  it("passes by default", () => {
    expect(evaluateTargetGreenCommitMessage("feat: update docs")).toEqual({
      passed: true,
      reason: "default pass",
    });
  });

  it("passes with an explicit pass marker", () => {
    expect(
      evaluateTargetGreenCommitMessage(
        "feat: prepare release\n\nCanonical body\n\ne2e-check: pass"
      )
    ).toEqual({
      passed: true,
      reason: "explicit pass marker",
    });
  });

  it("fails with an explicit fail marker", () => {
    expect(
      evaluateTargetGreenCommitMessage(
        "feat: merge branch\n\nbody\n\ne2e-check: fail"
      )
    ).toEqual({
      passed: false,
      reason: "explicit fail marker",
    });
  });
});
