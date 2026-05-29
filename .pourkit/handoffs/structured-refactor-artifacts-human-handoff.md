# Handoff: Structured Refactor Artifacts and Human Handoff

## Purpose

This handoff captures a grill-with-docs design session about improving Pourkit's review/refactor loop. The goal is to make repeated reviewer/refactor disagreement visible and actionable by introducing structured Refactor Artifacts, stronger Reviewer protocol, and an explicit human-handoff verdict.

This handoff is detailed enough to generate a PRD. Exclude any separate `to-issues` skill update from the PRD; the user said that follow-up has already been handled separately.

## Recommended Next Skills

- `to-prd`: Use this handoff to generate and publish a PRD.
- `to-issues`: After PRD approval, split the PRD into implementation issues.
- `grill-with-docs`: Use only if new terminology or workflow semantics become ambiguous.
- `code-review`: Use after implementation issues complete.

## Existing Context

Relevant domain docs:

- `.pourkit/CONTEXT.md`
- `.pourkit/docs/adr/0001-preserve-issue-worktrees-for-resumable-runs.md`
- `.pourkit/docs/adr/0005-agent-facing-verification-and-label-provisioning.md`

Relevant code discovered during discussion:

- `pourkit/commands/review.ts`
- `.pourkit/prompts/reviewer.prompt.md`
- `.pourkit/prompts/refactor.prompt.md`
- `pourkit/shared/run-context.ts`

Current behavior in `pourkit/commands/review.ts`:

- Reviewer writes `.pourkit/.tmp/reviewers/iteration-N.md`.
- Reviewer verdicts currently include `PASS`, `PASS_WITH_NOTES`, `NEEDS_REFACTOR`, and `FAIL`.
- `FAIL` does not stop the loop; it still invokes the Refactor agent.
- The loop ends on `PASS`, exhausted `PASS_WITH_NOTES` attempts treated as pass, refactor execution failure, or max iterations.
- The Refactor agent receives the latest review in prompt text but writes no structured artifact.
- Later Reviewers may receive review history, but not structured Refactor rationale.
- The refactor prompt currently says: `Do not write a separate refactor plan artifact.` This must change.

Current domain terms:

- **Builder**: implements an issue in a Worktree and produces artifacts.
- **Reviewer**: evaluates Builder output and produces a review artifact.
- **Refactor**: addresses Reviewer feedback.
- **Run Context**: shared markdown file at `.pourkit/.tmp/run-context.md`.
- **Artifact**: file produced by an agent role and read by later workflow steps.

## Problem

Builder/Refactor chat summaries are currently not consumed by later agents. When the Refactor rejects a finding, cannot complete a fix, or misunderstands a Reviewer recommendation, that reasoning is lost. The next Reviewer can repeat the same finding with the same level of guidance, causing loops.

Example scenario discussed:

- Reviewer recommends asserting `builderCall!.worktreePath`.
- Refactor rejects because the test is for a "new" run where `builderCall!.worktreePath` is intentionally undefined.
- Refactor explains this in chat output, but Reviewer does not read it.
- The loop can continue because the only durable artifact is the Reviewer Artifact.

The desired workflow should preserve conversation boundaries between Reviewer and Refactor while keeping the Reviewer independent. Refactor Artifacts are context, not source of truth.

## Design Principles

- Reviewer acts like a senior software engineer.
- Builder/Refactor acts like the implementor.
- Reviewer must independently inspect code, diffs, issue requirements, tests, and artifacts.
- Refactor Artifact is not source of truth; it is conversational memory.
- Reviewer should use Refactor Artifacts to provide more precise guidance, avoid blind repetition, and escalate when the loop is no longer productive.
- Reviewer must not edit source files or perform refactors itself.
- `FAIL` should keep its current meaning: severe but still actionable by Refactor.
- Human escalation needs a distinct verdict because `FAIL` currently continues the loop.

## Resolved Decisions

### 1. Add Structured Refactor Artifacts

Each Refactor attempt must write a structured Refactor Artifact directly.

Path:

```text
.pourkit/.tmp/refactors/iteration-N.md
```

Ownership:

- The Refactor agent writes this file.
- The runner provides the required artifact path.
- The runner reads and validates it minimally.
- Later Reviewers receive all prior Refactor Artifacts as context.

Required sections:

```md
## Finding Responses

| Finding ID | Classification | Rationale | Files Changed |
|------------|----------------|-----------|---------------|
| R1.F1 | accepted | Added missing assertion. | pourkit/commands/issue.test.ts |
| R1.F2 | rejected | This test covers new-run mode; builder worktree path is intentionally undefined. | n/a |

## Verification

| Command | Result | Notes |
|---------|--------|-------|
| npm run typecheck | passed | n/a |

## Open Blockers

| Blocker | Needed From |
|---------|-------------|
| n/a | n/a |
```

Allowed Finding Response classifications:

- `accepted`
- `rejected`
- `deferred`
- `blocked`

Validation should be minimal in the first implementation.

Required:

- File exists.
- File is non-empty.
- Contains `## Finding Responses`.
- Contains `## Verification`.
- Contains `## Open Blockers`.
- Contains a response for each latest Reviewer finding ID when actionable findings exist.
- Uses only allowed classifications.

Not required initially:

- Strict markdown table parsing.
- Verification command result enforcement.
- Matching files changed to git diff.
- Deep semantic validation of finding responses.

Invalid Refactor Artifact handling:

- If missing, empty, or invalid, fail the refactor attempt and transition to human-needed local state.
- Do not continue silently.
- Rule: A Refactor may make code changes only if it also writes a valid Refactor Artifact.

### 2. Strengthen Reviewer Artifacts With Finding IDs

Reviewer Artifacts must require stable finding IDs.

Finding ID format:

```text
R{reviewIteration}.F{findingNumber}
```

Examples:

- `R1.F1`
- `R1.F2`
- `R2.F1`

Reviewer findings table should include an `ID` column.

Example:

```md
| ID | Supersedes | Severity | File/Line | Issue | Recommendation |
|----|------------|----------|-----------|-------|----------------|
| R2.F1 | R1.F1 | medium | pourkit/commands/issue.test.ts:1831 | Prior refactor response did not address the assertion weakness. | Add an assertion for X, or document why Y is the contract. |
```

Surviving finding rule:

- If a finding survives into a later review, the Reviewer creates a new finding ID.
- The new finding links back to the prior finding with `Supersedes`.
- Do not reuse the original finding ID in later iterations.

Rationale:

- Each Reviewer Artifact remains an immutable record of that iteration.
- `Supersedes` preserves lineage.
- Future loop detection can use finding lineage.

### 3. Reviewer Must Assess Prior Refactor Responses

When prior Refactor Artifacts exist, the next Reviewer Artifact must include:

```md
## Prior Refactor Response Assessment
```

Suggested table:

```md
| Prior Finding ID | Refactor Classification | Reviewer Assessment | Next Action |
|------------------|-------------------------|---------------------|-------------|
| R1.F1 | rejected | accepted-refactor-response | Do not repeat |
| R1.F2 | accepted | needs-clearer-guidance | Repeat with exact expected assertion |
```

Allowed Reviewer assessment paths:

- `accepted-refactor-response`
- `needs-clearer-guidance`
- `human-needed`

Meaning:

- `accepted-refactor-response`: Refactor rationale is valid; do not repeat the finding.
- `needs-clearer-guidance`: Finding remains valid; repeat it only with clearer code-level guidance.
- `human-needed`: The loop is stuck, ambiguous, unsafe, or requires human judgment.

Required rule:

- A repeated finding must include why the previous Refactor response was insufficient and what concrete next action would resolve it.

### 4. Add NEEDS_HUMAN Reviewer Verdict

Add a new verdict:

```xml
<verdict>NEEDS_HUMAN</verdict>
```

Verdict semantics:

- `PASS`: no blocking findings.
- `PASS_WITH_NOTES`: acceptable, optional/limited refactor attempts allowed.
- `NEEDS_REFACTOR`: actionable findings that Refactor should address.
- `FAIL`: severe findings, but still actionable by Refactor.
- `NEEDS_HUMAN`: stop the review/refactor loop and transition to human.

Important:

- Do not overload `FAIL`.
- `FAIL` currently runs Refactor and should continue to do so.
- `NEEDS_HUMAN` is the new explicit stop signal.

Reviewer may emit `NEEDS_HUMAN` on the first review. It does not need to wait for a Refactor Artifact.

Use `NEEDS_HUMAN` when:

- A product/design decision is required.
- The same finding lineage keeps surviving despite refactor attempts.
- Refactor marks a finding as `blocked` and the blocker cannot be resolved from repo context.
- Reviewer cannot provide safe concrete guidance without a human decision.

### 5. Require Human Handoff Sections For NEEDS_HUMAN

When Reviewer emits `NEEDS_HUMAN`, Reviewer Artifact must include:

```md
## Human Handoff Summary

Pourkit stopped because the finding lineage R1.F1 -> R2.F1 is blocked on a human decision: confirm whether new-run tests should assert the provider result or builder input.

## Human Handoff Reason

| Finding Lineage | Reason | Needed From Human |
|-----------------|--------|-------------------|
| R1.F1 -> R2.F1 | Refactor response conflicts with intended behavior. | Confirm intended contract. |
```

Runner behavior in later workflow issue:

- Copy `Human Handoff Summary` into the GitHub issue comment.
- Include artifact paths.
- Avoid parsing detailed table beyond validating the section exists.

### 6. Minimal Reviewer Artifact Validation

First implementation should validate Reviewer Artifact protocol at section/token level.

Validate:

- Verdict token allows `PASS`, `PASS_WITH_NOTES`, `NEEDS_REFACTOR`, `FAIL`, `NEEDS_HUMAN`.
- Findings table includes an `ID` column.
- Finding IDs match current review iteration format, e.g. `R2.F1`.
- `Supersedes` IDs, when present, are syntactically valid.
- If prior Refactor Artifacts exist, `## Prior Refactor Response Assessment` exists.
- If verdict is `NEEDS_HUMAN`, `## Human Handoff Summary` and `## Human Handoff Reason` exist.

Do not initially validate:

- Semantic lineage correctness.
- Whether `Supersedes` references actually exist.
- Perfect markdown table structure.
- Whether recommendations are truly actionable.

### 7. Pass Refactor Artifacts To Later Reviewers

Later Reviewers should receive all prior Refactor Artifacts.

Delivery:

- Reference `.pourkit/.tmp/refactors/` in Run Context.
- Inline all prior Refactor Artifacts into Reviewer prompt, grouped by iteration.

Example grouping:

```md
## Prior Refactor Artifacts

Treat these as conversational context, not source of truth. Inspect the current code independently.

### Refactor Iteration 1

...contents...

### Refactor Iteration 2

...contents...
```

Rationale:

- Reviewer cannot accidentally skip them.
- Mirrors existing review history mechanism.
- Preserves finding lineage across iterations.
- Can be truncated later if context size becomes a real issue.

### 8. Human Handoff Workflow

When terminal `NEEDS_HUMAN` is reached by the runner:

- Remove `ready-for-agent`.
- Add `ready-for-human`.
- Post a concise GitHub issue comment from `Human Handoff Summary`.
- Include artifact paths.
- Preserve the current Worktree.
- Do not create a handoff commit solely because `NEEDS_HUMAN` happened.

Comment should be short, not the full table verbatim.

Example:

```md
Pourkit stopped the review/refactor loop because human input is needed.

Pourkit stopped because the finding lineage R1.F1 -> R2.F1 is blocked on a human decision: confirm whether new-run tests should assert the provider result or builder input.

Artifacts:
- Review: .pourkit/.tmp/reviewers/iteration-2.md
- Refactors: .pourkit/.tmp/refactors/
```

Rationale:

- `ready-for-agent` means Pourkit may pick the issue.
- Keeping both labels would make queue selection ambiguous.
- `ready-for-human` makes the issue unavailable to the Queue Loop until a human resolves it.
- Issue comment gives humans useful context in GitHub without requiring immediate local artifact inspection.

### 9. Worktree Handling And Resume

`NEEDS_HUMAN` is its own terminal review state in Worktree Run State.

It is not:

- A crash.
- A generic failed run.
- Max iteration exhaustion.

Worktree Run State should record:

- `lastVerdict: NEEDS_HUMAN`
- Relevant Reviewer Artifact path.
- Refactor Artifact paths if available.

Behavior:

- Runner does not automatically resume the review/refactor loop from this state.
- A human must resolve the issue and move it back to `ready-for-agent`.

After human resolution:

- If the issue returns to `ready-for-agent`, resume the preserved Worktree by default.
- `--reset-worktree` remains the explicit clean-start escape hatch.
- Include prior Reviewer and Refactor Artifacts as historical context.
- Add a clear human-resolved handoff boundary.
- Continue review iteration numbering instead of resetting to `R1`.

Suggested boundary text:

```md
## Human-Resolved Handoff Boundary

A prior review emitted `NEEDS_HUMAN` and stopped the agent loop. The issue has since been moved back to `ready-for-agent`.

Before carrying forward old blockers, inspect newer issue comments and the current worktree. Treat prior Reviewer and Refactor Artifacts as historical context, not active findings unless they still apply.
```

### 10. Documentation Updates

Update `.pourkit/CONTEXT.md` with new durable domain terms.

Proposed terms:

**Refactor Artifact**:
A structured Artifact written by a Refactor attempt that records how each Reviewer finding was handled, verification performed, and open blockers.
_Avoid_: Refactor summary, chat response, fix log

**Finding Lineage**:
The chain of related Reviewer findings across review iterations, expressed by finding IDs and `Supersedes` links.
_Avoid_: Repeat finding, duplicate issue

**Human Handoff**:
A workflow transition where a Reviewer determines agent iteration should stop and a human decision or action is required.
_Avoid_: Failure, escalation without context

Update relationships:

- A **Refactor** writes a **Refactor Artifact** for each refactor attempt.
- A **Reviewer** reads prior **Refactor Artifacts** as context, not source of truth.
- A **Finding Lineage** connects related Reviewer findings across iterations.
- A **Human Handoff** stops the review/refactor loop and moves the Issue to `ready-for-human`.

Add an ADR.

Proposed ADR:

```text
.pourkit/docs/adr/0007-structured-refactor-artifacts-and-human-handoff-verdict.md
```

Proposed title:

```md
# ADR-0007: Structured Refactor Artifacts and Human Handoff Verdict
```

ADR should explain:

- Current chat summaries are not consumed by later agents.
- Refactor rationale needs to become an Artifact.
- Reviewer needs finding IDs and lineage to avoid blind repetition.
- `FAIL` cannot mean stop because current behavior refactors on `FAIL`.
- Therefore introduce `NEEDS_HUMAN`.
- Human handoff transitions labels and posts concise comment.
- Preserve Worktree without creating partial handoff commits.
- Resume from preserved Worktree after human moves issue back to `ready-for-agent`.

## Recommended PRD Shape

### PRD Goal

Improve Pourkit's review/refactor loop so repeated disagreement, blocked refactors, and ambiguity are captured as durable artifacts and can either receive clearer Reviewer guidance or stop with an actionable Human Handoff.

### Non-Goals

- Do not let Reviewer edit source files.
- Do not add Builder Artifacts in this PRD.
- Do not implement strict markdown table parsing initially.
- Do not enforce verification command results in the runner.
- Do not create partial handoff commits.
- Do not include the separate `to-issues` skill update; it was handled separately.

### Success Criteria

- Refactor writes structured artifacts for every refactor attempt.
- Reviewer receives prior Refactor Artifacts and assesses them.
- Reviewer findings have iteration-scoped IDs.
- Surviving findings link to prior findings with `Supersedes`.
- `NEEDS_HUMAN` stops local review/refactor loop without overloading `FAIL`.
- Human handoff includes summary/reason sections and later posts concise GitHub issue comment.
- Issue label transition removes `ready-for-agent` and adds `ready-for-human`.
- Worktree remains preserved and resumable after human resolution.
- Documentation captures new domain terms and ADR.

## Recommended Implementation Issues

### Issue 1: Docs

Update `.pourkit/CONTEXT.md` and add ADR-0007.

Scope:

- Add `Refactor Artifact`, `Finding Lineage`, and `Human Handoff`.
- Add relationships.
- Add ADR explaining decision and tradeoffs.

### Issue 2: Reviewer Protocol

Scope:

- Add `NEEDS_HUMAN` parsing.
- Add finding IDs.
- Add `Supersedes`.
- Add `Human Handoff Summary`.
- Add `Human Handoff Reason`.
- Add section/token-level Reviewer Artifact validation.
- `NEEDS_HUMAN` stops the local loop and returns terminal review state only.

Explicitly out of scope:

- GitHub label changes.
- GitHub issue comments.
- Refactor Artifact writing.

### Issue 3: Refactor Artifact Protocol

Scope:

- Add `.pourkit/.tmp/refactors/iteration-N.md`.
- Update Refactor prompt to require structured artifact.
- Validate missing/empty/invalid artifact minimally.
- Invalid artifact returns terminal human-needed local state.

Explicitly out of scope:

- GitHub label/comment behavior.
- Strict markdown parser.

### Issue 4: Reviewer Context Wiring

Scope:

- Reference `.pourkit/.tmp/refactors/` in Run Context.
- Inline all prior Refactor Artifacts into later Reviewer prompts.
- Require `Prior Refactor Response Assessment` when prior Refactor Artifacts exist.
- Treat artifacts as context, not source of truth.

### Issue 5: Human Handoff Workflow

Scope:

- On terminal `NEEDS_HUMAN`, remove `ready-for-agent`.
- Add `ready-for-human`.
- Post concise GitHub issue comment from `Human Handoff Summary`.
- Include artifact paths.
- Preserve worktree and do not create handoff commit.

### Issue 6: Resume After Handoff

Scope:

- Represent `NEEDS_HUMAN` as its own terminal Worktree Run State.
- Allow resume from preserved Worktree after issue returns to `ready-for-agent`.
- Add human-resolved handoff boundary context.
- Continue review iteration numbering.
- Preserve prior artifacts as historical context.

## Open Questions For PRD Author

Most design decisions are resolved. Potential details to verify against code during PRD/issues:

- Exact type shape for adding `NEEDS_HUMAN` to review verdict parsing.
- Whether existing issue transition helpers already support remove/add label + comment in one path.
- How Worktree Run State currently serializes review verdicts and whether schema updates are needed.
- Whether `maxIterations` exhaustion should reuse Human Handoff mechanics or remain separate.
- Whether invalid Refactor Artifact should use `NEEDS_HUMAN` internally or a separate protocol-failure state that transitions similarly.
