# PRD-037: Base Refresh failure resolution control plane

## Problem Statement

Pourkit can resume preserved Worktrees and run Base Refresh, but conflict recovery is still modeled as a dedicated Conflict Resolution Agent path with loose stage ownership. This keeps recovery behavior narrow, optional, and hard to extend to other typed failures. Operators need one host-owned control plane that classifies Base Refresh failures, records attempts, invokes a configured Failure Resolution Agent only when safe, and hands off to humans when automated recovery is unsafe or exhausted.

## Solution

Introduce a narrow Effect v3 control-plane island around Base Refresh and its recovery loop. Base Refresh becomes a first-class Stage Attempt with typed StageFailure outcomes, policy-driven RecoveryDecision handling, append-only Attempt Log records, and a mandatory strategy-level Failure Resolution Agent configuration. The existing conflict-resolution Strategy field is replaced by strategy-level failure resolution config with a clear migration validation error.

First slice covers Base Refresh and RebaseConflict recovery only. Existing Builder, Reviewer, Refactor, Finalizer, Queue Loop, and PR creation behavior remain outside the Effect island except where Base Refresh success invalidates review and downstream state.

## User Stories

1. As a Pourkit operator, I want Base Refresh failures classified as typed StageFailures, so that recovery behavior is predictable.
2. As a Pourkit operator, I want RebaseConflict handled by a general Failure Resolution Agent, so that conflict recovery is part of a reusable failure-resolution model.
3. As a Pourkit operator, I want published-history risks to bypass AI, so that Pourkit never automates unsafe history rewrites.
4. As a Pourkit operator, I want security-sensitive failures to go straight to Human Handoff, so that automated agents do not handle secrets, auth, permissions, payments, destructive data actions, or privacy-sensitive data.
5. As a Strategy author, I want failure resolution configured under the Strategy, so that each Target lane can define its own recovery behavior.
6. As a Strategy author, I want old conflict-resolution config rejected with a migration message, so that config failures are clear.
7. As a Pourkit maintainer, I want Base Refresh wrapped by a narrow Effect runtime boundary, so that typed errors and policy tests can be introduced without rewriting the whole runner.
8. As a Pourkit maintainer, I want a Stage Attempt model, so that the failed stage and recovery attempts have clear lineage.
9. As a Pourkit maintainer, I want Recovery Attempts attached to the failed Stage Attempt, so that retry budgets are scoped to the original failure.
10. As a Pourkit maintainer, I want no nested recovery tree, so that failed recovery attempts cannot recurse forever.
11. As a Pourkit maintainer, I want RecoveryDecision values modeled explicitly, so that retry, resume, mark-complete, handoff, and fail-run outcomes are distinguishable.
12. As a Pourkit maintainer, I want the host to make final recovery decisions, so that the agent can recommend but never control orchestration.
13. As a Failure Resolution Agent, I want a structured packet describing failure type, stage, attempt number, Worktree context, policy limits, allowed decisions, and artifact target, so that I can repair within clear boundaries.
14. As a Failure Resolution Agent, I want to write a markdown Artifact with a parseable JSON block, so that the host can validate my output deterministically.
15. As a Pourkit maintainer, I want malformed or missing Recovery Artifacts to become typed recovery failures, so that protocol failures are handled consistently.
16. As a Pourkit maintainer, I want Attempt Log entries for original failures and recovery failures, so that diagnosis and resume behavior have an audit trail.
17. As a Pourkit maintainer, I want recovery budgets to count against the original failure fingerprint, so that retry loops are bounded.
18. As a Pourkit maintainer, I want successful Base Refresh recovery to keep Builder complete and invalidate Review and downstream stages, so that review reruns against the refreshed base.
19. As a Reviewer, I want refreshed Builder output reviewed again after Base Refresh recovery, so that review reflects the new base commit.
20. As a Pourkit maintainer, I want the host to own Git state transitions, so that agents edit files but do not add, continue rebase, push, merge, or close Issues.
21. As a Pourkit maintainer, I want AI-run verification reported by the Failure Resolution Agent when appropriate, so that repair verification stays in recovery context.
22. As a Pourkit maintainer, I want the host to validate only artifact protocol and Git state after recovery, so that orchestration and repair responsibilities remain separate.
23. As a Pourkit maintainer, I want defects to bypass Failure Resolution Agent, so that unexpected Pourkit bugs do not get treated as repairable workflow failures.
24. As a future Pourkit maintainer, I want this slice to leave room for broader StageFailure taxonomy, so that later PRDs can extend recovery beyond Base Refresh.

## Implementation Decisions

- Add Effect v3 as a dependency and introduce a narrow local runtime boundary inside the existing async Issue Runner for this slice only.
- Model Base Refresh as a first-class Stage Attempt with typed success/failure outcomes.
- Implement first-slice StageFailure types: RebaseConflict, PublishedHistoryRisk, RecoveryArtifactInvalid, and FailureResolutionAgentFailed.
- Treat security-sensitive failures as straight-to-Human-Handoff. In this slice, security-sensitive routing is implemented through explicit StageFailure classification, with broader pattern detection deferred.
- Replace the dedicated conflict-resolution Strategy field with mandatory strategy-level failure-resolution config.
- Reject the old conflict-resolution config during runtime boundary validation with a migration message instructing users to use failure resolution config instead.
- Define failure-resolution config with agent, model, prompt template, maxAttemptsPerFailure, and optional per-failure limits.
- Use a conservative first-slice default of one recovery attempt per failure unless Strategy config overrides it.
- Implement RecoveryDecision values RETRY_STAGE, HANDOFF_TO_HUMAN, and FAIL_RUN as executable in this slice. Parse RESUME_FROM_STAGE and MARK_STAGE_COMPLETE as known enum values but reject them as unsupported for Base Refresh until a later slice defines safe semantics.
- Build a structured FailureResolutionPacket containing failure type, stage name, original stage attempt id, recovery attempt number, Worktree path, branch/base context, conflicted paths when present, failure summary, policy limits, allowed decisions, and artifact target.
- Require the Failure Resolution Agent to write markdown with one parseable JSON block.
- Require RecoveryArtifact JSON fields: recoveryDecision, status summary, changedFiles, verification summary, verification commands run, and optional notes.
- Host validates RecoveryArtifact structure, allowed RecoveryDecision, changed file list shape, required fields, and relevant Git state after recovery.
- Agent may recommend a RecoveryDecision; host evaluates policy and makes final decision.
- Keep runner ownership of Git state transitions during Base Refresh and recovery.
- Keep Worktree Run State small; write full failure/recovery history to an append-only Attempt Log in the Worktree.
- Attempt Log entries distinguish stage attempts from recovery attempts and record failure fingerprint, attempt type, stage, outcome, timestamp, decision, and artifact reference when applicable.
- Recovery Attempt failures consume budget for the original failure fingerprint.
- Successful Base Refresh or conflict recovery preserves Builder completion but invalidates Review, Refactor, Finalizer, PR, merge, and downstream completion state.
- Remove host-run verification after conflict recovery. Failure Resolution Agent may run repair-relevant verification and report it in the RecoveryArtifact; host validates protocol and Git state only.
- Keep full Issue Runner rewrite, Queue Loop rewrite, CLI-edge Effect runtime migration, and generic non-Base-Refresh worktree recovery out of this PRD.

## Testing Decisions

- Tests should assert external workflow behavior and durable state outcomes rather than Effect internals.
- Config tests must prove valid failure-resolution config parses, old conflict-resolution config fails with a migration message, maxAttemptsPerFailure validation is strict, and per-failure limits override defaults.
- Base Refresh tests must cover clean refresh, RebaseConflict dispatch to Failure Resolution Agent, PublishedHistoryRisk Human Handoff, and no Failure Resolution Agent invocation for unsafe failures.
- Recovery Artifact tests must cover valid JSON block parsing, missing JSON block, malformed JSON, missing required fields, unsupported decision for Base Refresh, and invalid changed file data.
- Attempt Log tests must prove original stage failures and recovery failures are recorded separately, recovery budget is scoped to the original failure fingerprint, and failed recovery does not create nested recovery.
- Worktree Run State tests must prove successful recovery keeps Builder complete while clearing Review and downstream stages.
- Execution-provider tests must prove Failure Resolution Agent receives the structured packet and artifact target.
- Regression tests should reuse existing Base Refresh and conflict recovery scenarios as prior art while changing expected stage/config names from dedicated conflict resolution to failure resolution.
- Failing-path tests must prove exhausted recovery transitions to Human Handoff and records a clear last failure.
- Runtime boundary validation tests must prove invalid nearby legacy conflict-resolution metadata never overrides valid failure-resolution config when both are present; legacy metadata causes explicit rejection rather than silent fallback.

## Out of Scope

- Full Issue Runner rewrite to Effect.
- Full Queue Loop rewrite to Effect.
- Moving the Effect runtime boundary to the CLI application edge.
- Generic recovery for non-Base-Refresh failures.
- Parallel Queue execution.
- Full StageFailure taxonomy beyond the four first-slice failures.
- Host-run verification after recovery.
- Attempt Log rotation or pruning.
- Handling base branch movement between Builder completion and Review or PR in non-resume scenarios.

## Further Notes

- Source initiative: `effect-control-plane-and-failure-resolution`.
- Source roadmap slice: Slice 1 — Base Refresh + Failure Resolution Agent.
- Linked locked decisions: DEC-0001 through DEC-0028.
- Open questions OQ-0001, OQ-0002, OQ-0005, OQ-0006, and OQ-0007 are resolved for first-slice purposes by this PRD and may be revisited in later slices if broader recovery semantics require changes.
- Publication status: local mirror created; GitHub issue publication pending.
