# PRD-001 / I-02: Add failure resolution domain and Attempt Log

## Parent

PRD-001: Base Refresh + Failure Resolution Agent

## Source of truth for behavior

Explicit new contract, DEC-0005 through DEC-0020, DEC-0028, context glossary.

## What to build

Add the typed failure-resolution domain contracts and append-only Attempt Log that the Base Refresh recovery path will use.

## Affected code paths

- pourkit/failure-resolution/domain.ts [inferred]
  - Class/Module: StageAttempt, StageFailure, RecoveryAttempt, RecoveryDecision, FailureResolutionPacket, RecoveryArtifact
  - Functions/Methods: buildFailureResolutionPacket(...), getAllowedRecoveryDecisions(...)
  - New: Yes
- pourkit/failure-resolution/recovery-artifact.ts [inferred]
  - Class/Module: RecoveryArtifact parser
  - Functions/Methods: parseRecoveryArtifact(...)
  - New: Yes
- pourkit/failure-resolution/attempt-log.ts [inferred]
  - Class/Module: Attempt Log writer/reader
  - Functions/Methods: appendAttemptLogEntry(...), readAttemptLog(...), countRecoveryAttemptsForFingerprint(...)
  - New: Yes
- pourkit/failure-resolution/*.test.ts [inferred]
  - Class/Module: failure-resolution tests
  - Functions/Methods: domain, artifact, and Attempt Log tests
  - New: Yes

## Current behavior

- Base Refresh returns status-shaped results, not Stage Attempt or StageFailure records.
- Conflict Resolution Agent artifacts use the legacy conflict-resolution artifact protocol.
- There is no append-only Attempt Log for original stage failures and recovery attempts.

## Desired behavior

- Failure-resolution domain exposes typed StageFailure, RecoveryDecision, FailureResolutionPacket, and RecoveryArtifact contracts.
- RecoveryArtifact parser accepts markdown with one fenced JSON block and rejects malformed, missing, unsupported, or ambiguous artifacts.
- Attempt Log appends JSONL entries and can count recovery attempts by original failure fingerprint.

## Contract decisions

- Decision: Stage Attempt is the fundamental recovery unit.
- Source of truth: DEC-0005
- Decision: Recovery Attempt attaches to the failed Stage Attempt.
- Source of truth: DEC-0006
- Decision: Attempt Log is append-only Worktree metadata, not temporary agent artifact state.
- Source of truth: DEC-0017 / DEC-0018
- Decision: Recovery failures consume budget for the original failure fingerprint.
- Source of truth: DEC-0019 / DEC-0020
- Decision: Failure Resolution Agent failure is recorded as a Recovery Attempt failure attached to the original Stage Attempt.
- Source of truth: DEC-0028

## Regression contract (CRITICAL)

- Existing behavior:
  - What currently works: Worktree Run State remains readable when `.pourkit/state.json` exists and valid.
  - Why it is at risk: Attempt Log introduces adjacent runner-owned Worktree metadata.
  - Test that protects it: Existing Worktree Run State read/write tests or issue resume tests must continue reading `.pourkit/state.json` without requiring Attempt Log.
  - Must not change: `.pourkit/state.json` path and shape.
- Existing behavior:
  - What currently works: Legacy conflict-resolution artifact parser is scoped to conflict-resolution tests.
  - Why it is at risk: New RecoveryArtifact parser could be conflated with legacy parser behavior.
  - Test that protects it: Existing conflict-resolution artifact tests must continue to pass until the legacy module is removed by the integration issue.
  - Must not change: Legacy parser expectations inside unchanged conflict-resolution tests.

## Step-by-step implementation

1. pourkit/failure-resolution/recovery-artifact.test.ts / "parses RecoveryArtifact markdown JSON block"
   - Action: add test
   - Given: Markdown contains one fenced `json` block with required RecoveryArtifact fields.
   - When: `parseRecoveryArtifact(...)` runs.
   - Then: it returns a typed artifact with `recoveryDecision`, `summary`, `changedFiles`, and `verification`.
   - Notes: Include narrative markdown before or after the fenced block.
   - Constraints: Do not parse arbitrary prose as structured data.
   ```ts
   expect(result.recoveryDecision).toBe("RETRY_STAGE");
   expect(result.changedFiles).toEqual(["src/file.ts"]);
   ```
2. pourkit/failure-resolution/recovery-artifact.test.ts / "rejects malformed RecoveryArtifact markdown"
   - Action: add test
   - Given: Markdown has no JSON block, malformed JSON, multiple JSON blocks, or unsupported decisions.
   - When: `parseRecoveryArtifact(...)` runs.
   - Then: it throws a protocol error that callers can convert to `RecoveryArtifactInvalid`.
   - Notes: Use table tests for failure modes.
   - Constraints: Do not silently accept `RESUME_FROM_STAGE` or `MARK_STAGE_COMPLETE` as executable decisions.
   ```ts
   expect(() => parseRecoveryArtifact(markdown)).toThrow("RecoveryArtifact");
   ```
3. pourkit/failure-resolution/attempt-log.test.ts / "appends Attempt Log entries"
   - Action: add test
   - Given: An empty Worktree metadata directory.
   - When: `appendAttemptLogEntry(...)` records a stage failure and recovery failure.
   - Then: the Attempt Log contains two JSONL entries in append order.
   - Notes: Assert JSONL append semantics, not pretty-printed JSON.
   - Constraints: Do not write inside `.pourkit/.tmp`.
   ```ts
   expect(lines).toHaveLength(2);
   expect(JSON.parse(lines[0])).toMatchObject({ attemptType: "stage" });
   ```
4. pourkit/failure-resolution/attempt-log.test.ts / "counts recovery budget by original failure fingerprint"
   - Action: add test
   - Given: Attempt Log contains recovery entries for two different original fingerprints.
   - When: `countRecoveryAttemptsForFingerprint(...)` runs.
   - Then: only recovery attempts attached to the requested fingerprint are counted.
   - Notes: Include a stage-failure entry for the same fingerprint that does not count as recovery budget.
   - Constraints: Do not count unrelated fingerprints.
   ```ts
   expect(countRecoveryAttemptsForFingerprint(entries, "fp-a")).toBe(2);
   ```
5. pourkit/failure-resolution/domain.ts / StageFailure and RecoveryDecision
   - Action: add
   - Given: Control-plane code needs first-slice typed failures.
   - When: modules import the domain.
   - Then: StageFailure and RecoveryDecision unions match the PRD contract.
   - Notes: Include helper for unsupported executable decisions that route to Human Handoff.
   - Constraints: Do not add broader taxonomy values in this slice.
6. pourkit/failure-resolution/domain.ts / FailureResolutionPacket
   - Action: add
   - Given: Recovery dispatch needs structured context.
   - When: `buildFailureResolutionPacket(...)` receives a StageFailure and policy limits.
   - Then: packet includes failure type, stage, attempt number, Worktree path, details, policy limits, allowed decisions, and artifact path.
   - Notes: Use a schema-based runtime validator matching the repository's current validation approach or Effect Schema if introduced by this slice.
   - Constraints: Do not produce loose prompt-only context.
7. pourkit/failure-resolution/recovery-artifact.ts / parseRecoveryArtifact(...)
   - Action: add
   - Given: Agent wrote markdown artifact.
   - When: parser reads artifact content.
   - Then: exactly one fenced JSON block is parsed and schema-validated.
   - Notes: Throw a typed protocol error for invalid artifacts.
   - Constraints: Do not accept multiple JSON blocks.
8. pourkit/failure-resolution/attempt-log.ts / appendAttemptLogEntry(...)
   - Action: add
   - Given: Worktree path and Attempt Log entry.
   - When: writer appends.
   - Then: parent directory is created and one compact JSON line is appended.
   - Notes: Include timestamp, attempt type, stage, original fingerprint, outcome, and summary/message.
   - Constraints: Do not mutate Worktree Run State.

## Contracts / interfaces

```ts
export type StageFailureType =
  | "RebaseConflict"
  | "PublishedHistoryRisk"
  | "RecoveryArtifactInvalid"
  | "FailureResolutionAgentFailed";

export type RecoveryDecision =
  | "RETRY_STAGE"
  | "RESUME_FROM_STAGE"
  | "MARK_STAGE_COMPLETE"
  | "HANDOFF_TO_HUMAN"
  | "FAIL_RUN";

export interface FailureResolutionPacket {
  failureType: StageFailureType;
  stage: "baseRefresh";
  attemptNumber: number;
  worktreePath: string;
  failureSummary: string;
  failureDetails: Record<string, unknown>;
  policyLimits: {
    maxAttemptsPerFailure: number;
    attemptsUsed: number;
    attemptsRemaining: number;
  };
  allowedDecisions: RecoveryDecision[];
  artifactPath: string;
}

export interface RecoveryArtifact {
  recoveryDecision: RecoveryDecision;
  summary: string;
  changedFiles: string[];
  verification: string[];
  notes?: string;
}

export type AttemptLogEntry =
  | {
      attemptType: "stage";
      stage: "baseRefresh";
      fingerprint: string;
      outcome: "failure";
      failureType: StageFailureType;
      timestamp: string;
      summary: string;
    }
  | {
      attemptType: "recovery";
      stage: "baseRefresh";
      originalFingerprint: string;
      outcome: "success" | "failure";
      failureType?: StageFailureType;
      timestamp: string;
      summary: string;
    };
```

## Edge cases

- Empty or whitespace artifact content rejects as invalid RecoveryArtifact.
- Unknown Attempt Log lines are not invented; malformed JSONL should fail clearly when read.
- Unsupported decisions parse but are not considered executable in this first slice.

## Validation

- New behavior test: domain, artifact parser, packet validator, and Attempt Log tests pass.
- Regression contract test: Worktree Run State read/write behavior remains independent of Attempt Log.
- Existing command that should still pass: conflict-resolution artifact tests until legacy integration is removed.
- Manual/example verification: inspect one Attempt Log line for compact JSONL shape.

## Out of scope

- Do not wire domain into Base Refresh execution in this issue.
- Do not replace `runConflictResolutionLoop(...)` in this issue.
- Do not add broader StageFailure taxonomy.

## Priority

feature

## Acceptance criteria

- [ ] First-slice StageFailure and RecoveryDecision contracts are available from a failure-resolution domain module.
- [ ] RecoveryArtifact parser accepts one valid markdown JSON block and rejects invalid artifacts.
- [ ] Attempt Log appends stage and recovery entries as JSONL and counts recovery attempts by original fingerprint.
- [ ] Existing Worktree Run State behavior remains independent of Attempt Log.

## Blocked by

None — can start immediately.
