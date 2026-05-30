## Problem Statement

Pourkit's Base Refresh conflict handling is too narrow and prompt-shaped. Rebase conflicts are handled by a dedicated Conflict Resolution Agent path, while other recoverable blocking failures have no shared typed control-plane model. This makes recovery policy, retry budget, Human Handoff, and resume behavior harder to reason about and harder to test.

Pourkit needs first-slice proof that Effect can serve as a narrow host-side control plane without rewriting the whole Issue Runner. The slice must replace legacy Base Refresh conflict resolution with a general, policy-bound Failure Resolution Agent while preserving runner ownership of Git state transitions.

## Solution

Introduce a narrow Effect v3 control-plane island around Base Refresh. Model Base Refresh as a Stage Attempt that returns typed StageFailure values, applies recovery policy, invokes one mandatory strategy-scoped Failure Resolution Agent when policy allows, validates the agent's structured RecoveryArtifact, and records stage/recovery history in an append-only Attempt Log.

The first slice keeps the scope deliberately small. It supports Base Refresh failures, RebaseConflict recovery, PublishedHistoryRisk handoff, artifact validation failures, and Failure Resolution Agent execution failures. Successful refresh or recovery keeps Builder complete and invalidates Review/downstream stages so Reviewer reruns against the refreshed base.

## User Stories

1. As a Pourkit operator, I want every Strategy to declare failure-resolution behavior, so that recovery policy is explicit per Target.
2. As a Pourkit operator, I want legacy conflict-resolution config to fail with migration guidance, so that stale config does not silently use the wrong recovery model.
3. As a Pourkit operator, I want Base Refresh conflicts to invoke the Failure Resolution Agent, so that conflict repair uses the shared recovery abstraction.
4. As a Pourkit operator, I want the Failure Resolution Agent to receive structured failure context, so that recovery behavior is consistent and reviewable.
5. As a Pourkit operator, I want the Failure Resolution Agent to write a structured artifact, so that Pourkit can validate the agent's recommendation before acting.
6. As a Pourkit operator, I want Pourkit to own Git state transitions after agent repair, so that agents cannot continue, abort, or rewrite rebases directly.
7. As a Pourkit operator, I want retry budgets per original failure, so that recovery cannot loop forever.
8. As a Pourkit operator, I want recovery failures attached to the original Stage Attempt, so that failure lineage remains understandable.
9. As a Pourkit operator, I want published-history risks to bypass AI recovery, so that risky branch history changes require Human Handoff.
10. As a Pourkit operator, I want security-sensitive failures to bypass AI recovery, so that auth, secret, permission, payment, and privacy contexts are not auto-repaired.
11. As a Pourkit operator, I want malformed or unsupported RecoveryArtifacts to fail safely, so that agent protocol drift does not produce unsafe runner behavior.
12. As a Pourkit operator, I want successful Base Refresh to preserve Builder completion, so that completed implementation work is not rerun unnecessarily.
13. As a Pourkit operator, I want successful Base Refresh to invalidate Review/downstream stages, so that Reviewer evaluates against the new base.
14. As a Pourkit maintainer, I want Base Refresh failures expressed as typed expected failures instead of defects, so that tests can cover policy decisions directly.
15. As a Pourkit maintainer, I want defects to stay outside agent recovery, so that programming errors in Pourkit fail with diagnostics rather than being hidden by AI repair.

## Implementation Decisions

- Effect v3 is adopted only for the Base Refresh control-plane island in this PRD. The local runtime boundary may live inside the existing async Issue Runner for this slice.
- `strategy.failureResolution` is required under every Strategy. It uses the same agent/subagent command conventions as other strategy agent roles.
- `strategy.failureResolution.maxAttemptsPerFailure` is optional and defaults to `3`.
- `strategy.failureResolution.failureLimits` is optional and overrides the default per StageFailure type.
- `strategy.conflictResolution` is removed from the public config boundary and rejected with clear migration text to `strategy.failureResolution`.
- Base Refresh becomes a Stage Attempt with typed success/failure output.
- First-slice StageFailure types are `RebaseConflict`, `PublishedHistoryRisk`, `RecoveryArtifactInvalid`, and `FailureResolutionAgentFailed`.
- First-slice RecoveryDecision execution supports `RETRY_STAGE`, `HANDOFF_TO_HUMAN`, and `FAIL_RUN`.
- `RESUME_FROM_STAGE` and `MARK_STAGE_COMPLETE` may be parsed for forward compatibility but are unsupported in this slice and must route safely to Human Handoff.
- FailureResolutionPacket is schema-validated and includes failure type, stage, attempt number, Worktree path, failure summary/details, policy limits, allowed decisions, and artifact path.
- RecoveryArtifact is markdown containing exactly one required fenced `json` block with recovery decision, summary, changed files, verification, and optional notes.
- Failure Resolution Agent artifacts are written under the Worktree temporary recovery artifact location, not runner-owned durable state.
- Attempt Log is append-only JSONL inside the Worktree and records stage failures, recovery successes, and recovery failures.
- Recovery budget is scoped to the original failure fingerprint. Recovery Attempt failures consume the original failure's budget and do not create nested recovery trees.
- Host-owned validation covers artifact schema, allowed decision, artifact path, unresolved conflict markers, and Git state before continuing.
- Host-owned Git transitions remain with Pourkit: add conflicted files, continue rebase, abort or hand off when needed.
- Agent-owned repair verification is reported in the RecoveryArtifact. Host does not run build/test/lint verification commands as part of recovery validation.
- Successful Base Refresh or successful conflict recovery preserves Builder completion and invalidates Review/downstream stage state.
- PublishedHistoryRisk and security-sensitive failures bypass Failure Resolution Agent and route to Human Handoff.
- Defects in Pourkit code do not route through Failure Resolution Agent. Expected typed StageFailures route through policy.

## Testing Decisions

- Config tests must cover required `strategy.failureResolution`, default `maxAttemptsPerFailure`, `failureLimits`, and rejection of `strategy.conflictResolution` with migration text.
- Config tests must prove existing Strategy agent conventions still parse for Builder, Reviewer, Refactor, Verify, and Finalize behavior.
- Domain tests must cover StageFailure construction for Base Refresh conflicts and PublishedHistoryRisk.
- Packet tests must cover FailureResolutionPacket schema validation, allowed decision calculation, policy limit inclusion, and artifact path inclusion.
- Artifact parser tests must cover valid markdown plus JSON, missing JSON, malformed JSON, unsupported decisions, multiple JSON blocks, and missing required fields.
- Attempt Log tests must cover append semantics for original stage failure, recovery success, recovery failure, and per-fingerprint budget counting across retry/resume boundaries.
- Base Refresh tests must cover clean refresh, RebaseConflict dispatch to Failure Resolution Agent, PublishedHistoryRisk bypass to Human Handoff, malformed artifact handling, exhausted budget handling, and successful recovery continuing host-owned Git transitions.
- Worktree Run State tests must cover Builder completion preservation and Review/downstream invalidation after successful refresh or recovery.
- Existing non-conflict Base Refresh behavior must remain green.
- Existing Conflict Resolution Agent tests should be replaced or deleted as part of the public boundary migration, not left asserting legacy `strategy.conflictResolution` behavior.

## Out of Scope

- Full Issue Runner rewrite to Effect.
- Full Queue Runner rewrite.
- Generic Worktree recovery beyond Base Refresh.
- Parallel Queue execution.
- Full StageFailure taxonomy beyond first-slice types.
- Full service/layer refactor.
- Moving the Effect runtime boundary to the CLI application edge.
- Host-run build/test/lint verification during recovery.
- Executing `RESUME_FROM_STAGE` or `MARK_STAGE_COMPLETE` recovery decisions.
- Attempt Log rotation or pruning.
- Broader recovery for Reviewer, Refactor, Finalizer, PR creation, merge, GitHub API, or check failures.

## Further Notes

- Source initiative: `effect-control-plane-and-failure-resolution`.
- Linked decisions: DEC-0001 through DEC-0028.
- This PRD is Slice 1 from the roadmap: Base Refresh + Failure Resolution Agent.
- Completion command after implementation: `Architect: reconcile`.
- Implementation summary should include changed files, test results, deviations from this PRD, and any new decisions or open questions.
