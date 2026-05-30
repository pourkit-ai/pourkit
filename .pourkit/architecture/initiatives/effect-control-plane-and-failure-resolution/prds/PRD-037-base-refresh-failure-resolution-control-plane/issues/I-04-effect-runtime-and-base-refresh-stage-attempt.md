## Parent

Parent PRD: #74 (PRD-037: Base Refresh failure resolution control plane)

## Source of truth for behavior

Explicit new contract defined in PRD-037 implementation decisions, DEC-0001 through DEC-0006, DEC-0022, DEC-0024, DEC-0025. Effect runtime patterns from `effect-ts` skill (runtime-execution, error-management references). Prior art: existing `issue-run.ts` Base Refresh flow and `refreshStaleIssueBranch` implementation.

## What to build

Add Effect v3 as a project dependency and create a narrow Effect runtime boundary inside the existing Issue Runner for the Base Refresh stage. Model Base Refresh as a first-class Stage Attempt with typed StageFailure outcomes (using types from I-03). Integrate the Attempt Log (from I-02) to record stage attempts. The Effect runtime wraps the existing `refreshStaleIssueBranch` function — the old implementation serves as an adapter behind the Effect service interface. After successful refresh, the existing `invalidateAfterBaseRefresh` is called. The Effect boundary is local to the issue-run.ts Base Refresh path.

## Affected code paths

- package.json (root)
  - Dependencies: Add `effect` package
  - New: Yes (dependency)
- pourkit/failure-resolution/effect-runtime.ts (new)
  - Module: New module
  - Types: `BaseRefreshStageAttempt`, `EffectRuntime`
  - Functions: `createEffectRuntime()`, `runBaseRefreshAttempt()`
  - New: Yes
- pourkit/failure-resolution/stage-attempt.ts (new)
  - Module: New module
  - Types: `StageAttemptId`, `StageAttemptRecord`
  - Functions: `createStageAttemptId()`, `recordStageAttempt()`
  - New: Yes
- pourkit/commands/issue-run.ts
  - Functions: `startIssueRun()` — modify Base Refresh block to use Effect runtime
  - New: No (modify)
- pourkit/commands/base-refresh.ts
  - Functions: `refreshStaleIssueBranch()` — unchanged (adapter target)
  - New: No (unchanged)
- pourkit/failure-resolution/effect-runtime.test.ts (new)
  - New: Yes
- pourkit/failure-resolution/stage-attempt.test.ts (new)
  - New: Yes

## Current behavior

- Base Refresh runs as a plain async call to `refreshStaleIssueBranch` inside `startIssueRun` in issue-run.ts.
- Base Refresh results are plain `BaseRefreshResult` discriminated union with string status.
- No Effect runtime exists in the codebase.
- No Stage Attempt model exists.
- No Attempt Log integration exists for Base Refresh.
- Conflict recovery after Base Refresh is handled by `runConflictResolutionLoop`.

## Desired behavior

- Effect v3 is a project dependency.
- A narrow Effect runtime is created inside `startIssueRun` for the Base Refresh stage.
- Base Refresh is modeled as a `StageAttempt` with typed outcomes: wraps `refreshStaleIssueBranch` and maps results to Effect `Exit<StageFailure, BaseRefreshSuccess>`.
- Stage attempt is recorded in the Attempt Log on both success and failure.
- The Effect boundary is local to the Base Refresh code path — other stages remain unchanged.
- Existing `refreshStaleIssueBranch` function serves as adapter, unchanged.
- `invalidateAfterBaseRefresh` is still called on successful refresh via the Effect pipeline.

## Contract decisions

- Decision: Effect v3 is added as a dependency (`effect` package). Import barrel imports (`from "effect"`). Source: PRD-037 Implementation Decisions, DEC-0004.
- Decision: Effect runtime is created locally inside `startIssueRun` via `Effect.runPromiseExit`. Source: DEC-0004, Effect runtime-execution patterns (local runtime, not CLI edge).
- Decision: The existing `refreshStaleIssueBranch` is kept as-is and adapted through an Effect wrapper. Source: DEC-0001 (old implementation as adapters).
- Decision: Base Refresh success is a `BaseRefreshSuccess` type (not an Effect type) — the Effect boundary produces it as `Exit<StageFailure, BaseRefreshSuccess>`. Source: PRD-037.
- Decision: Stage attempt ID uses a UUID or timestamp-based string. Source: new convention.
- Decision: `invalidateAfterBaseRefresh` is called in the `onSuccess` path of the Effect pipeline. Source: DEC-0025.

## Regression contract (CRITICAL)

- Existing behavior:
  - What currently works: `refreshStaleIssueBranch` in `pourkit/commands/base-refresh.ts` is called directly from `startIssueRun` and returns `BaseRefreshResult`.
  - Why it is at risk: The Effect wrapper replaces the direct call — if the wrapper is buggy, Base Refresh could fail.
  - Test that protects it: Existing issue.test.ts tests for "refreshes stale existing worktree branch" and "clears downstream state after stale base refresh" must still pass.
  - Must not change: `refreshStaleIssueBranch` function signature and behavior. `invalidateAfterBaseRefresh` function signature and behavior.
- Existing behavior:
  - What currently works: `isIssueBranchStale` checks staleness with `git merge-base --is-ancestor`.
  - Why it is at risk: The Effect wrapper calls `refreshStaleIssueBranch` which internally calls `isIssueBranchStale`. If the wrapper changes how arguments are passed, staleness check could break.
  - Test that protects it: "Base Refresh rebases onto remote-backed Target base" test in issue.test.ts.
  - Must not change: The git commands executed during Base Refresh (merge-base --is-ancestor, rebase --autostash).
- Existing behavior:
  - What currently works: `startIssueRun` handles `refreshed`, `conflicted`, `refused-published-history`, and `skipped-current` statuses.
  - Why it is at risk: The Effect wrapper changes the result handling path.
  - Test that protects it: All existing issue.test.ts Base Refresh tests must pass — including skipped, refreshed, conflicted (without conflictResolution), published-history-refused.
  - Must not change: The issue-run flow for non-conflicted Base Refresh outcomes.
- Existing behavior:
  - What currently works: `pourkit/commands/base-refresh.ts` and `pourkit/commands/issue-run.ts` do not import from `effect`.
  - Why it is at risk: Adding Effect dependency changes module resolution and could affect bundling.
  - Test that protects it: Existing build and test commands (`npm run build`, `npm run typecheck`, `npm test`) must pass.
  - Must not change: Build configuration, test configuration, existing module imports.

## Step-by-step implementation

1. package.json / Add effect dependency
   - Action: add
   - Given: No effect dependency exists.
   - When: `npm install effect` is run.
   - Then: `effect` appears in dependencies or devDependencies with a compatible v3 version.
   - Notes: Use `npm install effect` at root. Verify with `npm run typecheck` and `npm test`.
   - Constraints: Use latest stable Effect v3.x.

2. pourkit/failure-resolution/stage-attempt.ts / Define StageAttempt types
   - Action: add
   - Given: No StageAttempt types exist.
   - When: Module is created.
   - Then: `StageAttemptId` is `string`. `StageAttemptRecord` has `id`, `stage`, `startedAt`, `completedAt?`, `outcome?`, `failure?: StageFailure`. `createStageAttemptId()` returns a unique ID string. `recordStageAttempt(worktreePath, record)` writes to Attempt Log via I-02's `writeAttemptLog`.
   - Notes: StageAttemptRecord is the durable record; it's written to the Attempt Log.
   - Constraints: Reuses I-02's `writeAttemptLog` and `computeFailureFingerprint`.

   ```ts
   import { writeAttemptLog, computeFailureFingerprint } from "../shared/attempt-log";

   export type StageAttemptId = string;

   export interface StageAttemptRecord {
     readonly id: StageAttemptId;
     readonly stage: string;
     readonly startedAt: string;
     readonly completedAt?: string;
     readonly outcome?: "success" | "failure" | "handoff";
     readonly failureFingerprint?: string;
     readonly failureType?: string;
   }

   export function createStageAttemptId(): StageAttemptId {
     return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
   }

   export function recordStageAttempt(
     worktreePath: string,
     record: StageAttemptRecord
   ): void {
     writeAttemptLog(worktreePath, {
       attemptType: "stage",
       fingerprint: record.failureFingerprint ?? `${record.stage}:success`,
       timestamp: record.completedAt ?? new Date().toISOString(),
       stage: record.stage,
       outcome: record.outcome === "handoff" ? "handoff" : record.outcome === "success" ? "success" : "failure",
     });
   }
   ```
   - Constraints: Import from attempt-log module, not duplicate it.

3. pourkit/failure-resolution/effect-runtime.ts / Create Effect wrapper for Base Refresh
   - Action: add
   - Given: `refreshStaleIssueBranch` exists as async function.
   - When: `runBaseRefreshAttempt(options)` is called.
   - Then: Calls `refreshStaleIssueBranch` inside an Effect. Maps `BaseRefreshResult` to `Effect<BaseRefreshSuccess, StageFailure>`. Creates a StageAttempt, records outcome. Returns Effect.
   - Notes: This is the Effect boundary. `BaseRefreshSuccess` has `refreshResult: "refreshed" | "skipped-current"`. Failure maps: `conflicted` → `RebaseConflict`, `refused-published-history` → `PublishedHistoryRisk`.
   - Constraints: Must not modify `refreshStaleIssueBranch`. Must handle all `BaseRefreshResult` variants.

   ```ts
   import { Effect, Exit } from "effect";
   import { refreshStaleIssueBranch, type BaseRefreshResult } from "../commands/base-refresh";
   import { RebaseConflict, PublishedHistoryRisk, type StageFailure } from "./types";
   import { createStageAttemptId, recordStageAttempt } from "./stage-attempt";

   export interface BaseRefreshOptions {
     worktreePath: string;
     baseBranch: string;
     localGitBaseRef: string;
     logger: PourkitLogger;
     prNumber?: number;
     prState?: "OPEN" | "CLOSED" | "MERGED";
   }

   export interface BaseRefreshSuccess {
     readonly status: "refreshed" | "skipped-current";
   }

   function baseRefreshEffect(options: BaseRefreshOptions): Effect.Effect<BaseRefreshSuccess, StageFailure> {
     return Effect.promise(() => refreshStaleIssueBranch(options)).pipe(
       Effect.flatMap((result: BaseRefreshResult) => {
         switch (result.status) {
           case "refreshed":
             return Effect.succeed<BaseRefreshSuccess>({ status: "refreshed" });
           case "skipped-current":
             return Effect.succeed<BaseRefreshSuccess>({ status: "skipped-current" });
           case "conflicted":
             return Effect.fail(new RebaseConflict({
               conflictedPaths: result.conflictedPaths,
               message: result.message,
             }));
           case "refused-published-history":
             return Effect.fail(new PublishedHistoryRisk({
               prNumber: result.prNumber,
               prState: result.prState,
             }));
         }
       })
     );
   }

   export async function runBaseRefreshAttempt(
     options: BaseRefreshOptions & { worktreePath: string }
   ): Promise<Exit.Exit<StageFailure, BaseRefreshSuccess>> {
     const attemptId = createStageAttemptId();
     const startedAt = new Date().toISOString();

     const program = baseRefreshEffect(options).pipe(
       Effect.tapBoth({
         onSuccess: (success) =>
           Effect.sync(() => {
             recordStageAttempt(options.worktreePath, {
               id: attemptId,
               stage: "baseRefresh",
               startedAt,
               completedAt: new Date().toISOString(),
               outcome: "success",
             });
           }),
         onFailure: (failure) =>
           Effect.sync(() => {
             recordStageAttempt(options.worktreePath, {
               id: attemptId,
               stage: "baseRefresh",
               startedAt,
               completedAt: new Date().toISOString(),
               outcome: "failure",
               failureFingerprint: computeFailureFingerprint("baseRefresh", failure._tag),
               failureType: failure._tag,
             });
           }),
       })
     );

     return Effect.runPromiseExit(program);
   }
   ```
   - Constraints: Use `Effect.runPromiseExit` per Effect patterns. Do not call `runPromise` — callers need `Exit` for branching.

4. pourkit/commands/issue-run.ts / Modify startIssueRun to use Effect runtime for Base Refresh
   - Action: modify
   - Given: `startIssueRun` calls `refreshStaleIssueBranch` directly.
   - When: The Base Refresh block runs.
   - Then: Calls `runBaseRefreshAttempt` instead of `refreshStaleIssueBranch`. On `Exit.success`, handles `refreshed`/`skipped-current` same as before (state invalidation). On `Exit.failure`, dispatches `RebaseConflict` to... (the failure dispatch is handled by I-05 — for I-04, just propagate the error).
   - Notes: For I-04, the failure path for RebaseConflict should throw the error (or hand off to human) — the FR agent integration is I-05. So the current conflict path (which checks `strategy.conflictResolution`) should remain untouched for now. I-05 will replace it.
   - Constraints: Do not change the conflict resolution flow yet — that is I-05. Only replace the Base Refresh call and success path.

   ```ts
   // In startIssueRun, replace the call:
   // From:
   // const refreshResult = await refreshStaleIssueBranch({...});
   // To:
   import { runBaseRefreshAttempt } from "../failure-resolution/effect-runtime";

   const exit = await runBaseRefreshAttempt({
     worktreePath: resolution.worktreePath!,
     baseBranch: target.baseBranch,
     localGitBaseRef: resolution.baseRef,
     logger,
     prNumber: existingPr?.number,
     prState: existingPr?.state,
   });

   if (Exit.isSuccess(exit)) {
     const refreshResult = exit.value;
     if (refreshResult.status === "refreshed") {
       // ... existing refreshed handling (invalidateAfterBaseRefresh) ...
     }
     // skipped-current: continue as before
   } else {
     const failure = exit.cause;
     // For I-04: throw the error to maintain existing behavior
     // I-05 will replace this with FR agent dispatch
     if (failure._tag === "Fail" && failure.error instanceof RebaseConflict) {
       // For now, throw to maintain existing conflict path
       // I-05 will route this to FailureResolutionAgent
       throw new Error(`Base refresh failed: ${failure.error.message}`);
     }
     if (failure._tag === "Fail" && failure.error instanceof PublishedHistoryRisk) {
       throw new Error(
         `Cannot auto-refresh published history: PR #${failure.error.prNumber} (${failure.error.prState})`
       );
     }
     // Defect or unknown failure
     Effect.runPromiseExit(program).pipe(
       Effect.catchAllDefect(() => Effect.sync(() => { /* log defect */ }))
     );
     throw new Error("Base refresh failed with unexpected error");
   }
   ```
   - Constraints: The existing behavior for `refreshed`, `skipped-current`, and `refused-published-history` routes must be preserved. The conflict path currently handled by `strategy.conflictResolution` should temporarily fall through to the "no conflictResolution" path (human handoff).

5. pourkit/failure-resolution/effect-runtime.test.ts / Add Base Refresh Effect wrapper tests
   - Action: add test
   - Given: Mocked `refreshStaleIssueBranch` returning various `BaseRefreshResult` values.
   - When: `runBaseRefreshAttempt` is called.
   - Then: Returns correct `Exit` for each result variant.
   - Notes: Use `vi.mock` to mock `refreshStaleIssueBranch`.

   ```ts
   it("returns success Exit for refreshed result", async () => {
     vi.mocked(refreshStaleIssueBranch).mockResolvedValue({ status: "refreshed" });
     const exit = await runBaseRefreshAttempt({ worktreePath: "/tmp", baseBranch: "main", localGitBaseRef: "origin/main", logger: mockLogger });
     expect(Exit.isSuccess(exit)).toBe(true);
     if (Exit.isSuccess(exit)) expect(exit.value.status).toBe("refreshed");
   });

   it("returns failure Exit for conflicted result", async () => {
     vi.mocked(refreshStaleIssueBranch).mockResolvedValue({ status: "conflicted", message: "conflict", conflictedPaths: ["f.ts"] });
     const exit = await runBaseRefreshAttempt({ worktreePath: "/tmp", baseBranch: "main", localGitBaseRef: "origin/main", logger: mockLogger });
     expect(Exit.isFailure(exit)).toBe(true);
   });

   it("maps refused-published-history to PublishedHistoryRisk", async () => {
     vi.mocked(refreshStaleIssueBranch).mockResolvedValue({ status: "refused-published-history", prNumber: 1, prState: "OPEN" });
     const exit = await runBaseRefreshAttempt({ worktreePath: "/tmp", baseBranch: "main", localGitBaseRef: "origin/main", logger: mockLogger });
     expect(Exit.isFailure(exit)).toBe(true);
   });

   it("records stage attempt in Attempt Log on success", async () => {
     vi.mocked(refreshStaleIssueBranch).mockResolvedValue({ status: "refreshed" });
     const dir = mkdtempSync(join(tmpdir(), "effect-test-"));
     try {
       await runBaseRefreshAttempt({ worktreePath: dir, baseBranch: "main", localGitBaseRef: "origin/main", logger: mockLogger });
       const log = readAttemptLog(dir);
       expect(log).toHaveLength(1);
       expect(log[0].attemptType).toBe("stage");
       expect(log[0].outcome).toBe("success");
     } finally {
       rmSync(dir, { recursive: true, force: true });
     }
   });
   ```

6. pourkit/failure-resolution/effect-runtime.test.ts / Add stage attempt recording test
   - Action: add test
   - Given: Base Refresh that fails with RebaseConflict.
   - When: `runBaseRefreshAttempt` is called.
   - Then: Attempt Log has a stage entry with outcome "failure" and fingerprint "baseRefresh:RebaseConflict".
   - Notes: Uses `readAttemptLog` from I-02.

   ```ts
   it("records failed stage attempt in Attempt Log", async () => {
     vi.mocked(refreshStaleIssueBranch).mockResolvedValue({ status: "conflicted", message: "merge conflict", conflictedPaths: ["f.ts"] });
     const dir = mkdtempSync(join(tmpdir(), "effect-test-fail-"));
     try {
       await runBaseRefreshAttempt({ worktreePath: dir, baseBranch: "main", localGitBaseRef: "origin/main", logger: mockLogger });
       const log = readAttemptLog(dir);
       expect(log).toHaveLength(1);
       expect(log[0].attemptType).toBe("stage");
       expect(log[0].outcome).toBe("failure");
       expect(log[0].fingerprint).toBe("baseRefresh:RebaseConflict");
     } finally {
       rmSync(dir, { recursive: true, force: true });
     }
   });
   ```

7. pourkit/commands/issue.test.ts / Regression — Base Refresh tests still pass
   - Action: modify (regression)
   - Given: Existing Base Refresh test setup.
   - When: Tests run.
   - Then: "refreshes stale existing worktree branch", "clears downstream state after stale base refresh", "Base Refresh rebases onto remote-backed Target base", "published history refusal still prevents rebase", "skips base refresh when existing worktree branch is current" all pass.
   - Notes: The Effect wrapper should not change observable behavior for the success and skipped-current paths. The existing test mocks `execCapture` and `refreshStaleIssueBranch` — they may need adjustment if the code path now calls through Effect.
   - Constraints: Do not remove or alter existing test assertions. Only adjust mocks if necessary.

   Planner uncertainty: The existing issue.test.ts mocks `execCapture` directly. With the Effect wrapper, `refreshStaleIssueBranch` is still called internally by `runBaseRefreshAttempt`. The test should work if `refreshStaleIssueBranch` is mocked via vi.mock. The builder should verify that existing issue.test.ts Base Refresh tests still pass without changes to test assertions.

## Contracts / interfaces

```ts
// StageAttempt types (stage-attempt.ts)
export type StageAttemptId = string;

export interface StageAttemptRecord {
  readonly id: StageAttemptId;
  readonly stage: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly outcome?: "success" | "failure" | "handoff";
  readonly failureFingerprint?: string;
  readonly failureType?: string;
}

export function createStageAttemptId(): StageAttemptId;
export function recordStageAttempt(worktreePath: string, record: StageAttemptRecord): void;

// Effect runtime types (effect-runtime.ts)
export interface BaseRefreshOptions {
  worktreePath: string;
  baseBranch: string;
  localGitBaseRef: string;
  logger: PourkitLogger;
  prNumber?: number;
  prState?: "OPEN" | "CLOSED" | "MERGED";
}

export interface BaseRefreshSuccess {
  readonly status: "refreshed" | "skipped-current";
}

export async function runBaseRefreshAttempt(
  options: BaseRefreshOptions & { worktreePath: string }
): Promise<Exit.Exit<StageFailure, BaseRefreshSuccess>>;
```

## Edge cases

- `refreshStaleIssueBranch` throws an unexpected exception (defect): should be caught by Effect and surfaced as defect in `Exit`.
- Empty worktree path: `refreshStaleIssueBranch` will handle its own validation.
- Both `refreshed` and `skipped-current` success paths: both treated as success exits.

## Validation

- New behavior test: `runBaseRefreshAttempt` returns success Exit for refreshed/skipped.
- New behavior test: `runBaseRefreshAttempt` returns failure Exit for conflicted/refused-published-history.
- New behavior test: Attempt Log records stage attempt entries.
- Regression contract test: Existing issue.test.ts Base Refresh tests still pass.
- Build/test: `npm run build`, `npm run typecheck`, `npm test` pass.

## Out of scope

- FR agent integration for conflict recovery — handled by I-05.
- Effect runtime at CLI application edge — deferred to Slice 3.
- Non-Base-Refresh stage attempts — out of scope per PRD-037.

## Priority

infra

## Acceptance criteria

- [ ] Effect v3 is added as a dependency and `npm run build` / `npm run typecheck` / `npm test` pass.
- [ ] `runBaseRefreshAttempt` wraps `refreshStaleIssueBranch` and returns `Exit<StageFailure, BaseRefreshSuccess>`.
- [ ] All `BaseRefreshResult` variants are mapped to correct StageFailure or BaseRefreshSuccess.
- [ ] Stage attempt is recorded in Attempt Log on both success and failure.
- [ ] Existing issue.test.ts Base Refresh tests pass unchanged.

## Blocked by

- #76 (PRD-037 / I-02: Attempt Log module)
- #77 (PRD-037 / I-03: Failure resolution domain types and validation)
