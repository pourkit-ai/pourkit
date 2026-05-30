## Parent

Parent PRD: #74 (PRD-037: Base Refresh failure resolution control plane)

## Source of truth for behavior

Explicit new contract defined in PRD-037 implementation decisions, DEC-0017, DEC-0018, DEC-0019, DEC-0020. Prior art: existing Worktree Run State module (`pourkit/shared/worktree-run-state.ts`) for runner-owned metadata persistence pattern.

## What to build

Create an append-only Attempt Log at `.pourkit/attempt-log.jsonl` inside the Worktree directory. The log records original stage attempt failures and recovery attempt failures as separate entry types. Recovery attempt failures consume budget scoped to the original failure fingerprint. No nested recovery entries — a recovery failure is recorded as a failure of the recovery attempt attached to the original stage attempt. Entries are newline-delimited JSON (JSONL).

## Affected code paths

- pourkit/shared/attempt-log.ts (new)
  - Module: New module
  - Types: `AttemptLogEntry`, `AttemptLogEntryType` (stage|recovery), `StageAttemptEntry`, `RecoveryAttemptEntry`, `FailureFingerprint`
  - Functions: `writeAttemptLog()`, `recoveryBudgetForFailure()`, `readAttemptLog()`, `getAttemptsForFailure()`
  - New: Yes
- pourkit/shared/attempt-log.test.ts (new)
  - New: Yes

## Current behavior

- No Attempt Log exists. Failure history is not durable beyond Worktree Run State's single `lastFailure` field.
- No recovery budget tracking exists.
- No failure fingerprinting exists.

## Desired behavior

- Attempt Log at `.pourkit/attempt-log.jsonl` records every stage attempt and recovery attempt as JSONL entries.
- Each entry has: attempt type (stage|recovery), failure fingerprint, timestamp (ISO 8601), stage name, outcome (success|failure|handoff), decision (RecoveryDecision value when applicable), and optional artifact reference.
- Recovery budget is computed by counting recovery attempts matching the original failure fingerprint against the configured limit.
- A recovery attempt failure is recorded as a `recovery` entry attached to the original failure fingerprint — no nested recovery entries.
- When budget is exhausted, the caller learns this from `recoveryBudgetForFailure`.

## Contract decisions

- Decision: File path is `.pourkit/attempt-log.jsonl` inside the Worktree directory, alongside `.pourkit/state.json`. Source: DEC-0018.
- Decision: Format is JSONL (one JSON object per line, newline-delimited). Source: DEC-0018.
- Decision: Entry types are `"stage"` for original stage failures and `"recovery"` for recovery attempt failures/outcomes. Source: DEC-0019.
- Decision: Recovery attempts count against the original failure fingerprint, not per-recovery-attempt. Source: DEC-0019.
- Decision: No nested recovery — a recovery failure is attached to the original stage attempt's fingerprint. Source: DEC-0020.
- Decision: Failure fingerprint is a deterministic string derived from stage name and failure type (e.g. `"baseRefresh:RebaseConflict"`). Source: PRD-037, approach matches existing fingerprinting conventions.
- Decision: The log is append-only. No deletion, editing, or rotation in this slice. Source: DEC-0017, "Out of Scope" for rotation.
- Decision: The module is pure TypeScript (no Effect dependency). It will be consumed by Effect-wrapped code later. Source: DEC-0002 (mixed codebase).

## Regression contract (CRITICAL)

- Existing behavior:
  - What currently works: Existing Worktree Run State persists at `.pourkit/state.json` and is read/written by `readWorktreeRunState`/`writeWorktreeRunState`.
  - Why it is at risk: New `.pourkit/attempt-log.jsonl` file could conflict with state.json semantics if the same path or similar naming is accidentally used.
  - Test that protects it: Regression test proves `attempt-log.jsonl` does not overwrite or interfere with `state.json` when both exist in the same worktree.
  - Must not change: `WORKTREE_RUN_STATE_PATH` constant, `readWorktreeRunState`, `writeWorktreeRunState` behavior.
- Existing behavior:
  - What currently works: `.pourkit/` subdirectory operations (mkdir, write, read) work correctly under the Worktree path.
  - Why it is at risk: Writing JSONL in append mode requires proper file handle management.
  - Test that protects it: Existing worktree file operations should continue to work alongside Attempt Log writes.
  - Must not change: The `.pourkit/` directory must remain usable by other modules.

## Step-by-step implementation

1. pourkit/shared/attempt-log.ts / Define AttemptLogEntry types
   - Action: add
   - Given: No attempt log types exist.
   - When: Module is created with type definitions.
   - Then: `AttemptLogEntryType` is `"stage" | "recovery"`. `AttemptLogEntryBase` has `attemptType`, `fingerprint`, `timestamp`, `stage`, `outcome`. `StageAttemptEntry extends AttemptLogEntryBase` with `{ attemptType: "stage" }`. `RecoveryAttemptEntry extends AttemptLogEntryBase` with `{ attemptType: "recovery", artifactRef?: string, decision?: string }`.
   - Notes: Use discriminated union for type safety.
   - Constraints: Types are plain interfaces, no classes.

   ```ts
   export type AttemptLogEntryType = "stage" | "recovery";
   export type AttemptOutcome = "success" | "failure" | "handoff";

   export interface AttemptLogEntryBase {
     readonly attemptType: AttemptLogEntryType;
     readonly fingerprint: string;
     readonly timestamp: string;
     readonly stage: string;
     readonly outcome: AttemptOutcome;
   }

   export interface StageAttemptEntry extends AttemptLogEntryBase {
     readonly attemptType: "stage";
   }

   export interface RecoveryAttemptEntry extends AttemptLogEntryBase {
     readonly attemptType: "recovery";
     readonly artifactRef?: string;
     readonly decision?: string;
   }

   export type AttemptLogEntry = StageAttemptEntry | RecoveryAttemptEntry;
   ```

2. pourkit/shared/attempt-log.ts / Implement writeAttemptLog
   - Action: add
   - Given: A Worktree path and an AttemptLogEntry.
   - When: `writeAttemptLog(worktreePath, entry)` is called.
   - Then: Appends the entry as a single JSON line to `.pourkit/attempt-log.jsonl`, creating the file (and `.pourkit/` directory) if they don't exist.
   - Notes: Use `appendFileSync` (runner-owned, not async). Newline-terminated JSON.
   - Constraints: Must create parent directory if missing (like `writeWorktreeRunState`).

   ```ts
   import { appendFileSync, mkdirSync } from "fs";
   import { join, dirname } from "path";

   export const ATTEMPT_LOG_PATH = ".pourkit/attempt-log.jsonl";

   export function writeAttemptLog(worktreePath: string, entry: AttemptLogEntry): void {
     const logPath = join(worktreePath, ATTEMPT_LOG_PATH);
     mkdirSync(dirname(logPath), { recursive: true });
     appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
   }
   ```

3. pourkit/shared/attempt-log.ts / Implement readAttemptLog
   - Action: add
   - Given: A Worktree path.
   - When: `readAttemptLog(worktreePath)` is called.
   - Then: Reads all lines from `.pourkit/attempt-log.jsonl`, parses each as JSON, filters invalid lines silently, returns `AttemptLogEntry[]`.
   - Notes: Return empty array if file doesn't exist. Skip lines that fail JSON parse.
   - Constraints: Must handle missing file gracefully (return `[]`).

4. pourkit/shared/attempt-log.ts / Implement recoveryBudgetForFailure
   - Action: add
   - Given: A Worktree path, a failure fingerprint, and a maxAttempts limit.
   - When: `recoveryBudgetForFailure(worktreePath, fingerprint, maxAttempts)` is called.
   - Then: Reads the Attempt Log, counts recovery attempt entries matching the fingerprint, returns `{ used: number, remaining: number, exhausted: boolean }`.
   - Notes: `remaining = maxAttempts - used`. `exhausted` when `used >= maxAttempts`.
   - Constraints: Only counts recovery entries, not stage entries. Only counts entries matching the exact fingerprint.

5. pourkit/shared/attempt-log.ts / Implement computeFailureFingerprint
   - Action: add
   - Given: A stage name and failure type identifier.
   - When: `computeFailureFingerprint(stage, failureType)` is called.
   - Then: Returns a deterministic string like `"baseRefresh:RebaseConflict"`.
   - Notes: Simple string interpolation with colon separator. Lowercase stage name.
   ```ts
   export function computeFailureFingerprint(stage: string, failureType: string): string {
     return `${stage.toLowerCase()}:${failureType}`;
   }
   ```
   - Constraints: Must be deterministic (same inputs => same output).

6. pourkit/shared/attempt-log.test.ts / Add tests for Attempt Log
   - Action: add test
   - Given: A temp Worktree directory.
   - When: `writeAttemptLog` is called multiple times, then `readAttemptLog` is called.
   - Then: Entries are stored and retrieved correctly in order.
   - Notes: Test append behavior across multiple writes.

   ```ts
   it("appends entries to attempt-log.jsonl", () => {
     const dir = mkdtempSync(join(tmpdir(), "attempt-log-test-"));
     try {
       writeAttemptLog(dir, {
         attemptType: "stage",
         fingerprint: "baseRefresh:RebaseConflict",
         timestamp: new Date().toISOString(),
         stage: "baseRefresh",
         outcome: "failure",
       });
       writeAttemptLog(dir, {
         attemptType: "recovery",
         fingerprint: "baseRefresh:RebaseConflict",
         timestamp: new Date().toISOString(),
         stage: "baseRefresh",
         outcome: "failure",
       });
       const entries = readAttemptLog(dir);
       expect(entries).toHaveLength(2);
       expect(entries[0].attemptType).toBe("stage");
       expect(entries[1].attemptType).toBe("recovery");
     } finally {
       rmSync(dir, { recursive: true, force: true });
     }
   });
   ```

7. pourkit/shared/attempt-log.test.ts / Add recovery budget test
   - Action: add test
   - Given: Attempt Log with 2 recovery entries for the same fingerprint and maxAttempts=3.
   - When: `recoveryBudgetForFailure` is called.
   - Then: Returns `{ used: 2, remaining: 1, exhausted: false }`.
   - Notes: Also test exhausted case (= maxAttempts) and unknown fingerprint (used: 0).

   ```ts
   it("tracks recovery budget scoped to failure fingerprint", () => {
     const dir = mkdtempSync(join(tmpdir(), "attempt-budget-test-"));
     try {
       const fingerprint = "baseRefresh:RebaseConflict";
       writeAttemptLog(dir, { attemptType: "stage", fingerprint, stage: "baseRefresh", outcome: "failure", timestamp: new Date().toISOString() });
       writeAttemptLog(dir, { attemptType: "recovery", fingerprint, stage: "baseRefresh", outcome: "failure", timestamp: new Date().toISOString() });
       writeAttemptLog(dir, { attemptType: "recovery", fingerprint, stage: "baseRefresh", outcome: "failure", timestamp: new Date().toISOString() });

       const budget = recoveryBudgetForFailure(dir, fingerprint, 3);
       expect(budget).toEqual({ used: 2, remaining: 1, exhausted: false });

       const exhausted = recoveryBudgetForFailure(dir, fingerprint, 2);
       expect(exhausted).toEqual({ used: 2, remaining: 0, exhausted: true });

       const unknown = recoveryBudgetForFailure(dir, "other:fingerprint", 3);
       expect(unknown).toEqual({ used: 0, remaining: 3, exhausted: false });
     } finally {
       rmSync(dir, { recursive: true, force: true });
     }
   });
   ```

8. pourkit/shared/attempt-log.test.ts / Add non-nested recovery test
   - Action: add test
   - Given: Attempt Log with a recovery failure.
   - When: Checking for nested recovery entries.
   - Then: Recovery failure entries have `attemptType: "recovery"` not `"stage"` — no nested recovery tree.
   - Notes: This is a type-level enforcement + behavioral test that recovery entries don't create new stage-level fingerprint groups.

   ```ts
   it("recovery failures are not nested — recorded as recovery entries only", () => {
     const dir = mkdtempSync(join(tmpdir(), "attempt-nested-test-"));
     try {
       const fingerprint = "baseRefresh:RebaseConflict";
       writeAttemptLog(dir, { attemptType: "stage", fingerprint, stage: "baseRefresh", outcome: "failure", timestamp: new Date().toISOString() });
       writeAttemptLog(dir, { attemptType: "recovery", fingerprint, stage: "baseRefresh", outcome: "failure", timestamp: new Date().toISOString() });

       const entries = readAttemptLog(dir);
       const stageEntries = entries.filter(e => e.attemptType === "stage");
       const recoveryEntries = entries.filter(e => e.attemptType === "recovery");
       expect(stageEntries).toHaveLength(1);
       expect(recoveryEntries).toHaveLength(1);
       // Recovery entry does not create its own stage-level fingerprint:
       const budget = recoveryBudgetForFailure(dir, fingerprint, 1);
       expect(budget.used).toBe(1); // recovery counted against original
     } finally {
       rmSync(dir, { recursive: true, force: true });
     }
   });
   ```

9. pourkit/shared/attempt-log.test.ts / Add regression test — no interference with state.json
   - Action: add test
   - Given: Worktree dir with both `state.json` and `attempt-log.jsonl`.
   - When: Both are read/written.
   - Then: Operations on one do not affect the other.
   - Notes: Write state.json using existing `writeWorktreeRunState`, write attempt log using `writeAttemptLog`, then read both back.

   ```ts
   it("does not interfere with worktree-run-state.json", () => {
     const dir = mkdtempSync(join(tmpdir(), "attempt-state-test-"));
     try {
       writeWorktreeRunState(dir, { issueNumber: 1, targetName: "test", branchName: "test", baseBranch: "main", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedStages: {}, review: { lifetimeIterations: 0 } });
       writeAttemptLog(dir, { attemptType: "stage", fingerprint: "test:fail", stage: "baseRefresh", outcome: "failure", timestamp: new Date().toISOString() });

       const state = readWorktreeRunState(dir);
       expect(state).not.toBeNull();
       expect(state!.issueNumber).toBe(1);

       const log = readAttemptLog(dir);
       expect(log).toHaveLength(1);
     } finally {
       rmSync(dir, { recursive: true, force: true });
     }
   });
   ```
   - Constraints: Must import from existing worktree-run-state module, not duplicate its behavior.

## Contracts / interfaces

```ts
export type AttemptLogEntryType = "stage" | "recovery";
export type AttemptOutcome = "success" | "failure" | "handoff";

export interface AttemptLogEntryBase {
  readonly attemptType: AttemptLogEntryType;
  readonly fingerprint: string;
  readonly timestamp: string;
  readonly stage: string;
  readonly outcome: AttemptOutcome;
}

export interface StageAttemptEntry extends AttemptLogEntryBase {
  readonly attemptType: "stage";
}

export interface RecoveryAttemptEntry extends AttemptLogEntryBase {
  readonly attemptType: "recovery";
  readonly artifactRef?: string;
  readonly decision?: string;
}

export type AttemptLogEntry = StageAttemptEntry | RecoveryAttemptEntry;

export interface RecoveryBudget {
  readonly used: number;
  readonly remaining: number;
  readonly exhausted: boolean;
}

export const ATTEMPT_LOG_PATH = ".pourkit/attempt-log.jsonl";

export function writeAttemptLog(worktreePath: string, entry: AttemptLogEntry): void;
export function readAttemptLog(worktreePath: string): AttemptLogEntry[];
export function recoveryBudgetForFailure(worktreePath: string, fingerprint: string, maxAttempts: number): RecoveryBudget;
export function computeFailureFingerprint(stage: string, failureType: string): string;
```

## Edge cases

- File does not exist yet: `readAttemptLog` returns `[]`, `writeAttemptLog` creates it.
- Corrupted/invalid JSON lines in log: skip silently, continue parsing remaining lines.
- Empty Worktree path: throws from fs operations (acceptable — caller must provide valid path).

## Validation

- New behavior test: append entries, read them back in order.
- Regression contract test: no interference with `.pourkit/state.json`.
- Recovery budget test: correct counting for used/remaining/exhausted states.
- No-nested-recovery test: recovery failures don't create new stage-level fingerprint groups.

## Out of scope

- Log rotation or pruning — flagged as out-of-scope in PRD-037.
- Migration of existing `lastFailure` data into Attempt Log — fresh start.

## Priority

infra

## Acceptance criteria

- [ ] `writeAttemptLog` appends a JSONL entry to `.pourkit/attempt-log.jsonl`.
- [ ] `readAttemptLog` returns all entries in append order, skipping unparseable lines.
- [ ] `recoveryBudgetForFailure` correctly counts recovery attempts per fingerprint and returns used/remaining/exhausted.
- [ ] `computeFailureFingerprint` produces deterministic fingerprints.
- [ ] Recovery attempt entries do not create new stage-level fingerprints (no nested recovery).
- [ ] Attempt Log does not interfere with existing `.pourkit/state.json`.

## Blocked by

- None — can start immediately.
