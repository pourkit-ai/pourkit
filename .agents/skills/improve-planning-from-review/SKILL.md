---
name: improve-planning-from-review
description: Analyze completed Pourkit issue runs to find review findings that were preventable upstream, then turn that evidence into improvements for `to-prd` and `to-issues`. Use when review/refactor loops take multiple iterations, issue quality feels inconsistent, or the user wants to tune planning prompts using downstream review evidence.
---

# Improve Planning From Review

Use this skill to turn review churn into better planning and write the result as a handoff for the next session. The goal is not to blame the Builder; it is to find which review findings should have been prevented by better PRDs or issue breakdowns.

## Scope

Handle either of these modes, depending on invocation:

- One issue at a time
- One PRD with its child issues

## Process

### 1. Gather evidence

Read the minimum context needed to explain the churn:

- Parent PRD, if one exists
- Child issue body
- Builder outcome, if needed to distinguish planning gaps from implementation weakness
- All reviewer artifacts across iterations
- Final passing state

### 2. Classify findings

For each review finding, decide whether it was:

- Preventable by the PRD
- Preventable by the issue body
- Builder weakness
- Reviewer overreach
- Refactor weakness

Also tag the likely root cause:

- Missing acceptance criteria
- Missing regression contract
- Slice too large or not AFK
- Unclear dependency
- Weak contracts or interfaces
- Weak test guidance
- Code-path ambiguity

### 3. Synthesize patterns

Look for repeated or structural problems, not just isolated misses.

Prioritize evidence that shows:

- The same omission across multiple issues
- The same review finding type across iterations
- The same planning blind spot recurring in one PRD

### 4. Emit a handoff

Write a handoff document to `.pourkit/handoffs/improve-planning-from-review.md` that includes:

- What happened
- What was preventable upstream
- Why it kept reaching review
- Exact recommended changes for `to-issues`
- Exact recommended changes for `to-prd`
- Optional notes about builder/reviewer/refactor model routing only when clearly justified

### 5. Recommend next action

End by stating whether the evidence supports:

- Updating `to-issues`
- Updating `to-prd`
- Updating both
- No prompt changes yet

## Guardrails

- Prefer upstream fixes over downstream blame.
- Do not recommend prompt changes from a single noisy finding unless the miss is clearly structural.
- Keep builder/reviewer/refactor notes secondary unless the evidence is clearly not a planning problem.
- Use Pourkit vocabulary consistently: Issue, PRD, Builder, Reviewer, Refactor, Artifact, Run Context.

## Output

Return a concise handoff with concrete recommendations. Do not duplicate content already captured in PRDs, issues, commits, or diffs; reference those artifacts by path or URL instead. If the evidence is weak or mixed, say so directly and call out the uncertainty instead of inventing a change.
