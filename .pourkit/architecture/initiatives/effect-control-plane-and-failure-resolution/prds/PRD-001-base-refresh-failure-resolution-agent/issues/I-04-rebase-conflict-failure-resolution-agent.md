# PRD-001 / I-04: Recover Base Refresh conflicts with Failure Resolution Agent

## Parent

PRD-001: Base Refresh + Failure Resolution Agent

## Source of truth for behavior

Explicit new contract, DEC-0007 through DEC-0013, DEC-0019, DEC-0020, DEC-0023, DEC-0025 through DEC-0028, existing conflict-resolution loop behavior, context glossary.

## What to build

Replace the Base Refresh conflict path's legacy conflict-resolution loop with Failure Resolution Agent dispatch, host-side artifact validation, host-owned rebase continuation, Attempt Log writes, and Review/downstream invalidation after successful recovery.

## Affected code paths

- pourkit/commands/issue-run.ts [inferred]
  - Class/Module: Issue Runner startup flow
  - Functions/Methods: startIssueRun(...), transitionIssueToFailureState(...)
  - New: No
- pourkit/commands/conflict-resolution.ts [inferred]
  - Class/Module: legacy conflict-resolution runner
  - Functions/Methods: runConflictResolutionLoop(...), runConflictResolutionOnce(...)
  - New: No
- pourkit/commands/failure-resolution.ts [inferred]
  - Class/Module: Failure Resolution Agent runner
  - Functions/Methods: runFailureResolutionOnce(...), runFailureResolutionForStageFailure(...)
  - New: Yes
- pourkit/commands/base-refresh.ts [inferred]
  - Class/Module: Base Refresh state invalidation
  - Functions/Methods: invalidateAfterBaseRefresh(...)
  - New: No
- pourkit/commands/issue.test.ts [inferred]
  - Class/Module: Issue Runner tests
  - Functions/Methods: runIssueCommand(...)
  - New: No
- pourkit/commands/failure-resolution.test.ts [inferred]
  - Class/Module: Failure Resolution Agent runner tests
  - Functions/Methods: runFailureResolutionOnce(...)
  - New: Yes

## Current behavior

- `startIssueRun(...)` invokes `runConflictResolutionLoop(...)` when Base Refresh returns a conflict and `strategy.conflictResolution` exists.
- Legacy conflict recovery writes artifacts under the conflict-resolution temporary artifact location and uses `resolved` / `ambiguous` status.
- After legacy conflict recovery completes, host may run configured verification commands before invalidating Review/downstream state.

## Desired behavior

- `startIssueRun(...)` invokes Failure Resolution Agent through `strategy.failureResolution` for policy-allowed `RebaseConflict` failures.
- Agent receives a schema-validated FailureResolutionPacket and writes a RecoveryArtifact to the failure-resolution temporary artifact location.
- Host validates RecoveryArtifact, allowed decision, artifact path, conflict markers, and Git state before running `git add` and `git rebase --continue`.
- Successful recovery appends Attempt Log entries, retries or completes Base Refresh, preserves Builder completion, and invalidates Review/downstream state.
- Malformed artifacts, agent failures, unsupported decisions, exhausted budget, PublishedHistoryRisk, and security-sensitive failures hand off or fail safely.

## Contract decisions

- Decision: Failure Resolution Agent is one general AI agent configured under `strategy.failureResolution`.
- Source of truth: DEC-0007 / DEC-0008
- Decision: Agent receives structured FailureResolutionPacket, not loose prompt-only context.
- Source of truth: DEC-0010
- Decision: Agent writes RecoveryArtifact markdown with required parseable JSON block.
- Source of truth: DEC-0011
- Decision: Host evaluates RecoveryDecision and keeps orchestration authority.
- Source of truth: DEC-0012
- Decision: First slice executes `RETRY_STAGE`, `HANDOFF_TO_HUMAN`, and `FAIL_RUN`; unsupported executable decisions route safely.
- Source of truth: DEC-0013 / PRD-001
- Decision: Host owns Git state transitions after AI repair.
- Source of truth: DEC-0023
- Decision: Agent, not host, owns repair verification command execution and reports it in RecoveryArtifact.
- Source of truth: DEC-0026 / DEC-0027

## Regression contract (CRITICAL)

- Existing behavior:
  - What currently works: Host runs `git add` and `git rebase --continue` after agent-edited conflict files.
  - Why it is at risk: Legacy conflict loop is being replaced by Failure Resolution Agent recovery.
  - Test that protects it: New Failure Resolution Agent recovery test must assert host still calls `git add` for changed/conflicted paths and `git rebase --continue` after valid artifact.
  - Must not change: Agent must not own rebase continuation.
- Existing behavior:
  - What currently works: Successful Base Refresh after existing Builder completion preserves Builder completion and clears Review progress through `invalidateAfterBaseRefresh(...)`.
  - Why it is at risk: Recovery path can bypass the existing refreshed path.
  - Test that protects it: Issue Runner test for successful conflict recovery must assert Builder remains complete and Review lifetime iterations reset to `0`.
  - Must not change: Builder completion persists; Review/downstream state is invalidated.
- Existing behavior:
  - What currently works: Existing non-conflict Base Refresh resume path skips Builder when state says Builder completed.
  - Why it is at risk: Recovery dispatch changes `startIssueRun(...)` branching.
  - Test that protects it: Existing stale refresh and resume tests in `issue.test.ts` must continue to pass.
  - Must not change: Non-conflict resume behavior.

## Step-by-step implementation

1. pourkit/commands/failure-resolution.test.ts / "passes FailureResolutionPacket to execution provider"
   - Action: add test
   - Given: A `RebaseConflict` StageFailure and `strategy.failureResolution` config.
   - When: `runFailureResolutionOnce(...)` runs.
   - Then: execution provider receives stage `failureResolution`, configured agent/model, artifact path, and a prompt/artifact containing the serialized packet.
   - Notes: Use `FakeExecutionProvider` pattern from conflict-resolution tests.
   - Constraints: Do not use `strategy.conflictResolution`.
   ```ts
   expect(provider.lastOptions?.stage).toBe("failureResolution");
   expect(provider.lastOptions?.artifactPath).toBe(".pourkit/.tmp/failure-resolution/attempt-1.md");
   ```
2. pourkit/commands/failure-resolution.test.ts / "valid artifact continues host-owned rebase"
   - Action: add test
   - Given: Agent writes a valid RecoveryArtifact with `RETRY_STAGE`, changed files, and verification notes.
   - When: recovery runner validates the artifact.
   - Then: host calls `git add` and `git rebase --continue`, then reports success.
   - Notes: Include conflicted file content without conflict markers.
   - Constraints: Do not run configured verification commands from host.
   ```ts
   expect(execCaptureMock).toHaveBeenCalledWith("git", ["add", "test-file.ts"], expect.anything());
   expect(execCaptureMock).toHaveBeenCalledWith("git", ["rebase", "--continue"], expect.anything());
   ```
3. pourkit/commands/failure-resolution.test.ts / "malformed artifact records RecoveryArtifactInvalid"
   - Action: add test
   - Given: Agent succeeds but writes malformed RecoveryArtifact markdown.
   - When: recovery runner validates the artifact.
   - Then: result fails with `RecoveryArtifactInvalid` and no `git rebase --continue` call occurs.
   - Notes: This protects host authority and artifact protocol.
   - Constraints: Do not fall back to parsing prose.
   ```ts
   expect(result).toMatchObject({ status: "failed", failureType: "RecoveryArtifactInvalid" });
   ```
4. pourkit/commands/issue.test.ts / "base refresh conflict invokes Failure Resolution Agent"
   - Action: modify
   - Given: Existing Worktree Base Refresh returns `RebaseConflict` and recovery budget remains.
   - When: `runIssueCommand(...)` starts.
   - Then: execution provider receives `failureResolution`, not `conflictResolution`, and Builder is not rerun.
   - Notes: Replace or add beside legacy conflict-resolution integration tests.
   - Constraints: Do not assert on exact prompt prose.
   ```ts
   expect(executionProvider.calls.some((call) => call.stage === "failureResolution")).toBe(true);
   expect(executionProvider.calls.some((call) => call.stage === "conflictResolution")).toBe(false);
   ```
5. pourkit/commands/issue.test.ts / "successful conflict recovery invalidates review state"
   - Action: modify
   - Given: Worktree Run State has Builder complete and Review progress recorded.
   - When: Failure Resolution Agent recovery succeeds.
   - Then: persisted state keeps Builder complete and resets Review/downstream state.
   - Notes: Assert same semantics as `invalidateAfterBaseRefresh(...)`.
   - Constraints: Do not rerun Builder.
   ```ts
   expect(state.completedStages.builder).toBe(true);
   expect(state.review.lifetimeIterations).toBe(0);
   expect(state.review.lastVerdict).toBeUndefined();
   ```
6. pourkit/commands/failure-resolution.ts / runFailureResolutionOnce(...)
   - Action: add
   - Given: StageFailure, policy budget, and target Strategy.
   - When: called by Issue Runner.
   - Then: it writes/validates FailureResolutionPacket, invokes configured agent, reads RecoveryArtifact, and returns host-action result.
   - Notes: Build prompt from configured `promptTemplate` plus structured packet and artifact path.
   - Constraints: Do not use legacy conflict-resolution artifact protocol.
7. pourkit/commands/failure-resolution.ts / runFailureResolutionForStageFailure(...)
   - Action: add
   - Given: `RebaseConflict` and remaining budget.
   - When: agent recommends `RETRY_STAGE`.
   - Then: host validates files, conflict markers, allowed decision, and continues rebase.
   - Notes: Append Attempt Log entries for original failure and recovery outcome.
   - Constraints: Do not perform host build/test/lint verification.
8. pourkit/commands/issue-run.ts / startIssueRun(...)
   - Action: modify
   - Given: Base Refresh Stage Attempt returns `RebaseConflict`.
   - When: policy allows AI recovery.
   - Then: call Failure Resolution Agent recovery via `strategy.failureResolution`; route failure/exhaustion to existing failure/handoff transition.
   - Notes: Remove `runConflictResolutionLoop(...)` usage from this path.
   - Constraints: PublishedHistoryRisk and security-sensitive failures must bypass agent recovery.
9. pourkit/commands/conflict-resolution.ts / runConflictResolutionLoop(...)
   - Action: delete
   - Given: Base Refresh no longer uses legacy Conflict Resolution Agent.
   - When: codebase is searched for `runConflictResolutionLoop(...)`.
   - Then: no production call sites remain.
   - Notes: Delete module and tests when no longer referenced.
   - Constraints: Do not remove unrelated conflict artifact parser code until references are gone.

## Contracts / interfaces

```ts
export type FailureResolutionRunResult =
  | { status: "completed"; attempts: number; artifactPath: string }
  | { status: "handoff"; attempts: number; message: string }
  | { status: "failed"; attempts: number; message: string; failureType?: StageFailureType }
  | { status: "exhausted"; attempts: number; message: string };

export interface RunFailureResolutionOnceOptions {
  executionProvider: ExecutionProvider;
  config: PourkitConfig;
  target: Target;
  issue: IssueData;
  branchName: string;
  worktreePath: string;
  repoRoot: string;
  failure: StageFailure;
  attempt: number;
  logger: PourkitLogger;
}
```

## Edge cases

- Agent succeeds but artifact is missing or malformed.
- Agent recommends unsupported `RESUME_FROM_STAGE` or `MARK_STAGE_COMPLETE`.
- `git rebase --continue` fails with no remaining conflicted paths.

## Validation

- New behavior test: Base Refresh conflict invokes Failure Resolution Agent and valid artifact continues rebase.
- Regression contract test: host still owns `git add` and `git rebase --continue`; Builder remains complete while Review/downstream state invalidates.
- Existing command that should still pass: Issue Runner resume tests and non-conflict Base Refresh tests.
- Manual/example verification: inspect generated FailureResolutionPacket and RecoveryArtifact path.

## Out of scope

- Do not add generic recovery beyond Base Refresh.
- Do not execute `RESUME_FROM_STAGE` or `MARK_STAGE_COMPLETE`.
- Do not move Effect runtime to CLI edge.

## Priority

feature

## Acceptance criteria

- [ ] Base Refresh conflict path invokes Failure Resolution Agent through `strategy.failureResolution`.
- [ ] FailureResolutionPacket and RecoveryArtifact are schema-validated before host action.
- [ ] Host continues rebase only after valid artifact and safe Git state.
- [ ] Recovery failures append Attempt Log entries and consume original failure budget.
- [ ] Successful recovery preserves Builder completion and invalidates Review/downstream state.
- [ ] Legacy `runConflictResolutionLoop(...)` is no longer used by Base Refresh.

## Blocked by

None — can start immediately.
