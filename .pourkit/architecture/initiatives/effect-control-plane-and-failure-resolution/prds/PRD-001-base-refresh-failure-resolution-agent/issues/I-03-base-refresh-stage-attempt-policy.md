# PRD-001 / I-03: Model Base Refresh as a Stage Attempt

## Parent

PRD-001: Base Refresh + Failure Resolution Agent

## Source of truth for behavior

Explicit new contract, DEC-0001 through DEC-0006, DEC-0014 through DEC-0016, DEC-0021, DEC-0022, DEC-0024, existing Base Refresh behavior, context glossary.

## What to build

Wrap existing Base Refresh behavior in a typed Stage Attempt so clean refresh, rebase conflict, and published-history risk become policy-routable outcomes.

## Affected code paths

- pourkit/commands/base-refresh.ts [inferred]
  - Class/Module: BaseRefreshResult, RefreshStaleIssueBranchOptions
  - Functions/Methods: isIssueBranchStale(...), refreshStaleIssueBranch(...), invalidateAfterBaseRefresh(...)
  - New: No
- pourkit/commands/base-refresh.test.ts [inferred]
  - Class/Module: Base Refresh tests
  - Functions/Methods: refreshStaleIssueBranch(...)
  - New: Yes
- pourkit/failure-resolution/domain.ts [inferred]
  - Class/Module: StageAttempt, StageFailure
  - Functions/Methods: createBaseRefreshStageAttempt(...), classifyBaseRefreshFailure(...)
  - New: No
- pourkit/commands/issue-run.ts [inferred]
  - Class/Module: Issue Runner startup flow
  - Functions/Methods: startIssueRun(...)
  - New: No

## Current behavior

- `refreshStaleIssueBranch(...)` returns plain statuses such as `skipped-current`, `refreshed`, `conflicted`, and `refused-published-history`.
- Published branch history risk throws an error from the Issue Runner path.
- Rebase conflicts either enter legacy conflict resolution or hand off without a typed StageFailure record.

## Desired behavior

- Base Refresh attempt produces typed Stage Attempt success or StageFailure output.
- Rebase conflicts classify as `RebaseConflict` with conflicted paths and failure summary/details.
- Published-history risk classifies as `PublishedHistoryRisk` and bypasses AI recovery to Human Handoff or safe failure.

## Contract decisions

- Decision: Base Refresh is the first Effect control-plane island.
- Source of truth: DEC-0004
- Decision: Base Refresh is modeled as a formal Stage Attempt.
- Source of truth: DEC-0022
- Decision: PublishedHistoryRisk bypasses AI recovery.
- Source of truth: DEC-0014 / DEC-0015 / PRD-001
- Decision: Defects do not route to Failure Resolution Agent.
- Source of truth: DEC-0016

## Regression contract (CRITICAL)

- Existing behavior:
  - What currently works: Clean stale Worktree branches rebase with `git rebase --autostash` and return refreshed behavior.
  - Why it is at risk: Base Refresh result handling changes from status returns to Stage Attempt output.
  - Test that protects it: New Base Refresh test for clean stale branch must assert `git rebase --autostash` is still called and success maps to refreshed Stage Attempt output.
  - Must not change: Git command `git rebase --autostash` and stale-check behavior.
- Existing behavior:
  - What currently works: Current Worktrees skip Base Refresh when base is already an ancestor of HEAD.
  - Why it is at risk: Stage Attempt wrapper could run recovery policy for non-stale branches.
  - Test that protects it: New Base Refresh test for current branch must assert no rebase command and skipped/current success output.
  - Must not change: Non-stale Worktrees must not rebase.

## Step-by-step implementation

1. pourkit/commands/base-refresh.test.ts / "skips current branch without rebase"
   - Action: add test
   - Given: `git merge-base --is-ancestor` succeeds.
   - When: Base Refresh Stage Attempt runs.
   - Then: result is successful skipped/current output and `git rebase --autostash` is not called.
   - Notes: Mock `execCapture(...)` as current command tests do.
   - Constraints: Do not require an execution provider.
   ```ts
   expect(result).toMatchObject({ ok: true });
   expect(execCaptureMock).not.toHaveBeenCalledWith("git", expect.arrayContaining(["rebase"]), expect.anything());
   ```
2. pourkit/commands/base-refresh.test.ts / "classifies rebase conflict as RebaseConflict"
   - Action: add test
   - Given: stale branch rebase fails and `git status --porcelain` returns conflicted paths.
   - When: Base Refresh Stage Attempt runs.
   - Then: result is failed with StageFailure type `RebaseConflict` and conflicted path details.
   - Notes: Use existing conflict path regex behavior as expected observable output.
   - Constraints: Do not invoke Failure Resolution Agent in this issue.
   ```ts
   expect(result).toMatchObject({ ok: false, failure: { type: "RebaseConflict" } });
   ```
3. pourkit/commands/base-refresh.test.ts / "classifies published history as PublishedHistoryRisk"
   - Action: add test
   - Given: existing PR metadata is present for the branch.
   - When: Base Refresh Stage Attempt sees stale branch.
   - Then: result is failed with StageFailure type `PublishedHistoryRisk`.
   - Notes: Preserve existing refusal when a PR exists.
   - Constraints: Do not call `git rebase --autostash` after published risk is detected.
   ```ts
   expect(result).toMatchObject({ ok: false, failure: { type: "PublishedHistoryRisk" } });
   ```
4. pourkit/failure-resolution/domain.ts / StageAttempt helpers
   - Action: modify
   - Given: Base Refresh needs typed attempt output.
   - When: Base Refresh adapter runs.
   - Then: it returns a Stage Attempt success or StageFailure result.
   - Notes: Keep a small adapter around existing Base Refresh implementation.
   - Constraints: Do not migrate unrelated runner stages to Effect.
5. pourkit/commands/base-refresh.ts / refreshStaleIssueBranch(...)
   - Action: modify
   - Given: Existing Base Refresh logic detects staleness, clean rebase, conflict, and published history.
   - When: it is used by the Stage Attempt adapter.
   - Then: its observable Git behavior stays unchanged while typed classification is available.
   - Notes: Minimal change is preferred; keep existing function if useful as an adapter.
   - Constraints: Do not change conflict path extraction regex unless tests require it.
6. pourkit/commands/issue-run.ts / startIssueRun(...)
   - Action: modify
   - Given: Existing Worktree or existing branch is stale.
   - When: Issue Runner starts Base Refresh.
   - Then: it consumes the Stage Attempt output instead of raw status strings.
   - Notes: PublishedHistoryRisk should move through failure/handoff path, not agent recovery.
   - Constraints: Do not wire RebaseConflict agent recovery in this issue.

## Contracts / interfaces

```ts
export type StageAttemptResult =
  | { ok: true; stage: "baseRefresh"; status: "skipped-current" | "refreshed" }
  | { ok: false; stage: "baseRefresh"; failure: StageFailure };

export type StageFailure =
  | {
      type: "RebaseConflict";
      stage: "baseRefresh";
      message: string;
      conflictedPaths: string[];
      fingerprint: string;
    }
  | {
      type: "PublishedHistoryRisk";
      stage: "baseRefresh";
      prNumber: number;
      prState: "OPEN" | "CLOSED" | "MERGED";
      fingerprint: string;
    };
```

## Edge cases

- Failure to read conflicted paths still produces `RebaseConflict` with empty conflicted paths and original message.
- Published-history risk must win over AI recovery when PR metadata exists.
- Unexpected exceptions remain defects and do not route to Failure Resolution Agent.

## Validation

- New behavior test: Rebase conflict and published-history risk classify to typed StageFailure.
- Regression contract test: clean stale rebase and non-stale skip behavior remain unchanged.
- Existing command that should still pass: Issue Runner resume tests for existing Worktree behavior.
- Manual/example verification: inspect logs for unchanged rebase command labels.

## Out of scope

- Do not invoke Failure Resolution Agent.
- Do not add Attempt Log writes beyond what is needed by tests in this issue.
- Do not migrate Reviewer, Refactor, Finalizer, or PR stages.

## Priority

feature

## Acceptance criteria

- [ ] Base Refresh exposes Stage Attempt success/failure output.
- [ ] Rebase conflicts classify as `RebaseConflict` with conflicted paths.
- [ ] Published PR history risk classifies as `PublishedHistoryRisk` and bypasses recovery.
- [ ] Clean rebase and non-stale skip behavior remain unchanged.

## Blocked by

None — can start immediately.
