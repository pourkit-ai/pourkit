---
name: code-review
description: Stateful review + refactor loop for issue implementations. Uses Pourkit reviewer criteria (correctness, scope, tests, quality) with severity-based findings and verdict states. Cycles review → findings → fix → re-review until satisfied. Use when user says "review", "code review", "rewview", or after completing an issue implementation.
---

# code-review

Stateful review loop that cycles through **review → findings → fix → re-review** until the review is satisfied. Uses Pourkit's reviewer criteria as the structural guideline.

## Review Criteria

Inspect against these four dimensions:

### Correctness
Behavior bugs, edge cases, broken assumptions, regressions. Prioritize findings that could cause incorrect user-visible behavior, data loss, invalid state transitions, or runtime failures.

### Scope
Work unrelated to the selected issue and missing acceptance criteria. Prioritize findings where implementation overreaches or leaves required behavior incomplete.

### Tests
Missing, weak, flaky, or overly implementation-coupled tests. Prioritize findings where behavior is unprotected, assertions are too shallow, or tests are likely to fail for reasons unrelated to product behavior.

### Code Quality
Unnecessarily complex code, poor names, duplication, hidden coupling, maintainability risks. Prioritize findings that make future changes riskier or obscure intent.

## Severity Levels

| Severity | Meaning |
|----------|---------|
| `critical` | Build break, data loss, security issue, or issue requirements not implemented |
| `high` | Runtime bug, broken behavior, or missing required test/validation |
| `medium` | Maintainability, edge case, or partial correctness concern |
| `low` | Small quality issue that does not block completion |

## Verdict States

| Verdict | Meaning | Action |
|---------|---------|--------|
| `PASS` | No findings | Done |
| `PASS_WITH_NOTES` | Only low/medium findings | Document residual risks, done |
| `NEEDS_REFACTOR` | High findings exist | Fix and re-review |
| `FAIL` | Critical findings exist | Fix and re-review |

## Workflow

### 1. Enter review

Read the changed files and understand what was implemented. Compare against:
- The issue acceptance criteria
- The current git diff
- Relevant tests or validation commands
- Any files directly touched by the implementation

### 2. Categorize findings by criteria

For each finding, record:
- **Severity**: `critical`, `high`, `medium`, or `low`
- **File/Line**: path and line number
- **Issue**: what's wrong
- **Recommendation**: how to fix it

### 3. Decide verdict

- If any `critical` findings → `FAIL`
- If any `high` findings → `NEEDS_REFACTOR`
- If only `medium`/`low` findings → `PASS_WITH_NOTES`
- If no findings → `PASS`

### 4. State transition

**If `FAIL` or `NEEDS_REFACTOR`**:
- List each finding with severity, file:line, issue, and recommendation
- Fix each finding
- Transition back to review state and repeat

**If `PASS` or `PASS_WITH_NOTES`**:
- Output the final review in the format below
- Done

## Output Format (when satisfied)

```
## Review: <PASS|PASS_WITH_NOTES>

### Findings

| Severity | File/Line | Issue | Recommendation |
|----------|-----------|-------|----------------|

### Summary

Brief summary of overall readiness and highest-risk area.

### Residual risks

- [non-blocking risks with file:line if applicable]
- [areas that would benefit from future attention]

### Handoff notes

- [notes for future reviewers or next pipeline stage]
```

## Rules

- Always include file:line references for findings
- Never pass with unresolved critical or high findings
- Keep all findings scoped to the selected issue
- Do not suggest broad rewrites, unrelated cleanup, or speculative future work
- Each re-review cycle should verify previous fixes and check for regressions
- If the review scope is unclear, ask the user before proceeding
