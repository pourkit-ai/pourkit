import { describe, it, expect } from "vitest";
import { TYPE_LABELS } from "../shared/common";
import { selectIssue } from "./select-issue";
import type { CandidateIssue } from "./select-issue";

function issue(
  number: number,
  labels: string[],
  createdAt = "2025-01-01T00:00:00Z"
): CandidateIssue {
  return {
    number,
    title: `Issue #${number}`,
    labels,
    createdAt,
  };
}

describe("selectIssue", () => {
  describe("empty and blocked-only inputs", () => {
    it("returns failure for empty candidate list", () => {
      const result = selectIssue([]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("No candidate issues");
      }
    });

    it("returns failure when all candidates are blocked", () => {
      const result = selectIssue([
        issue(1, ["blocked", "type:feature"]),
        issue(2, ["blocked", "type:infra"]),
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("blocked");
      }
    });
  });

  describe("type label validation", () => {
    it("rejects issues with zero type labels", () => {
      const result = selectIssue([issue(1, ["ready-for-agent"])]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("#1");
        expect(result.reason).toContain("0");
      }
    });

    it("rejects issues with multiple type labels", () => {
      const result = selectIssue([issue(1, ["type:bugfix", "type:infra"])]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("#1");
        expect(result.reason).toContain("2");
      }
    });

    it("selects the valid issue when mixed with invalid ones", () => {
      const result = selectIssue([
        issue(1, []),
        issue(2, ["type:bugfix", "type:feature"]),
        issue(3, ["type:infra"]),
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.issue.number).toBe(3);
      }
    });
  });

  describe("type priority ordering", () => {
    it.each([
      ["type:bugfix", "type:infra", "type:bugfix"],
      ["type:bugfix", "type:feature", "type:bugfix"],
      ["type:bugfix", "type:polish", "type:bugfix"],
      ["type:bugfix", "type:refactor", "type:bugfix"],
      ["type:infra", "type:feature", "type:infra"],
      ["type:infra", "type:polish", "type:infra"],
      ["type:infra", "type:refactor", "type:infra"],
      ["type:feature", "type:polish", "type:feature"],
      ["type:feature", "type:refactor", "type:feature"],
      ["type:polish", "type:refactor", "type:polish"],
    ])(
      "prefers %s over %s",
      (labelA: string, labelB: string, expected: string) => {
        const result = selectIssue([
          issue(1, [labelA], "2025-01-01T00:00:00Z"),
          issue(2, [labelB], "2025-01-01T00:00:00Z"),
        ]);
        expect(result.ok).toBe(true);
        if (result.ok) {
          const selectedType = result.issue.labels.find((l) =>
            l.startsWith("type:")
          );
          expect(selectedType).toBe(expected);
        }
      }
    );

    it("selects bugfix among five different types", () => {
      const result = selectIssue(
        TYPE_LABELS.map((label, i) =>
          issue(i + 1, [label], "2025-01-01T00:00:00Z")
        )
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.issue.labels[0]).toBe("type:bugfix");
      }
    });
  });

  describe("age ordering within same priority", () => {
    it("selects oldest created issue at same priority", () => {
      const result = selectIssue([
        issue(1, ["type:feature"], "2025-03-01T00:00:00Z"),
        issue(2, ["type:feature"], "2025-01-01T00:00:00Z"),
        issue(3, ["type:feature"], "2025-02-01T00:00:00Z"),
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.issue.number).toBe(2);
      }
    });

    it("selects oldest issue regardless of insertion order", () => {
      const result = selectIssue([
        issue(1, ["type:infra"], "2025-06-01T00:00:00Z"),
        issue(2, ["type:infra"], "2025-01-01T00:00:00Z"),
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.issue.number).toBe(2);
      }
    });
  });

  describe("deterministic tie-breaking", () => {
    it("selects lowest issue number when priority and age are equal", () => {
      const result = selectIssue([
        issue(42, ["type:feature"], "2025-01-01T00:00:00Z"),
        issue(7, ["type:feature"], "2025-01-01T00:00:00Z"),
        issue(15, ["type:feature"], "2025-01-01T00:00:00Z"),
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.issue.number).toBe(7);
      }
    });

    it("is stable across multiple calls with same input", () => {
      const candidates = [
        issue(10, ["type:polish"], "2025-01-01T00:00:00Z"),
        issue(5, ["type:polish"], "2025-01-01T00:00:00Z"),
        issue(20, ["type:polish"], "2025-01-01T00:00:00Z"),
      ];

      const r1 = selectIssue(candidates);
      const r2 = selectIssue(candidates);
      const r3 = selectIssue(candidates);

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r3.ok).toBe(true);
      if (r1.ok && r2.ok && r3.ok) {
        expect(r1.issue.number).toBe(r2.issue.number);
        expect(r2.issue.number).toBe(r3.issue.number);
        expect(r1.issue.number).toBe(5);
      }
    });
  });

  describe("blocked issues are skipped", () => {
    it("skips blocked issue and selects next best", () => {
      const result = selectIssue([
        issue(1, ["blocked", "type:bugfix"], "2025-01-01T00:00:00Z"),
        issue(2, ["type:infra"], "2025-01-01T00:00:00Z"),
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.issue.number).toBe(2);
      }
    });

    it("selects lower-priority unblocked over higher-priority blocked", () => {
      const result = selectIssue([
        issue(1, ["blocked", "type:bugfix"], "2025-01-01T00:00:00Z"),
        issue(2, ["type:refactor"], "2025-01-01T00:00:00Z"),
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.issue.labels[0]).toBe("type:refactor");
      }
    });
  });

  describe("agent-in-progress issues are skipped", () => {
    it("skips agent-in-progress issue and selects next best", () => {
      const result = selectIssue([
        issue(1, ["agent-in-progress", "type:bugfix"], "2025-01-01T00:00:00Z"),
        issue(2, ["type:infra"], "2025-01-01T00:00:00Z"),
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.issue.number).toBe(2);
      }
    });

    it("rejects when all non-blocked issues are agent-in-progress", () => {
      const result = selectIssue([
        issue(1, ["agent-in-progress", "type:bugfix"], "2025-01-01T00:00:00Z"),
        issue(2, ["agent-in-progress", "type:infra"], "2025-01-01T00:00:00Z"),
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("agent-in-progress");
      }
    });

    it("uses custom agentInProgressLabel when provided", () => {
      const result = selectIssue(
        [
          issue(
            1,
            ["custom-in-progress", "type:bugfix"],
            "2025-01-01T00:00:00Z"
          ),
          issue(2, ["type:infra"], "2025-01-01T00:00:00Z"),
        ],
        { agentInProgressLabel: "custom-in-progress" }
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.issue.number).toBe(2);
      }
    });

    it("uses custom blockedLabel when provided", () => {
      const result = selectIssue(
        [
          issue(1, ["custom-blocked", "type:bugfix"], "2025-01-01T00:00:00Z"),
          issue(2, ["type:infra"], "2025-01-01T00:00:00Z"),
        ],
        { blockedLabel: "custom-blocked" }
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.issue.number).toBe(2);
      }
    });
  });

  describe("no-runnable outcomes", () => {
    it("returns clear explanation when all non-blocked have bad type labels", () => {
      const result = selectIssue([
        issue(1, ["blocked", "type:feature"]),
        issue(2, []),
        issue(3, ["type:a", "type:b"]),
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/No runnable/i);
      }
    });

    it("includes issue numbers in rejection reasons", () => {
      const result = selectIssue([
        issue(42, []),
        issue(99, ["type:x", "type:y"]),
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("#42");
        expect(result.reason).toContain("#99");
      }
    });
  });

  describe("complex scenarios", () => {
    it("handles realistic candidate mix", () => {
      const result = selectIssue([
        issue(10, ["blocked", "type:bugfix"], "2025-01-01"),
        issue(20, ["type:infra"], "2025-03-01"),
        issue(30, ["type:infra"], "2025-02-01"),
        issue(40, ["type:feature"], "2025-01-01"),
        issue(50, ["type:bugfix", "type:infra"], "2025-01-01"),
        issue(60, ["type:polish"], "2025-01-01"),
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.issue.number).toBe(30);
      }
    });

    it("does not mutate input candidates", () => {
      const candidates = [
        issue(1, ["type:feature"], "2025-01-01"),
        issue(2, ["type:infra"], "2025-01-01"),
      ];
      const before = JSON.stringify(candidates);
      selectIssue(candidates);
      const after = JSON.stringify(candidates);
      expect(after).toBe(before);
    });
  });
});
